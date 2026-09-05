/**
 * CONTINUAL REFINEMENT — the trajectory refiner, end to end over the real
 * owners.
 *
 * The capability under test: a refinement request reviews a trajectory, a
 * read-only temporary agent proposes the smallest typed edits, and each edit is
 * routed to the authority that ALREADY owns that artifact. Nothing here owns a
 * prompt, a fact, a skill or an agent — the request row holds the request and
 * the routing identities, and every artifact stays in its own store.
 *
 * Every test enters through the two shipped entry points — `requestRefinement`
 * and `advanceRefinementLane` — over the production `ScaffoldControl` seam, the
 * production `FactsStore`, the production section store, and the production
 * instruction-trust authority. Every outbound model call is scripted, so the
 * pass is deterministic and nothing reaches a network.
 *
 * What the file is really asserting, in one sentence each:
 *   • an LLM proposal never moves live behaviour by itself;
 *   • the only writes are into stores that already existed;
 *   • a crash or a duplicate delivery cannot double-apply or double-open;
 *   • an authority that cannot be written to is REFUSED by name, not mirrored.
 */

import { describe, expect, test } from 'bun:test';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';

import {
  activePromptSectionOverrides, advancePromptSectionLane, buildSystemPromptSync,
  createFactsStore, findPromptSectionTarget, recordTurnOutcome,
  type FactsStore, type ScaffoldControl,
} from '../src/index';
import { initAllTables } from '../src/identity/schema';
import { EvolutionEngine } from '../src/evolution/engine';
import { buildOutcomeEvalSplit } from '../src/evolution/eval-split';
import { initTurnOutcomeTables } from '../src/evolution/outcomes';
import { buildChangelog } from '../src/evolution/changelog';
import { initGepaTables } from '../src/evolution/gepa/persistence';
import { initPromptSectionTables, listPromptSectionVersions } from '../src/prompting/section-store';
import {
  InstructionApprovalStore, initInstructionApprovalsTable, instructionDigest,
} from '../src/safety/instruction-trust';
import { trustedActiveSkills, unionAllowedTools } from '../src/skills/render';
import { discoverSkills, skillPath } from '../src/skills/discover';
import { skillsVfsOver } from '../src/orchestrator/turn-surface';
import { SKILLS_DIR } from '../src/skills/types';
import { gatherApprovableInstructions } from '../src/read-models/instruction-approvals';
import type { ActiveSkill, ActiveSkillSet } from '../src/skills/types';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type {
  TemporaryAgentPort, TemporaryRunOutcome, TemporaryRunRequest,
} from '../src/subordinates/temporary';
import {
  RefinementProposalSchema,
  createRefinementStore, evolutionDebt, initRefinementTables, refinementStagingPath,
  type RefinementDeps, type RefinementEdit, type RefinementProposal, type RefinementRoute,
} from '../src/evolution/refinement';

/**
 * The failure count a refinement opens at.
 *
 * A literal here, not an import: the threshold is module-private, and its one
 * public statement is the `summary` sentence below — which this file asserts
 * names exactly this number, so the two cannot drift apart silently.
 */
const MIN_REFINEMENT_DEBT = 3;
import {
  advanceRefinementLane, refinementDebtRequest, requestRefinement,
} from '../src/evolution/refinement-lane';
import {
  decideRefinementRoute, showRefinementRoute,
} from '../src/evolution/refinement-skill';
import { createTestSql } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';

const EVAL_SIZE = 8;
const TARGET_ID = 'state/output-format';

const target = findPromptSectionTarget(TARGET_ID);
if (!target) throw new Error(`${TARGET_ID} is not registered`);
const INCUMBENT = target.source;
/** Byte-for-byte the incumbent's size, so the anti-bloat size rule is never
 *  what a test in this file is measuring — it has its own suite. */
const CANDIDATE = `${INCUMBENT.slice(0, -6)}ASKED.`;

const config: ScaffoldControl['config'] = {
  getShadowSampleRate: () => 1,
  getAutoPromoteScaffold: () => false,
  getGepaEvalBudget: () => EVAL_SIZE,
};

function promptText(prompt: LanguageModelV3Prompt): string {
  const text: string[] = [];
  for (const message of prompt) {
    if (!Array.isArray(message.content)) { text.push(message.content); continue; }
    for (const part of message.content) if (part.type === 'text') text.push(part.text);
  }
  return text.join('\n');
}

/**
 * A control plane that scores deterministically and REFUSES to roll out.
 *
 * `surface` throws on purpose: a refinement pass that ever ran a scaffold would
 * be paying a whole turn to answer a counterfactual about prose, and this is
 * the assertion that says so.
 */
function scriptedControl(rt: AgentRuntime, score: (candidate: string) => number): ScaffoldControl {
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 7, text: 7, reasoning: undefined },
  };
  return {
    rt,
    sql: rt.storage.sql,
    config,
    surface: () => { throw new Error('a refinement pass must not roll out a scaffold'); },
    model: () => new MockLanguageModelV3({
      provider: 'fake',
      modelId: 'fake-reflection',
      doGenerate: async (options) => ({
        content: [{ type: 'text' as const, text: promptText(options.prompt).slice(0, 8) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage,
        warnings: [],
      }),
    }),
    judge: async ({ prompt, schema }) => v.parse(schema, {
      score: score(prompt.includes(CANDIDATE) ? CANDIDATE : INCUMBENT),
      feedback: 'the wording decides it',
    }),
  };
}

/** A refiner that answers with exactly this proposal, and records every brief
 *  it was handed so the tests can assert what the refiner was allowed to see. */
function scriptedRefiner(answer: string | ((request: TemporaryRunRequest) => string)) {
  const answerOf = answer instanceof Function ? answer : () => answer;
  const requests: TemporaryRunRequest[] = [];
  return {
    requests,
    port: {
      run: async (request: TemporaryRunRequest) => {
        requests.push(request);
        const outcome: TemporaryRunOutcome = {
          status: 'completed',
          agent: 'refiner-1',
          lifetime: 'task',
          role: 'general',
          answer: answerOf(request),
          transcript: 'kept',
          elapsed_ms: 1,
        };
        return outcome;
      },
      settle: () => false,
    },
  };
}

function proposalText(proposal: RefinementProposal): string {
  return `Here is my proposal.\n\n${JSON.stringify(proposal)}`;
}

/**
 * A refiner the TEST releases, so a pass can be held open inside its child
 * agent while something else reaches the same request.
 *
 * Only the first ask waits. That is the pass under test — the one still running
 * when a second delivery arrives or when recovery re-queues its claim — and a
 * later ask has to be able to finish, or the successor could never be observed.
 *
 * One answer per ask, in order, and the last one repeats. A re-asked refiner is
 * free to answer differently (it is a model), so giving the two passes different
 * proposals is what makes a second set of owner writes VISIBLE instead of hiding
 * inside the owners' own idempotence.
 */
function deferredRefiner(...answers: readonly RefinementProposal[]) {
  let asks = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return {
    asks: () => asks,
    release: () => { open(); },
    port: {
      run: async () => {
        asks += 1;
        // Bound BEFORE the wait: the held pass answers what IT was asked, not
        // whatever the counter reached while it was parked.
        const mine = Math.min(asks, answers.length) - 1;
        if (asks === 1) await gate;
        const answer = answers[mine]!;
        const outcome: TemporaryRunOutcome = {
          status: 'completed', agent: 'refiner-1', lifetime: 'task', role: 'general',
          answer: proposalText(answer), transcript: 'kept', elapsed_ms: 1,
        };
        return outcome;
      },
      settle: () => false,
    },
  };
}

interface Fixture {
  rt: AgentRuntime;
  facts: FactsStore;
  approvals: InstructionApprovalStore;
  deps(refiner: TemporaryAgentPort, score?: (candidate: string) => number): RefinementDeps;
}

function fixture(): Fixture {
  const { rt } = createTestRuntime();
  initAllTables(rt.storage.execRaw, rt.storage.sql);
  initTurnOutcomeTables(rt.storage.execRaw);
  initGepaTables(rt.storage.execRaw);
  initPromptSectionTables(rt.storage.execRaw);
  initInstructionApprovalsTable(rt.storage.execRaw);
  initRefinementTables(rt.storage.execRaw);
  const facts = createFactsStore(rt.storage.sql);
  const approvals = new InstructionApprovalStore(
    rt.storage.sql, 'test-workspace', (body) => body(),
  );
  return {
    rt,
    facts,
    approvals,
    deps: (refiner, score = (candidate) => (candidate === CANDIDATE ? 0.9 : 0.4)) => ({
      control: scriptedControl(rt, score),
      facts,
      refiner,
      approvals,
    }),
  };
}

/**
 * The negative + accepted turns the eval split needs to support an out-of-sample
 * selection.
 *
 * Turn ids are unique across calls on purpose: `listTurnOutcomes` resolves ONE
 * effective verdict per turn id, so re-seeding the same id would overwrite the
 * earlier failure instead of accruing a new one — which is precisely what debt
 * accumulation is about.
 *
 * Timestamps are distinct for the same reason. The ledger orders by
 * `created_at` and breaks ties on a random row id, so twenty rows written inside
 * one millisecond have no defined order — real turns are seconds apart, and a
 * fixture that pretends otherwise tests the tie-break instead of the rule.
 */
/** Distinct, ordered, and far enough from zero to read as a real clock. */
const SEED_EPOCH = 1_700_000_000_000;
let seeded = 0;
function seedGradedTurns(rt: AgentRuntime, negatives: number, accepted = 2) {
  const seededNegatives: string[] = [];
  const seededAccepted: string[] = [];
  for (let i = 0; i < negatives; i += 1) {
    const turnId = `neg-${String((seeded += 1))}`;
    recordTurnOutcome(rt.storage.sql, {
      turnId,
      sessionId: 'session-1',
      outcome: 'corrected',
      confidence: 0.9,
      source: 'classifier',
      userMessage: `fix ${turnId}. always answer in one line.`,
      assistantResponse: 'a long rambling answer',
      followup: 'no, shorter please',
      evidence: 'the user re-asked for brevity',
      now: SEED_EPOCH + seeded,
    });
    seededNegatives.push(turnId);
  }
  for (let i = 0; i < accepted; i += 1) {
    const turnId = `ok-${String((seeded += 1))}`;
    recordTurnOutcome(rt.storage.sql, {
      turnId,
      sessionId: 'session-1',
      outcome: 'accepted',
      confidence: 0.9,
      source: 'classifier',
      userMessage: `fine task ${turnId}`,
      assistantResponse: 'done',
      followup: 'thanks',
      now: SEED_EPOCH + seeded,
    });
    seededAccepted.push(turnId);
  }
  return { negatives: seededNegatives, accepted: seededAccepted };
}

function routeFor(routes: readonly RefinementRoute[], kind: RefinementRoute['kind']): RefinementRoute {
  const route = routes.find((candidate) => candidate.kind === kind);
  if (!route) throw new Error(`no ${kind} route in ${JSON.stringify(routes)}`);
  return route;
}

function activeSkill(name: string, trust: ActiveSkill['trust'], allowed: string[]): ActiveSkill {
  const body = 'do the thing';
  return {
    name,
    description: `the ${name} skill`,
    allowed_tools: allowed,
    keywords: [],
    auto_activate: false,
    disable_model_invocation: false,
    user_invocable: true,
    ext: {},
    source: trust === 'builtin' ? 'builtin' : 'vfs',
    bodyRef: { kind: 'file', path: `/workspace/skills/${name}.md`, chars: body.length },
    body,
    trust,
  };
}

/** A valid skill file, and the ONE canonical path its own name resolves to. */
const BREVITY_SKILL =
  '---\nname: brevity\ndescription: answer briefly\nallowed_tools: [read]\n---\nBe brief.';
const BREVITY_PATH = skillPath('brevity');
/** A file whose name collides with a shipped built-in. */
const BUILTIN_CLASH =
  '---\nname: audit-implementation\ndescription: not the real one\n---\nMine now.';

/** The user preference every crash-recovery case re-drives. */
const FACT_EDIT: Extract<RefinementEdit, { kind: 'fact' }> = {
  kind: 'fact',
  key: 'user.answer_length',
  value: 'one line',
  quote: 'always answer in one line',
  rationale: 'the user stated this in their own words and re-asked when it was ignored',
};

const FACT_PROPOSAL: RefinementProposal = {
  scope: 'workspace',
  summary: 'one preference',
  edits: [FACT_EDIT],
};

function skillProposal(source: string, path = BREVITY_PATH): RefinementProposal {
  return {
    scope: 'workspace',
    summary: 'a brevity skill',
    edits: [{
      kind: 'skill',
      path,
      source,
      rationale: 'the same brevity correction recurred across three graded turns in this session',
    }],
  };
}

/**
 * One edit per writable authority — the memory store, the section store and the
 * owner's instruction trust.
 *
 * The shape every "did this pass run twice?" case needs: a duplicated pass shows
 * up in three different owners rather than in one, and the two that are not
 * keyed (a section version, staged bytes) are where a second write would be
 * visible at all.
 */
function everyOwnerProposal(
  fact: Extract<RefinementEdit, { kind: 'fact' }>,
  section: string,
  skill: string,
): RefinementProposal {
  return {
    scope: 'workspace',
    summary: 'a preference, a section and a skill',
    edits: [
      fact,
      {
        kind: 'prompt_section',
        sectionId: TARGET_ID,
        source: section,
        rationale: 'four corrected turns all asked for a shorter answer than the section invites',
      },
      skillProposal(skill).edits[0]!,
    ],
  };
}

const EVERY_OWNER_PROPOSAL = everyOwnerProposal(FACT_EDIT, CANDIDATE, BREVITY_SKILL);
/** The same three owners, DIFFERENT bytes in each — the answer a re-asked
 *  refiner is free to give, and the only way a second pass's writes can be told
 *  apart from the first pass's. */
const OTHER_OWNER_PROPOSAL = everyOwnerProposal(
  { ...FACT_EDIT, key: 'user.answer_shape' },
  `${INCUMBENT.slice(0, -6)}BRIEF.`,
  `${BREVITY_SKILL}\nName the ask.`,
);

/** What is actually on the workspace file plane, or null when nothing is. */
async function readSkill(rt: AgentRuntime, path: string): Promise<string | null> {
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  if (!await vfs.exists(path)) return null;
  const read = await vfs.readFile(path, { encoding: 'utf8' });
  return read instanceof Uint8Array ? new TextDecoder().decode(read) : read;
}

async function writeSkill(rt: AgentRuntime, path: string, source: string): Promise<void> {
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  await vfs.mkdir(SKILLS_DIR, { recursive: true });
  await vfs.writeFile(path, source);
}

/** What the PROMPT would see: exactly what `discoverSkills` finds under
 *  SKILLS_DIR. The assertion that a staged proposal influences nothing. */
async function discoveredSkillNames(rt: AgentRuntime): Promise<string[]> {
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  const discovery = await discoverSkills(skillsVfsOver(vfs), { admissionTokens: 100_000 });
  return discovery.skills.filter((skill) => skill.bodyRef.kind === 'file').map((skill) => skill.name);
}

/** What the OWNER's approval surface would list — the other reader that a
 *  SKILLS_DIR write would have reached. */
async function gatheredSkillPaths(rt: AgentRuntime): Promise<string[]> {
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  const sources = await gatherApprovableInstructions({
    skillsVfs: skillsVfsOver(vfs),
    admissionTokens: 100_000,
  });
  return sources.filter((source) => source.kind === 'skill').map((source) => source.path);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('refinement request — durable, and behaviourally inert', () => {
  test('an explicit request returns a durable row at `requested` and changes nothing', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('{}');

    const before = activePromptSectionOverrides(fx.rt.storage.sql);
    const opened = await requestRefinement(fx.deps(port), {
      trigger: 'explicit', scope: 'workspace', sessionId: 'session-1',
    });

    expect(opened.stage).toBe('requested');
    expect(opened.id).toMatch(/^refine-/);
    expect(opened.turnIds.length).toBeGreaterThan(0);
    // The request is a request. No artifact moved, and no model was called.
    expect(activePromptSectionOverrides(fx.rt.storage.sql)).toEqual(before);
    expect(fx.facts.all()).toEqual([]);

    const store = createRefinementStore(fx.rt.storage.sql);
    expect(store.get(opened.id)?.stage).toBe('requested');
  });

  test('the request captures the trajectory BY REFERENCE — turn ids, not copies', async () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('{}');

    const opened = await requestRefinement(fx.deps(port), {
      trigger: 'explicit', scope: 'workspace', sessionId: 'session-1',
    });
    for (const id of negatives) expect(opened.turnIds).toContain(id);
  });

  test('an explicit request with no graded trajectory is refused, not opened empty', async () => {
    const fx = fixture();
    const { port } = scriptedRefiner('{}');

    const opened = await requestRefinement(fx.deps(port), {
      trigger: 'explicit', scope: 'workspace',
    });
    expect(opened.stage).toBe('refused');
    expect(opened.detail).toContain('no outcome-labeled turns');
  });
});

describe('the refiner — bounded references, prior history, strict typed answer', () => {
  test('the brief carries the trajectory, the artifact inventory and prior outcomes', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    fx.facts.upsert('user.tz', 'Europe/Berlin');
    const { port, requests } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'nothing to change', edits: [],
    }));
    const deps = fx.deps(port);

    const first = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(requests).toHaveLength(1);
    const brief = requests[0]!.task;

    // The trajectory it must review.
    expect(brief).toContain('always answer in one line');
    expect(brief).toContain('no, shorter please');
    // The artifacts it may address, by owner id.
    expect(brief).toContain(TARGET_ID);
    expect(brief).toContain('user.tz');
    // The schema it must answer in.
    expect(brief).toContain('prompt_section');
    expect(brief).toContain('subagent_spec');

    // A second request over LATER failures is told what the first one did —
    // refinement is cumulative or it is a treadmill. (Later failures, because
    // the turns a request already took stop counting as debt.)
    seedGradedTurns(fx.rt, 3);
    const { port: second, requests: secondRequests } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'still nothing', edits: [],
    }));
    const secondDeps = fx.deps(second);
    await requestRefinement(secondDeps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(secondDeps);
    expect(secondRequests[0]!.task).toContain(first.id);
  });

  test('the refiner reads context refs itself — only the files this workspace has, at their real paths', async () => {
    // PRODUCTION, 2026-09-03 (hardy-stone-a905df14): every automatic refinement
    // was refused before the refiner started, because the lane named `MEMORY.md`
    // at the root (genesis writes `memory/MEMORY.md`) and `AGENTS.md` in a
    // workspace that had none, and the temporary-agent port refuses an absent
    // path by name. The scripted refiner here never ran that port, which is how
    // a test asserting the string `AGENTS.md` stayed green over a lane that
    // could not run.
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    await fx.rt.storage.vfs.mkdir('memory', { recursive: true });
    await fx.rt.storage.vfs.writeFile('memory/MEMORY.md', '# memory\n');
    const { port, requests } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    }));
    const deps = fx.deps(port);
    await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    expect(requests[0]!.contextRefs).toEqual(['memory/MEMORY.md']);
    expect(requests[0]!.mode).toBe('plan');

    // With an AGENTS.md in place it is offered too; nothing absent ever is.
    const withAgentsMd = fixture();
    seedGradedTurns(withAgentsMd.rt, 3);
    await withAgentsMd.rt.storage.vfs.mkdir('memory', { recursive: true });
    await withAgentsMd.rt.storage.vfs.writeFile('memory/MEMORY.md', '# memory\n');
    await withAgentsMd.rt.storage.vfs.writeFile('AGENTS.md', '# project\n');
    const second = scriptedRefiner(proposalText({ scope: 'workspace', summary: 'none', edits: [] }));
    const secondDeps = withAgentsMd.deps(second.port);
    await requestRefinement(secondDeps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(secondDeps);
    expect(second.requests[0]!.contextRefs).toEqual(['memory/MEMORY.md', 'AGENTS.md']);
  });

  test('an unparsable or off-schema answer refuses the request — it never half-applies', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('I could not decide. No JSON here.');
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const step = await advanceRefinementLane(deps);

    expect(step.step).toBe('planned');
    const store = createRefinementStore(fx.rt.storage.sql);
    const row = store.get(opened.id);
    expect(row?.stage).toBe('refused');
    expect(row?.detail).toContain('proposal');
    expect(fx.facts.all()).toEqual([]);
  });

  test('a refusal before the child exists refuses the request and keeps it recoverable', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps: RefinementDeps = {
      ...fx.deps(scriptedRefiner('{}').port),
      refiner: {
        run: async () => ({ reason: 'unavailable', error: 'no roster substrate here' }),
        settle: () => false,
      },
    };

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const row = createRefinementStore(fx.rt.storage.sql).get(opened.id);
    expect(row?.stage).toBe('refused');
    expect(row?.detail).toContain('no roster substrate here');
  });

  test('a host with no refiner leaves the request `requested` for a host that has one', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps: RefinementDeps = { ...fx.deps(scriptedRefiner('{}').port), refiner: undefined };

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const step = await advanceRefinementLane(deps);
    expect(step.step).toBe('idle');
    expect(createRefinementStore(fx.rt.storage.sql).get(opened.id)?.stage).toBe('requested');
  });
});

describe('routing — every typed edit lands in the store that already owns it', () => {
  test('an explicit user preference reaches the memory authority immediately', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'the user asked for one-line answers',
      edits: [{
        kind: 'fact',
        key: 'user.answer_length',
        value: 'one line',
        quote: 'always answer in one line',
        rationale: 'the user stated this in their own words and re-asked when it was ignored',
      }],
    }));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    // The ONE memory authority holds it — no second fact store anywhere.
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(fx.facts.recall('user.answer_length')?.source).toContain(opened.id);

    const row = createRefinementStore(fx.rt.storage.sql).get(opened.id);
    const route = routeFor(row!.routes, 'fact');
    expect(route.disposition).toBe('applied');
    expect(route.owner).toBe('agent_facts');
    expect(route.target).toBe('user.answer_length');
  });

  test('a fact the user never said is refused — the quote must be in the trajectory', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'inferred preference',
      edits: [{
        kind: 'fact',
        key: 'user.prefers_rust',
        value: true,
        quote: 'I want everything rewritten in Rust',
        rationale: 'it seemed implied by the general tone of the conversation',
      }],
    }));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    expect(fx.facts.recall('user.prefers_rust')).toBeNull();
    const route = routeFor(
      createRefinementStore(fx.rt.storage.sql).get(opened.id)!.routes, 'fact',
    );
    expect(route.disposition).toBe('refused');
    expect(route.reason).toContain('not quoted');
  });

  test('a prompt-section edit lands PENDING and the live prompt does not move', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'tighten the output-format section',
      edits: [{
        kind: 'prompt_section',
        sectionId: TARGET_ID,
        source: CANDIDATE,
        rationale: 'three corrected turns all asked for a shorter answer than the section invites',
      }],
    }));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const store = createRefinementStore(fx.rt.storage.sql);
    const row = store.get(opened.id)!;
    const route = routeFor(row.routes, 'prompt_section');
    expect(route.disposition).toBe('pending_trials');
    expect(route.owner).toBe('prompt_section_versions');
    expect(route.target).toBe(`${TARGET_ID}:1`);
    expect(row.stage).toBe('evaluating');

    // THE LOAD-BEARING ASSERTION: the live prompt is untouched.
    expect(activePromptSectionOverrides(fx.rt.storage.sql)[TARGET_ID]).toBeUndefined();
    expect(buildSystemPromptSync(fx.rt, {
      sectionOverrides: activePromptSectionOverrides(fx.rt.storage.sql),
    })).not.toContain('ASKED.');
  });

  test('a section proposal needs measured behavioural evidence — degeneracy refuses it', async () => {
    const fx = fixture();
    // Accepted turns only: nothing failed, so there is no failure to optimise
    // toward and no honest score to propose against.
    const { accepted } = seedGradedTurns(fx.rt, 0, 3);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'a hunch',
      edits: [{
        kind: 'prompt_section',
        sectionId: TARGET_ID,
        source: CANDIDATE,
        rationale: 'I think this wording reads better than the incumbent does today',
      }],
    }));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, {
      trigger: 'explicit', scope: 'workspace', turnIds: accepted,
    });
    await advanceRefinementLane(deps);

    const row = createRefinementStore(fx.rt.storage.sql).get(opened.id)!;
    const route = routeFor(row.routes, 'prompt_section');
    expect(route.disposition).toBe('refused');
    expect(route.reason).toContain('no corrected/frustrated turns');
    expect(row.stage).toBe('refused');
  });

  test('a skill edit stages OUTSIDE discovery — zero prompt influence before approval', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL)));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const row = createRefinementStore(fx.rt.storage.sql).get(opened.id)!;
    const route = routeFor(row.routes, 'skill');
    expect(route.disposition).toBe('pending_owner_approval');
    expect(route.owner).toBe('instruction_approvals');
    expect(route.target).toBe(BREVITY_PATH);
    // The digest is a FIELD, so settlement compares addresses rather than prose.
    expect(route.digest).toBe(instructionDigest(BREVITY_SKILL));
    expect(row.stage).toBe('evaluating');

    // THE LOAD-BEARING ASSERTION. Nothing under SKILLS_DIR, so `discoverSkills`
    // finds nothing: the proposal reaches neither the skills index nor the
    // unverified reference tier, and the next turn's prompt is untouched.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);
    expect(await gatheredSkillPaths(fx.rt)).toEqual([]);
    // The bytes exist, staged where nothing reads them, and the owner can read
    // them from the request view rather than from the prompt.
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity'))).toBe(BREVITY_SKILL);
    expect(refinementStagingPath(opened.id, 'brevity').startsWith(SKILLS_DIR)).toBe(false);
    // And granting is still entirely the owner's act.
    expect(fx.approvals.list()).toEqual([]);

    // Unverified bytes carry no tool policy, so nothing this refinement wrote
    // can bound a turn's tool surface.
    const set: ActiveSkillSet = {
      active: [
        activeSkill('brevity', 'unverified', ['read']),
        activeSkill('builtin-one', 'builtin', ['bash']),
      ],
      reasons: [],
    };
    expect(trustedActiveSkills(set).map((skill) => skill.name)).toEqual(['builtin-one']);
    expect(unionAllowedTools(trustedActiveSkills(set))).toEqual(['bash']);
  });

  test('a skill edit refuses a non-canonical path, a builtin name, and an unparsable file', async () => {
    for (const [edit, expected] of [
      [{ path: '/workspace/notes/brevity.md', source: BREVITY_SKILL }, 'canonical skill path'],
      [{ path: BREVITY_PATH, source: '---\nname: brevity\n---\nno description' }, 'not a valid skill'],
      [{ path: skillPath('audit-implementation'), source: BUILTIN_CLASH }, 'built-in skill'],
    ] as const) {
      const fx = fixture();
      seedGradedTurns(fx.rt, 3);
      const { port } = scriptedRefiner(proposalText(skillProposal(edit.source, edit.path)));
      const deps = fx.deps(port);
      const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
      await advanceRefinementLane(deps);

      const row = createRefinementStore(fx.rt.storage.sql).get(opened.id)!;
      const route = routeFor(row.routes, 'skill');
      expect(route.disposition).toBe('refused');
      expect(route.reason).toContain(expected);
      // Nothing was written anywhere, on any of the three refusals.
      expect(await readSkill(fx.rt, edit.path)).toBeNull();
    }
  });

  test('an existing final file or a standing decision refuses the proposal', async () => {
    const other = `${BREVITY_SKILL}\nSomebody else wrote this.`;

    // (a) the final path already holds bytes — whoever wrote them.
    const occupied = fixture();
    seedGradedTurns(occupied.rt, 3);
    await writeSkill(occupied.rt, BREVITY_PATH, other);
    const first = occupied.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const a = await requestRefinement(first, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(first);
    const aRoute = routeFor(createRefinementStore(occupied.rt.storage.sql).get(a.id)!.routes, 'skill');
    expect(aRoute.disposition).toBe('refused');
    expect(aRoute.reason).toContain('already exists');
    expect(await readSkill(occupied.rt, BREVITY_PATH)).toBe(other);

    // (b) an APPROVED standing decision, even with no file yet: the owner has
    // already answered about that path and a proposal must not talk over it.
    const decided = fixture();
    seedGradedTurns(decided.rt, 3);
    decided.approvals.approve(BREVITY_PATH, instructionDigest(other));
    const second = decided.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const b = await requestRefinement(second, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(second);
    const bRoute = routeFor(createRefinementStore(decided.rt.storage.sql).get(b.id)!.routes, 'skill');
    expect(bRoute.disposition).toBe('refused');
    expect(bRoute.reason).toContain('standing decision');
    expect(await readSkill(decided.rt, BREVITY_PATH)).toBeNull();
  });

  test('a revoked path is never re-proposed', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    fx.approvals.revoke(BREVITY_PATH);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const route = routeFor(
      createRefinementStore(fx.rt.storage.sql).get(opened.id)!.routes, 'skill',
    );
    expect(route.disposition).toBe('refused');
    expect(route.reason).toContain('revoked');
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('the owner approving the exact digest settles the request as applied', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    // Undecided is not a verdict: the lane keeps waiting, with no clock on the
    // owner.
    expect((await advanceRefinementLane(deps)).step).toBe('idle');
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL));
    expect((await advanceRefinementLane(deps)).step).toBe('settled');
    expect(store.get(opened.id)?.stage).toBe('applied');
  });

  test('an approval of DIFFERENT bytes rolls the request back', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    // The owner edited the file, then approved what they read. The digest moved,
    // so this proposal's bytes are not what is in effect.
    fx.approvals.approve(BREVITY_PATH, instructionDigest(`${BREVITY_SKILL}\nedited.`));
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });

  test('a revocation after the write rolls the request back', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    fx.approvals.revoke(BREVITY_PATH);
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });

  test('a subagent-spec edit is refused by name — there is no writable authority to mirror', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'retune the reviewer role',
      edits: [{
        kind: 'subagent_spec',
        role: 'reviewer',
        spec: 'always answer in one line',
        rationale: 'the reviewer subordinate produced the long answers the user corrected three times',
      }],
    }));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const route = routeFor(
      createRefinementStore(fx.rt.storage.sql).get(opened.id)!.routes, 'subagent_spec',
    );
    expect(route.disposition).toBe('refused');
    expect(route.reason).toContain('no writable');
    expect(route.owner).toBe('');
  });

  test('one request table, owning no artifact, in exactly the shape it ships', () => {
    // A BARE database, so what this init creates is exactly what is measured.
    const bare = createTestSql();
    const tables = () => bare.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.map((row) => row.name);
    const before = new Set(tables());
    initRefinementTables(bare.execRaw);
    const added = tables().filter((name) => !before.has(name));

    expect(added).toEqual(['refinement_requests']);
    // The names that would betray a second authority for an artifact.
    for (const forbidden of ['skill', 'prompt_section', 'fact', 'subordinate', 'agent_config']) {
      expect(added.some((name) => name.includes(forbidden))).toBe(false);
    }
    // The whole row, pinned. `claim` is part of the shipped CREATE rather than
    // something added to a live table afterwards: this row has never been
    // released, so there is no workspace to reconcile a column into.
    expect(bare.sql<{ name: string }>`
      SELECT name FROM pragma_table_info('refinement_requests')`.map((row) => row.name))
      .toEqual([
        'id', 'trigger', 'scope', 'stage', 'claim', 'session_id', 'turn_ids', 'debt_key',
        'proposal', 'routes', 'detail', 'created_at', 'updated_at',
      ]);
    bare.close();
  });

  test('the request row references its trajectory and never copies a turn', () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 3);
    const store = createRefinementStore(fx.rt.storage.sql);
    store.open({ trigger: 'explicit', scope: 'workspace', turnIds: negatives });

    // The row holds ids. The turn text lives in `turn_outcomes` and is not
    // duplicated here, so the two can never disagree about what happened.
    const stored = fx.rt.storage.sql<{ turn_ids: string }>`
      SELECT turn_ids FROM refinement_requests`;
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]!.turn_ids)).toEqual(negatives);
    expect(stored[0]!.turn_ids).not.toContain('always answer in one line');
  });
});

describe('scope — local workspace versus global account, stated rather than assumed', () => {
  test('an account-scoped proposal is refused: this database is one workspace', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText({
      scope: 'account',
      summary: 'change every workspace',
      edits: [{
        kind: 'fact',
        key: 'user.answer_length',
        value: 'one line',
        quote: 'always answer in one line',
        rationale: 'the user stated this and it should hold for every workspace they own',
      }],
    }));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const row = createRefinementStore(fx.rt.storage.sql).get(opened.id)!;
    expect(row.stage).toBe('refused');
    expect(row.detail).toContain('account');
    expect(fx.facts.recall('user.answer_length')).toBeNull();
  });

  test('the request records the scope it was opened at', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('{}');
    const opened = await requestRefinement(fx.deps(port), {
      trigger: 'explicit', scope: 'workspace',
    });
    expect(opened.scope).toBe('workspace');
  });
});

describe('the stage machine — restart, retry, and no duplicate work', () => {
  test('a guarded transition is a no-op the second time', () => {
    const fx = fixture();
    const store = createRefinementStore(fx.rt.storage.sql);
    const { request } = store.open({
      trigger: 'explicit', scope: 'workspace', turnIds: ['neg-0'],
    });

    expect(store.advance(request.id, 'requested', 'planning')).toBe(true);
    expect(store.advance(request.id, 'requested', 'planning')).toBe(false);
    expect(store.get(request.id)?.stage).toBe('planning');
  });

  test('the same debt batch opens exactly one request, however often it is derived', () => {
    const fx = fixture();
    const store = createRefinementStore(fx.rt.storage.sql);
    const input = {
      trigger: 'evolution_debt' as const,
      scope: 'workspace' as const,
      turnIds: ['neg-0', 'neg-1', 'neg-2'],
      debtKey: 'debt-abc',
    };

    const first = store.open(input);
    const second = store.open(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(store.list().filter((row) => row.trigger === 'evolution_debt')).toHaveLength(1);
  });

  test('a request abandoned before the refiner answered is re-asked exactly once', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    let runs = 0;
    const port: TemporaryAgentPort = {
      run: async () => {
        runs += 1;
        return {
          status: 'completed', agent: 'refiner', lifetime: 'task', role: 'general',
          answer: proposalText(FACT_PROPOSAL),
          transcript: 'kept', elapsed_ms: 1,
        };
      },
      settle: () => false,
    };
    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    // A host claimed the request and died INSIDE the refiner: the row is
    // `planning` with no proposal and nothing routed.
    expect(store.advance(opened.id, 'requested', 'planning')).toBe(true);
    expect(store.get(opened.id)?.proposal).toBeNull();
    expect(store.get(opened.id)?.routes).toEqual([]);

    // Activation recovery owes it again — a lease is not the work.
    expect(store.resetStalePlanning()).toBe(1);
    expect(store.get(opened.id)?.stage).toBe('requested');

    await advanceRefinementLane(deps);
    expect(runs).toBe(1);
    const row = store.get(opened.id)!;
    expect(row.routes).toHaveLength(1);
    // A fact-only proposal has nothing to wait for, so it REACHES applied
    // instead of parking in `gated` forever.
    expect(row.stage).toBe('applied');
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');

    // Driving the lane again finds nothing owed and re-applies nothing.
    const again = await advanceRefinementLane(deps);
    expect(again.step).toBe('idle');
    expect(runs).toBe(1);
    expect(fx.facts.all()).toHaveLength(1);
  });

  test('a request abandoned AFTER the refiner answered reuses its plan, never re-asks', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    let runs = 0;
    // A refiner whose SECOND answer differs. If recovery re-asked, the resumed
    // pass would route a plan the earlier writes do not belong to — which is
    // exactly what persisting the proposal first prevents.
    const port: TemporaryAgentPort = {
      run: async () => {
        runs += 1;
        return {
          status: 'completed', agent: 'refiner', lifetime: 'task', role: 'general',
          answer: proposalText(runs === 1 ? FACT_PROPOSAL : {
            ...FACT_PROPOSAL,
            edits: [{ ...FACT_EDIT, key: 'user.something_else' }],
          }),
          transcript: 'kept', elapsed_ms: 1,
        };
      },
      settle: () => false,
    };
    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(runs).toBe(1);
    expect(store.get(opened.id)?.proposal).not.toBeNull();

    // Simulate a process that died after the plan landed and after the write:
    // the row is dragged back to `planning` with its plan intact.
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'planning' WHERE id = ${opened.id}`;
    expect(store.resetStalePlanning()).toBe(1);
    await advanceRefinementLane(deps);

    // The plan was REUSED, so no second child agent ran and no second fact
    // exists — the keyed authority adopted the value it already held.
    expect(runs).toBe(1);
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(fx.facts.recall('user.something_else')).toBeNull();
    expect(fx.facts.all()).toHaveLength(1);
    expect(store.get(opened.id)?.routes).toHaveLength(1);
  });

  test('a crash after EACH owner write leaves that write recorded and adopts it on resume', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const deps = fx.deps(scriptedRefiner(proposalText(EVERY_OWNER_PROPOSAL)).port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const settledRoutes = store.get(opened.id)!.routes;
    expect(settledRoutes).toHaveLength(3);

    // Now re-drive from `planning` once per completed write. Every pass must
    // reach the same three routes, adopt rather than duplicate, and leave the
    // owners holding exactly one record each.
    for (let pass = 0; pass < 3; pass += 1) {
      void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'planning'
        WHERE id = ${opened.id}`;
      store.resetStalePlanning();
      await advanceRefinementLane(deps);

      const routes = store.get(opened.id)!.routes;
      expect(routes).toHaveLength(3);
      expect(routeFor(routes, 'fact').disposition).toBe('applied');
      expect(routeFor(routes, 'prompt_section').disposition).toBe('pending_trials');
      // The SAME pending version every time: adopted, never re-proposed.
      expect(routeFor(routes, 'prompt_section').target).toBe(
        routeFor(settledRoutes, 'prompt_section').target);
      expect(routeFor(routes, 'skill').disposition).toBe('pending_owner_approval');
      expect(fx.facts.all()).toHaveLength(1);
      // Staged, never promoted: no owner has decided, so SKILLS_DIR stays empty
      // across every re-drive.
      expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
      expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
        .toBe(BREVITY_SKILL);
      expect(listPromptSectionVersions(fx.rt.storage.sql, 50)).toHaveLength(1);
    }
  });

  test('no clock bounds a request — recovery is by activation, never by elapsed time', () => {
    const fx = fixture();
    const store = createRefinementStore(fx.rt.storage.sql);
    const { request } = store.open({
      trigger: 'explicit', scope: 'workspace', turnIds: ['neg-0'], now: 1,
    });
    store.advance(request.id, 'requested', 'planning');
    // Stamped in 1970 and still recovered: the stale claim is what makes it
    // owed, not how long ago it was made.
    expect(store.resetStalePlanning()).toBe(1);
    expect(store.get(request.id)?.stage).toBe('requested');
  });
});

/**
 * TWO PASSES AT ONCE, which both hosts really deliver.
 *
 * The cloud actor nudges this lane from the `/refine` callable AND drives it
 * from the off-turn cadence pass; the CLI session does the same. So two
 * `advanceRefinementLane` calls can be in flight over one workspace, and a third
 * party — activation recovery — can re-queue a claim while its refiner is still
 * running, because the engine that calls `resetStalePlanning` is constructed
 * LAZILY rather than at the activation boundary.
 *
 * What must hold through all of that: one temporary ask per plan, one write per
 * owner, one route set, and no elapsed lease anywhere.
 */
describe('two passes at once — the claim, and what recovery may not revoke', () => {
  test('two deliveries of the same step run ONE refiner and write each owner once', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const refiner = deferredRefiner(EVERY_OWNER_PROPOSAL);
    const deps = fx.deps(refiner.port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    // Both drivers, before either can finish: the second one arrives while the
    // first is inside its child agent.
    const nudge = advanceRefinementLane(deps);
    const cadence = advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('planning');
    refiner.release();
    const [first, second] = await Promise.all([nudge, cadence]);

    // The claimer planned; the other found the row taken and did nothing.
    expect(first.step).toBe('planned');
    expect(second.step).toBe('idle');
    expect(refiner.asks()).toBe(1);

    const row = store.get(opened.id)!;
    expect(row.routes).toHaveLength(3);
    expect(row.stage).toBe('evaluating');
    expect(fx.facts.all()).toHaveLength(1);
    expect(listPromptSectionVersions(fx.rt.storage.sql, 50)).toHaveLength(1);
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
      .toBe(BREVITY_SKILL);
    // Nothing went live off a proposal: the skill is staged, the section pending.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(routeFor(row.routes, 'prompt_section').disposition).toBe('pending_trials');
  });

  test('recovery leaves a claim this process is still running alone', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const refiner = deferredRefiner(EVERY_OWNER_PROPOSAL, OTHER_OWNER_PROPOSAL);
    const deps = fx.deps(refiner.port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const inFlight = advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('planning');

    // The real recovery caller, at the moment it really runs: an engine built on
    // the turn AFTER the nudge started this planner.
    const recovery = new EvolutionEngine(fx.rt, { enabled: false });
    // Its constructor recovered what it owns — an empty review queue — and left
    // the live refinement claim exactly where it was.
    expect(recovery.sessionWindow.countQueuedReviews()).toBe(0);
    expect(store.get(opened.id)?.stage).toBe('planning');
    expect(store.resetStalePlanning()).toBe(0);

    refiner.release();
    expect((await inFlight).step).toBe('planned');
    // One ask, and the answer that was routed is the one this pass got.
    expect(refiner.asks()).toBe(1);
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(fx.facts.all()).toHaveLength(1);
    expect(store.get(opened.id)!.routes).toHaveLength(3);
    expect(listPromptSectionVersions(fx.rt.storage.sql, 50)).toHaveLength(1);
  });

  test('a claim another process re-queued writes nothing behind its successor', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const refiner = deferredRefiner(EVERY_OWNER_PROPOSAL, OTHER_OWNER_PROPOSAL);
    const deps = fx.deps(refiner.port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const revoked = advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('planning');

    // A SECOND process recovering — a second CLI on this workspace file. It
    // never issued this token, so it cannot tell the claim from a dead one and
    // re-queues it, exactly as its own `resetStalePlanning` would.
    void fx.rt.storage.sql`UPDATE refinement_requests
      SET stage = 'requested', claim = NULL WHERE stage = 'planning'`;

    // The successor plans it from a SECOND refiner answer — the price of a
    // recovery, and read-only, which is why re-driving is allowed at all.
    expect((await advanceRefinementLane(deps)).step).toBe('planned');
    expect(refiner.asks()).toBe(2);

    // Now the revoked pass comes back with the FIRST answer, against owners the
    // successor already wrote.
    refiner.release();
    expect((await revoked).step).toBe('idle');

    const row = store.get(opened.id)!;
    expect(row.stage).toBe('evaluating');
    expect(row.routes).toHaveLength(3);
    // One write per owner, and every one of them is the SUCCESSOR's.
    expect(fx.facts.all()).toHaveLength(1);
    expect(fx.facts.recall('user.answer_shape')?.value).toBe('one line');
    expect(fx.facts.recall('user.answer_length')).toBeNull();
    const versions = listPromptSectionVersions(fx.rt.storage.sql, 50);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.source).toBe(`${INCUMBENT.slice(0, -6)}BRIEF.`);
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
      .toBe(`${BREVITY_SKILL}\nName the ask.`);
  });

  test('a pass that threw is re-queued by the NEXT pass, in the same process', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    let asks = 0;
    // The child-agent host going away mid-call: the port rejects, so the pass
    // unwinds without refusing the request or recording anything.
    const port: TemporaryAgentPort = {
      run: async () => {
        asks += 1;
        if (asks === 1) throw new Error('the refiner host went away');
        return {
          status: 'completed', agent: 'refiner-1', lifetime: 'task', role: 'general',
          answer: proposalText(EVERY_OWNER_PROPOSAL), transcript: 'kept', elapsed_ms: 1,
        };
      },
      settle: () => false,
    };
    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await expect(advanceRefinementLane(deps)).rejects.toThrow('the refiner host went away');
    // The row is left claimed by a pass that is no longer running, and no owner
    // was touched.
    expect(store.get(opened.id)?.stage).toBe('planning');
    expect(fx.facts.all()).toEqual([]);

    // No new activation, no clock: the next pass in THIS process re-queues it
    // and drives it to the end.
    const step = await advanceRefinementLane(deps);
    expect(step.step).toBe('planned');
    expect(asks).toBe(2);
    const row = store.get(opened.id)!;
    expect(row.stage).toBe('evaluating');
    expect(row.routes).toHaveLength(3);
    expect(fx.facts.all()).toHaveLength(1);
    expect(listPromptSectionVersions(fx.rt.storage.sql, 50)).toHaveLength(1);
  });

  test('a claim is live until the pass ends, and never for a length of time', () => {
    const fx = fixture();
    const store = createRefinementStore(fx.rt.storage.sql);
    const { request } = store.open({
      trigger: 'explicit', scope: 'workspace', turnIds: ['neg-0'], now: 1,
    });

    const claim = store.claim(request.id)!;
    expect(claim.held()).toBe(true);
    // Stamped in 1970 and still not stale: the row is held by a pass that is
    // running, and no amount of elapsed time is what ends that.
    expect(store.resetStalePlanning()).toBe(0);
    // Nor may a second pass take it while it is held.
    expect(store.claim(request.id)).toBeNull();

    claim.release();
    // The pass is over, so the claim is owed again — by activation, not by clock.
    expect(store.resetStalePlanning()).toBe(1);
    expect(store.get(request.id)?.stage).toBe('requested');
    expect(claim.held()).toBe(false);
    expect(claim.record({ detail: 'a pass that lost the row writes nothing' })).toBe(false);
    expect(store.get(request.id)?.detail).toBe('');
  });
});

describe('promotion — the existing evaluated lane is the only thing that applies', () => {
  test('the section promotes on trial evidence, and only then does the request apply', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'tighten the output-format section',
      edits: [{
        kind: 'prompt_section',
        sectionId: TARGET_ID,
        source: CANDIDATE,
        rationale: 'four corrected turns all asked for a shorter answer than the section invites',
      }],
    }));
    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    // The EXISTING lane runs the trials and decides. Nothing in the refinement
    // module promotes anything.
    for (let i = 0; i < 20; i += 1) {
      const step = await advancePromptSectionLane(deps.control);
      if (step.step === 'trials' && step.trials.action) break;
    }
    expect(activePromptSectionOverrides(fx.rt.storage.sql)[TARGET_ID]).toBe(CANDIDATE);

    const settled = await advanceRefinementLane(deps);
    expect(settled.step).toBe('settled');
    expect(store.get(opened.id)?.stage).toBe('applied');
  });

  test('a rolled-back section rolls back the request that proposed it', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'tighten the output-format section',
      edits: [{
        kind: 'prompt_section',
        sectionId: TARGET_ID,
        source: CANDIDATE,
        rationale: 'four corrected turns all asked for a shorter answer than the section invites',
      }],
    }));
    // The candidate proposes well but TRIALS badly: the incumbent wins every
    // paired comparison once the proposal exists.
    let proposed = false;
    const deps = fx.deps(port, (candidate) => {
      if (!proposed) return candidate === CANDIDATE ? 0.9 : 0.4;
      return candidate === CANDIDATE ? 0.1 : 0.9;
    });
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    proposed = true;
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    for (let i = 0; i < 20; i += 1) {
      const step = await advancePromptSectionLane(deps.control);
      if (step.step === 'trials' && step.trials.action) break;
    }
    expect(activePromptSectionOverrides(fx.rt.storage.sql)[TARGET_ID]).toBeUndefined();

    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });
});

describe('evolution debt — the automatic trigger, and its visibility', () => {
  test('debt accumulates from unresolved negative outcomes', () => {
    const fx = fixture();
    expect(evolutionDebt(fx.rt.storage.sql).turnIds).toEqual([]);

    seedGradedTurns(fx.rt, MIN_REFINEMENT_DEBT - 1);
    const shallow = evolutionDebt(fx.rt.storage.sql);
    expect(shallow.turnIds).toHaveLength(MIN_REFINEMENT_DEBT - 1);
    expect(shallow.owed).toBe(false);
    // The threshold's one public statement. If the module's constant moves and
    // this file's literal does not, this is the assertion that goes red.
    expect(shallow.summary).toContain(`opens at ${String(MIN_REFINEMENT_DEBT)}`);

    seedGradedTurns(fx.rt, 1);
    const owed = evolutionDebt(fx.rt.storage.sql);
    expect(owed.turnIds.length).toBeGreaterThanOrEqual(MIN_REFINEMENT_DEBT);
    expect(owed.owed).toBe(true);
    expect(owed.key).toMatch(/^[0-9a-f]{16,}$/);
  });

  test('the automatic trigger opens one request and never re-opens the same batch', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, MIN_REFINEMENT_DEBT);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    }));
    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql);
    const debt = evolutionDebt(fx.rt.storage.sql);

    const first = await refinementDebtRequest(deps);
    expect(first?.trigger).toBe('evolution_debt');
    expect(first?.stage).toBe('requested');
    expect(first?.turnIds).toEqual(debt.turnIds);

    // The batch is TAKEN, so a later tick sees nothing owed rather than owing
    // the same turns twice. That is the primary guard.
    expect(await refinementDebtRequest(deps)).toBeNull();
    expect(store.list()).toHaveLength(1);

    // The unique debt key is the second guard, for the derivation that raced
    // the first one and reached the store with the same batch in hand.
    const replayed = store.open({
      trigger: 'evolution_debt',
      scope: 'workspace',
      turnIds: debt.turnIds,
      debtKey: debt.key,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.request.id).toBe(first!.id);
    expect(store.list()).toHaveLength(1);
  });

  test('below the threshold the trigger does not fire', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, MIN_REFINEMENT_DEBT - 1);
    const { port } = scriptedRefiner('{}');
    expect(await refinementDebtRequest(fx.deps(port))).toBeNull();
  });

  test('turns a request already covers stop counting as debt', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, MIN_REFINEMENT_DEBT);
    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    }));
    const deps = fx.deps(port);

    await refinementDebtRequest(deps);
    const remaining = evolutionDebt(fx.rt.storage.sql);
    expect(remaining.turnIds).toEqual([]);
    expect(remaining.owed).toBe(false);

    // Fresh failures accrue fresh debt under a DIFFERENT key.
    seedGradedTurns(fx.rt, MIN_REFINEMENT_DEBT, 0);
    const next = evolutionDebt(fx.rt.storage.sql);
    expect(next.owed).toBe(true);
    expect(next.key).not.toBe(remaining.key);
  });
});

describe('the strict proposal boundary — an unknown field is refused, never dropped', () => {
  test('a top-level unknown field refuses the whole proposal', () => {
    const parsed = v.safeParse(RefinementProposalSchema, {
      scope: 'workspace', summary: 'x', edits: [], confidence: 0.9,
    });
    expect(parsed.success).toBe(false);
  });

  test('an unknown field on an EDIT refuses it — a dropped claim would be obeyed wrongly', () => {
    // The case that makes strictness load-bearing rather than tidy: a
    // permissive object would erase `scope` here and apply the fact at
    // workspace scope, obeying a proposal nobody wrote.
    const parsed = v.safeParse(RefinementProposalSchema, {
      scope: 'workspace',
      summary: 'x',
      edits: [{
        kind: 'fact',
        key: 'k',
        value: 1,
        quote: 'always answer in one line',
        rationale: 'a rationale long enough to clear the forty-character minimum it owes',
        scope: 'account',
      }],
    });
    expect(parsed.success).toBe(false);
  });

  test('an unknown `kind` has no authority, so it is refused at the parse', () => {
    expect(v.safeParse(RefinementProposalSchema, {
      scope: 'workspace', summary: 'x',
      edits: [{ kind: 'scaffold', source: 'x', rationale: 'y'.repeat(40) }],
    }).success).toBe(false);
  });

  test('a well-formed proposal still parses', () => {
    expect(v.safeParse(RefinementProposalSchema, FACT_PROPOSAL).success).toBe(true);
  });
});

describe('the quote gate — substantive, the user\'s own, and carried into the record', () => {
  async function routeQuote(quote: string): Promise<RefinementRoute> {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText({
      ...FACT_PROPOSAL,
      edits: [{ ...FACT_EDIT, quote }],
    })).port);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    return routeFor(createRefinementStore(fx.rt.storage.sql).get(opened.id)!.routes, 'fact');
  }

  test('a short or few-worded fragment is refused however truly it appears', async () => {
    // "one line" IS in every seeded turn. It is still not evidence of intent.
    for (const quote of ['one line', 'answer', 'in one line']) {
      const route = await routeQuote(quote);
      expect(route.disposition).toBe('refused');
      expect(route.reason).toContain('not substantive');
    }
  });

  test('a substantive sentence the user really said is accepted', async () => {
    const route = await routeQuote('always answer in one line');
    expect(route.disposition).toBe('applied');
  });

  test('the agent\'s OWN words are not user evidence', async () => {
    // The assistant response in every seeded turn. Long enough, and refused:
    // a preference sourced from the agent's prose is the agent instructing
    // itself.
    const route = await routeQuote('a long rambling answer that nobody asked for');
    expect(route.disposition).toBe('refused');
    expect(route.reason).toContain('not quoted by the user');
  });

  test('the accepted quote rides the route, so the changelog shows the words', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(FACT_PROPOSAL)).port);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const route = routeFor(
      createRefinementStore(fx.rt.storage.sql).get(opened.id)!.routes, 'fact',
    );
    expect(route.reason).toContain('always answer in one line');
    const card = buildChangelog(fx.rt.storage.sql, { limit: 50 })
      .find((entry) => entry.id.startsWith(`refinement:${opened.id}`));
    expect(card?.items?.[0]?.evidence).toContain('always answer in one line');
    // The child carries the OWNER's revert, not a refinement-shaped one.
    expect(card?.items?.[0]?.revert).toEqual({ type: 'fact_forget', target: 'user.answer_length' });
    expect(card?.revert).toBeUndefined();
  });
});

describe('mixed outcomes settle honestly', () => {
  test('a preference that landed plus a section that lost still reads as applied', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const proposal: RefinementProposal = {
      scope: 'workspace',
      summary: 'a preference and a section',
      edits: [
        FACT_PROPOSAL.edits[0]!,
        {
          kind: 'prompt_section',
          sectionId: TARGET_ID,
          source: CANDIDATE,
          rationale: 'four corrected turns all asked for a shorter answer than the section invites',
        },
      ],
    };
    let proposed = false;
    const deps = fx.deps(scriptedRefiner(proposalText(proposal)).port, (candidate) => {
      if (!proposed) return candidate === CANDIDATE ? 0.9 : 0.4;
      return candidate === CANDIDATE ? 0.1 : 0.9;
    });
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    proposed = true;
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    for (let i = 0; i < 20; i += 1) {
      const step = await advancePromptSectionLane(deps.control);
      if (step.step === 'trials' && step.trials.action) break;
    }
    expect(activePromptSectionOverrides(fx.rt.storage.sql)[TARGET_ID]).toBeUndefined();

    await advanceRefinementLane(deps);
    const settled = store.get(opened.id)!;
    // The fact IS live. Calling the request rolled_back would be a lie about it.
    expect(settled.stage).toBe('applied');
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(settled.detail).toContain('1 edit in effect');
    expect(settled.detail).toContain('1 rolled back');
  });
});

describe('the refiner never sees the set its proposal is scored on', () => {
  test('held-out turns are withheld from the brief and named as withheld', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 6);
    const { port, requests } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    }));
    const deps = fx.deps(port);

    await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const brief = requests[0]!.task;

    const split = buildOutcomeEvalSplit(fx.rt.storage.sql, EVAL_SIZE);
    expect(split.heldOutNegatives).toBeGreaterThan(0);
    // Every val instance is a turn the section metric will score a candidate
    // against. None of them may appear in the brief.
    for (const instance of split.val) {
      expect(brief).not.toContain(instance.input);
    }
    // The train half IS shown — reflection has to have something to fix.
    expect(split.train.length).toBeGreaterThan(0);
    expect(brief).toContain(split.train[0]!.input);
    expect(brief).toContain('WITHHELD');
  });
});

describe('evolution debt pages, and never loses an older row', () => {
  test('a batch is capped, and the remainder is named rather than dropped', () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 20, 0);
    const debt = evolutionDebt(fx.rt.storage.sql);

    expect(debt.turnIds).toHaveLength(12);
    // The OLDEST twelve: those are the ones that have been waiting.
    expect(debt.turnIds).toEqual(negatives.slice(0, 12));
    expect(debt.summary).toContain('8 more waiting behind this batch');
  });

  test('once a batch is taken, the ones behind it become the next batch', async () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 20, 0);
    const deps = fx.deps(scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    })).port);

    const first = await refinementDebtRequest(deps);
    expect(first?.turnIds).toHaveLength(12);

    // THE REGRESSION THIS GUARDS: a windowed read would look at the newest
    // twelve rows, find them all covered, and report no debt — leaving the
    // eight OLDER failures behind a window that never reaches them again.
    const next = evolutionDebt(fx.rt.storage.sql);
    expect(next.owed).toBe(true);
    expect(next.turnIds).toEqual(negatives.slice(12));
    expect(next.key).not.toBe(first!.turnIds.join(''));

    const second = await refinementDebtRequest(deps);
    expect(second?.id).not.toBe(first!.id);
    expect(second?.turnIds).toEqual(negatives.slice(12));
    expect(evolutionDebt(fx.rt.storage.sql).owed).toBe(false);
  });

  test('a covered batch newer than an uncovered one does not hide it', () => {
    const fx = fixture();
    const { negatives: older } = seedGradedTurns(fx.rt, 3, 0);
    const { negatives: newer } = seedGradedTurns(fx.rt, 14, 0);
    // A request takes the NEWEST rows explicitly, jumping the queue.
    createRefinementStore(fx.rt.storage.sql).open({
      trigger: 'explicit', scope: 'workspace', turnIds: newer,
    });

    const debt = evolutionDebt(fx.rt.storage.sql);
    expect(debt.turnIds).toEqual(older);
    expect(debt.owed).toBe(true);
  });
});

describe('an account-scoped request never reaches a model or an owner', () => {
  test('it is refused at open, before the refiner runs', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port, requests } = scriptedRefiner(proposalText(FACT_PROPOSAL));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'account' });
    expect(opened.stage).toBe('refused');
    expect(opened.detail).toContain('account scope is refused');
    expect(opened.scope).toBe('account');

    // No child agent was spent, and the lane will not pick a refused row up.
    expect((await advanceRefinementLane(deps)).step).toBe('idle');
    expect(requests).toEqual([]);
    expect(fx.facts.all()).toEqual([]);
  });
});

describe('owner promotion — the approval is what makes a staged skill live', () => {
  async function stagedFixture() {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    return { fx, deps, store, id: opened.id, staged: refinementStagingPath(opened.id, 'brevity') };
  }

  test('approval writes the trust row and promotes the file, in that order', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();
    expect(store.get(id)?.stage).toBe('evaluating');

    const result = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(result.ok).toBe(true);

    // The file is now where discovery reads it, AND it is already trusted —
    // never briefly live-but-unverified.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
    expect(await discoveredSkillNames(fx.rt)).toEqual(['brevity']);
    expect(fx.approvals.trustOf(BREVITY_PATH, BREVITY_SKILL)).toBe('approved');
    // The staging is cleared behind it.
    expect(await readSkill(fx.rt, staged)).toBeNull();

    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('applied');
  });

  test('a crash between the trust row and the file is repaired, already trusted', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();

    // Exactly the crash window: the approval landed, the promotion did not.
    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL));
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    // Nothing discovers a path with no file, so the window is inert.
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);

    // Whoever looks next completes it.
    await advanceRefinementLane(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
    expect(fx.approvals.trustOf(BREVITY_PATH, BREVITY_SKILL)).toBe('approved');
    expect(await readSkill(fx.rt, staged)).toBeNull();
    expect(store.get(id)?.stage).toBe('applied');

    // And it is idempotent: a second look changes nothing.
    await advanceRefinementLane(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
  });

  test('a crash between the file and the staging cleanup is repaired too', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();
    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL));
    await writeSkill(fx.rt, BREVITY_PATH, BREVITY_SKILL);
    expect(await readSkill(fx.rt, staged)).toBe(BREVITY_SKILL);

    await advanceRefinementLane(deps);
    expect(await readSkill(fx.rt, staged)).toBeNull();
    expect(store.get(id)?.stage).toBe('applied');
  });

  test('approval refuses bytes that changed since they were staged', async () => {
    const { fx, deps, id, staged } = await stagedFixture();
    await writeSkill(fx.rt, staged, `${BREVITY_SKILL}\nsomebody edited the staging.`);

    // `show` reports the drift rather than hiding it, and the digest it prints
    // is no longer the route's — so the token check refuses first.
    const shown = await showRefinementRoute(deps, { requestId: id, routeIndex: 0 });
    expect(shown.ok === true && shown.view.intact).toBe(false);
    const drifted = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0,
      expectedDigest: shown.ok === true ? shown.view.digest : '',
      decision: 'approve',
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.ok === false && drifted.error).toContain('not the edit you were shown');

    // And approving with the ORIGINAL token is refused at the staging check.
    const result = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('changed since they were proposed');
    // Nothing was trusted and nothing was promoted.
    expect(fx.approvals.list()).toEqual([]);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('approval refuses when the final path filled up meanwhile', async () => {
    const { fx, deps, id } = await stagedFixture();
    await writeSkill(fx.rt, BREVITY_PATH, `${BREVITY_SKILL}\nsomebody got there first.`);

    const result = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('holds different bytes');
    // The proposal is LEFT STAGED, so the collision is recoverable rather than
    // a lost proposal.
    expect(await readSkill(fx.rt, refinementStagingPath(id, 'brevity'))).toBe(BREVITY_SKILL);
    expect(fx.approvals.list()).toEqual([]);
  });

  test('rejection deletes the staging and rolls the request back', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();

    const result = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'reject',
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.request.routes[0]?.disposition).toBe('rejected');
    expect(await readSkill(fx.rt, staged)).toBeNull();
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(fx.approvals.list()).toEqual([]);

    await advanceRefinementLane(deps);
    const settled = store.get(id)!;
    expect(settled.stage).toBe('rolled_back');
    expect(settled.detail).toContain('rejected by you');
  });

  test('an undecided proposal waits forever — no clock, no default', async () => {
    const { fx, deps, store, id } = await stagedFixture();
    // Ten passes, a request stamped in 1970, and still pending: only the owner
    // ends this.
    void fx.rt.storage.sql`UPDATE refinement_requests SET created_at = 1, updated_at = 1
      WHERE id = ${id}`;
    for (let i = 0; i < 10; i += 1) {
      expect((await advanceRefinementLane(deps)).step).toBe('idle');
    }
    expect(store.get(id)?.stage).toBe('evaluating');
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('every way a decision reference can be wrong is refused by name', async () => {
    // (a) a settled request: its edits are not the owner's to decide any more.
    const settled = fixture();
    seedGradedTurns(settled.rt, 3);
    const factDeps = settled.deps(scriptedRefiner(proposalText(FACT_PROPOSAL)).port);
    const factReq = await requestRefinement(factDeps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(factDeps);
    const onSettled = await decideRefinementRoute(factDeps, {
      requestId: factReq.id, routeIndex: 0,
      expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(onSettled.ok).toBe(false);
    expect(onSettled.ok === false && onSettled.error).toContain('already settled');

    // (b) a request whose routes are not made yet.
    const early = fixture();
    seedGradedTurns(early.rt, 3);
    const earlyDeps = early.deps(scriptedRefiner(proposalText(FACT_PROPOSAL)).port);
    const pendingReq = await requestRefinement(earlyDeps, {
      trigger: 'explicit', scope: 'workspace',
    });
    const onEarly = await decideRefinementRoute(earlyDeps, {
      requestId: pendingReq.id, routeIndex: 0,
      expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(onEarly.ok).toBe(false);
    expect(onEarly.ok === false && onEarly.error).toContain('not routed yet');

    // (c) a staged skill beside a non-skill edit: only the skill is decidable,
    //     and the index that names the other one says so.
    const mixed = fixture();
    seedGradedTurns(mixed.rt, 3);
    const mixedDeps = mixed.deps(scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'a preference and a skill',
      edits: [FACT_PROPOSAL.edits[0]!, skillProposal(BREVITY_SKILL).edits[0]!],
    })).port);
    const mixedReq = await requestRefinement(mixedDeps, {
      trigger: 'explicit', scope: 'workspace',
    });
    await advanceRefinementLane(mixedDeps);
    const onFact = await decideRefinementRoute(mixedDeps, {
      requestId: mixedReq.id, routeIndex: 0,
      expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(onFact.ok).toBe(false);
    expect(onFact.ok === false && onFact.error).toContain('needs no decision from you');

    // (d) a bad edit index, a bad request id, and a wrong digest token.
    expect((await decideRefinementRoute(mixedDeps, {
      requestId: mixedReq.id, routeIndex: 9,
      expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    })).ok).toBe(false);
    expect((await decideRefinementRoute(mixedDeps, {
      requestId: 'refine-nope', routeIndex: 0,
      expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    })).ok).toBe(false);
    const wrongToken = await decideRefinementRoute(mixedDeps, {
      requestId: mixedReq.id, routeIndex: 1,
      expectedDigest: instructionDigest('some other skill entirely'), decision: 'approve',
    });
    expect(wrongToken.ok).toBe(false);
    expect(wrongToken.ok === false && wrongToken.error).toContain('not the edit you were shown');
    // Nothing was granted by any of them.
    expect(mixed.approvals.list()).toEqual([]);
    expect(await readSkill(mixed.rt, BREVITY_PATH)).toBeNull();
  });

  test('a decided row is not offered again', async () => {
    const { deps, id } = await stagedFixture();
    const digest = instructionDigest(BREVITY_SKILL);
    expect((await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: digest, decision: 'reject',
    })).ok).toBe(true);

    // Both `show` and a second decision refuse: the row says `rejected`, so
    // there is nothing left to read or to decide.
    const shown = await showRefinementRoute(deps, { requestId: id, routeIndex: 0 });
    expect(shown.ok).toBe(false);
    expect(shown.ok === false && shown.error).toContain('already rejected');
    const again = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: digest, decision: 'reject',
    });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toContain('already rejected');
  });
});

describe('a hard kill at `gated` is still settled', () => {
  test('the scan covers gated as well as evaluating', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(FACT_PROPOSAL)).port);
    const store = createRefinementStore(fx.rt.storage.sql);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('applied');

    // A host killed between routing and the settle inside `plan` leaves the row
    // at `gated` with the fact already written. Nothing else will move it.
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'gated' WHERE id = ${opened.id}`;
    const step = await advanceRefinementLane(deps);
    expect(step.step).toBe('settled');
    expect(store.get(opened.id)?.stage).toBe('applied');
  });
});

describe('promotion never half-lands — the read-back is what allows the unlink', () => {
  /** A file plane whose write of ONE path misbehaves. The narrow seam these
   *  cases need: everything else on the plane keeps working. */
  function saboteur(
    rt: AgentRuntime,
    path: string,
    mode: 'throw' | 'tear',
  ): () => void {
    const vfs = rt.agentStateVfs ?? rt.storage.vfs;
    const real = vfs.writeFile.bind(vfs);
    vfs.writeFile = async (target: string, data: string | Uint8Array) => {
      if (target !== path) return real(target, data);
      if (mode === 'throw') throw new Error('disk full');
      // A torn write: the file exists and its bytes are not what was handed over.
      return real(target, `${data instanceof Uint8Array ? '' : data}\ntruncated`);
    };
    return () => { vfs.writeFile = real; };
  }

  async function staged() {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    return { fx, deps, store, id: opened.id, path: refinementStagingPath(opened.id, 'brevity') };
  }

  test('a copy that throws keeps the staging and stays retryable', async () => {
    const { fx, deps, store, id, path } = await staged();
    const repair = saboteur(fx.rt, BREVITY_PATH, 'throw');

    const result = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0,
      expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('could not write');

    // The trust row landed first and is harmless on its own; the bytes are
    // still staged, so nothing is lost and nothing is live.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);
    // The route is untouched, so the request keeps waiting with the reason.
    expect(store.get(id)!.routes[0]?.disposition).toBe('pending_owner_approval');

    // Repair the plane: the next settle finishes what the approval started.
    repair();
    await advanceRefinementLane(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
    expect(await readSkill(fx.rt, path)).toBeNull();
    expect(store.get(id)?.stage).toBe('applied');
  });

  test('a torn write is caught by the read-back and the staging survives', async () => {
    const { fx, deps, store, id, path } = await staged();
    const stop = saboteur(fx.rt, BREVITY_PATH, 'tear');

    const result = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0,
      expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('did not read back');

    // The torn file is NOT deleted — this module does not own it — but the
    // staging is intact, and the mismatch is surfaced rather than trusted.
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    expect(store.get(id)!.routes[0]?.disposition).toBe('pending_owner_approval');

    // And the collision persists honestly: a later settle refuses to overwrite
    // bytes that are not the approved ones, and says so.
    stop();
    await advanceRefinementLane(deps);
    const row = store.get(id)!;
    expect(row.stage).toBe('evaluating');
    expect(row.detail).toContain('not the approved ones');
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
  });

  test('a foreign file appearing at the target after approval is never overwritten', async () => {
    const { fx, deps, store, id, path } = await staged();
    // The approval lands; the promotion has not run yet.
    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL));
    // Somebody else writes there in the window.
    const foreign = `${BREVITY_SKILL}\nsomebody else got here first.`;
    await writeSkill(fx.rt, BREVITY_PATH, foreign);

    await advanceRefinementLane(deps);
    // Their bytes stand, ours stay staged, and the request keeps waiting.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(foreign);
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    const row = store.get(id)!;
    expect(row.stage).toBe('evaluating');
    expect(row.detail).toContain('refusing to overwrite');
  });

  test('a revocation discards the staging as well as rolling back', async () => {
    const { fx, deps, store, id, path } = await staged();
    fx.approvals.revoke(BREVITY_PATH);

    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('rolled_back');
    // Staging that will never be promoted is state nothing will read.
    expect(await readSkill(fx.rt, path)).toBeNull();
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('an owner decision survives a plan re-drive', async () => {
    const { fx, deps, store, id } = await staged();
    const digest = instructionDigest(BREVITY_SKILL);
    expect((await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: digest, decision: 'reject',
    })).ok).toBe(true);

    // A crash drags the row back to `planning`; the plan is re-run.
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'planning' WHERE id = ${id}`;
    store.resetStalePlanning();
    await advanceRefinementLane(deps);

    // The rejection stands. Re-routing would have asked the owner again about
    // bytes they already refused.
    expect(store.get(id)!.routes[0]?.disposition).toBe('rejected');
    expect(await readSkill(fx.rt, refinementStagingPath(id, 'brevity'))).toBeNull();
    expect(store.get(id)?.stage).toBe('rolled_back');
  });

  test('show returns the WHOLE file, never a preview', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    // A body far past any card's excerpt budget.
    const long = `---\nname: brevity\ndescription: answer briefly\n---\n${'Be brief. '.repeat(600)}`;
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(long))).port);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const shown = await showRefinementRoute(deps, { requestId: opened.id, routeIndex: 0 });
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.view.source).toBe(long);
      expect(shown.view.source.length).toBeGreaterThan(5_000);
      expect(shown.view.digest).toBe(instructionDigest(long));
      expect(shown.view.intact).toBe(true);
      expect(shown.view.target).toBe(BREVITY_PATH);
    }
    // The CARD is bounded — it is for scanning, not for deciding.
    const card = buildChangelog(fx.rt.storage.sql, { limit: 50 })
      .find((entry) => entry.id.startsWith(`refinement:${opened.id}`));
    expect(card?.items?.[0]?.evidence.length).toBeLessThan(long.length);
    expect(card?.items?.[0]?.evidence).toContain('chars');
  });
});
