/**
 * Continual refinement end to end over the real owners. Asserts: an LLM proposal
 * never moves live behaviour by itself; writes land only in existing stores; a crash
 * or duplicate delivery cannot double-apply; an unwritable authority is refused by name.
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
import type { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
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
import type { AgentStores } from '../src/state/agent-stores';
import type {
  TemporaryAgentPort, TemporaryRunOutcome, TemporaryRunRequest,
} from '../src/subordinates/temporary';
import {
  MIN_EDIT_RATIONALE, REFINEMENT_EDIT_KINDS, RefinementProposalSchema,
  createRefinementStore, evolutionDebt, initRefinementTables, refinementStagingPath,
  type RefinementDeps, type RefinementEdit, type RefinementProposal, type RefinementRoute,
} from '../src/evolution/refinement';
import { extractJsonObject } from '../src/prompts/structured';
import { renderIssues } from '../src/utils/json';

/** Module-private threshold; the `summary` assertion below keeps this literal in sync. */
const MIN_REFINEMENT_DEBT = 3;

import {
  advanceRefinementLane, refinementDebtRequest, requestRefinement,
} from '../src/evolution/refinement-lane';
import {
  decideRefinementRoute, showRefinementRoute,
} from '../src/evolution/refinement-skill';
import { createTestSql, present } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { RunEventRecorder } from '../src/events/recorder';

const EVAL_SIZE = 8;

const TARGET_ID = 'state/output-format';

const target = findPromptSectionTarget(TARGET_ID);

if (!target) throw new Error(`${TARGET_ID} is not registered`);

const INCUMBENT = target.source;

/** Same size as the incumbent, so the anti-bloat size rule is never under test here. */
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

/** `surface` throws: a refinement pass must never run a scaffold. */
function scriptedControl(rt: AgentRuntime, history: SessionHistory, score: (candidate: string) => number): ScaffoldControl {
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 7, text: 7, reasoning: undefined },
  };

  return {
    events: new RunEventRecorder(rt.storage.sql, rt.actor),
    rt,
    sql: rt.storage.sql,
    history,
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

/** Records every brief so tests can assert what the refiner saw. */
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
          role: 'task',
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
 * Only the first ask waits for the test's release. One answer per ask, the last
 * repeating; different answers make a second pass's owner writes visible.
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
        // Bound before the wait: the held pass answers what it was asked.
        const mine = Math.min(asks, answers.length) - 1;

        if (asks === 1) await gate;
        const answer = answers[mine];

        const outcome: TemporaryRunOutcome = {
          status: 'completed', agent: 'refiner-1', lifetime: 'task', role: 'task',
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
  stores: AgentStores;
  facts: FactsStore;
  approvals: InstructionApprovalStore;
  deps(refiner: TemporaryAgentPort, score?: (candidate: string) => number): RefinementDeps;
}

function fixture(): Fixture {
  const { rt, stores } = createTestRuntime();
  initAllTables(rt.storage.execRaw, rt.storage.sql);
  initTurnOutcomeTables(rt.storage.execRaw);
  initGepaTables(rt.storage.execRaw);
  initPromptSectionTables(rt.storage.execRaw);
  initInstructionApprovalsTable(rt.storage.execRaw);
  initRefinementTables(rt.storage.execRaw);
  const facts = createFactsStore(rt.storage.sql, rt.actor);

  const approvals = new InstructionApprovalStore(
    rt.storage.sql, rt.actor, 'test-workspace',
  );

  return {
    rt,
    stores,
    facts,
    approvals,
    deps: (refiner, score = (candidate) => (candidate === CANDIDATE ? 0.9 : 0.4)) => ({
      control: scriptedControl(rt, stores.history, score),
      facts,
      refiner,
      approvals,
    }),
  };
}

/**
 * Turn ids are unique so each call accrues new debt (one effective verdict per id).
 * Timestamps are distinct because same-millisecond rows have no defined order.
 */
const SEED_EPOCH = 1_700_000_000_000;

let seeded = 0;

function seedGradedTurns(rt: AgentRuntime, negatives: number, accepted = 2) {
  const seededNegatives: string[] = [];
  const seededAccepted: string[] = [];

  for (let i = 0; i < negatives; i += 1) {
    const turnId = `neg-${String((seeded += 1))}`;
    recordTurnOutcome(rt.storage.sql, rt.actor, {
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
    recordTurnOutcome(rt.storage.sql, rt.actor, {
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

const BREVITY_SKILL =
  '---\nname: brevity\ndescription: answer briefly\nallowed_tools: [read]\n---\nBe brief.';

const BREVITY_PATH = skillPath('brevity');

const BUILTIN_CLASH =
  '---\nname: audit-implementation\ndescription: not the real one\n---\nMine now.';

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

/** One edit per writable authority, so a duplicated pass shows up in every owner. */
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
      skillProposal(skill).edits[0],
    ],
  };
}

const EVERY_OWNER_PROPOSAL = everyOwnerProposal(FACT_EDIT, CANDIDATE, BREVITY_SKILL);

/** Different bytes per owner, so a second pass's writes can be told apart. */
const OTHER_OWNER_PROPOSAL = everyOwnerProposal(
  { ...FACT_EDIT, key: 'user.answer_shape' },
  `${INCUMBENT.slice(0, -6)}BRIEF.`,
  `${BREVITY_SKILL}\nName the ask.`,
);

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

/** What the prompt would see: `discoverSkills` under SKILLS_DIR. */
async function discoveredSkillNames(rt: AgentRuntime): Promise<string[]> {
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  const discovery = await discoverSkills(skillsVfsOver(vfs), { admissionTokens: 100_000 });

  return discovery.skills.filter((skill) => skill.bodyRef.kind === 'file').map((skill) => skill.name);
}

/** The owner's approval surface, the other reader a SKILLS_DIR write would reach. */
async function gatheredSkillPaths(rt: AgentRuntime): Promise<string[]> {
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;

  const sources = await gatherApprovableInstructions({
    skillsVfs: skillsVfsOver(vfs),
    admissionTokens: 100_000,
  });

  return sources.filter((source) => source.kind === 'skill').map((source) => source.path);
}

describe('refinement request — durable, and behaviourally inert', () => {
  test('an explicit request returns a durable row at `requested` and changes nothing', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('{}');

    const before = activePromptSectionOverrides(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(fx.deps(port), {
      trigger: 'explicit', scope: 'workspace', sessionId: 'session-1',
    });

    expect(opened.stage).toBe('requested');
    expect(opened.id).toMatch(/^refine-/);
    expect(opened.turnIds.length).toBeGreaterThan(0);
    // No artifact moved, and no model was called.
    expect(activePromptSectionOverrides(fx.rt.storage.sql, fx.rt.actor)).toEqual(before);
    expect(fx.facts.all()).toEqual([]);

    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
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
    const brief = requests[0].task;

    expect(brief).toContain('always answer in one line');
    expect(brief).toContain('no, shorter please');
    expect(brief).toContain(TARGET_ID);
    expect(brief).toContain('user.tz');
    expect(brief).toContain('prompt_section');
    expect(brief).toContain('subagent_spec');

    // A second request over later failures is told what the first one did.
    seedGradedTurns(fx.rt, 3);

    const { port: second, requests: secondRequests } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'still nothing', edits: [],
    }));

    const secondDeps = fx.deps(second);
    await requestRefinement(secondDeps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(secondDeps);
    expect(secondRequests[0].task).toContain(first.id);
  });

  test('the refiner reads context refs itself — only the files this workspace has, at their real paths', async () => {
    // The lane must offer only paths that exist; the temporary-agent port refuses absent ones.
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

    expect(requests[0].contextRefs).toEqual(['memory/MEMORY.md']);
    expect(requests[0].mode).toBe('plan');

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
    expect(second.requests[0].contextRefs).toEqual(['memory/MEMORY.md', 'AGENTS.md']);
  });

  test('an unparsable or off-schema answer refuses the request — it never half-applies', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('I could not decide. No JSON here.');
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const step = await advanceRefinementLane(deps);

    expect(step.step).toBe('planned');
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
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
    const row = createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id);
    expect(row?.stage).toBe('refused');
    expect(row?.detail).toContain('no roster substrate here');
  });

  test.each([undefined, null])('a host with no refiner (%p) leaves the request `requested` for a host that has one', async (refiner) => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps: RefinementDeps = { ...fx.deps(scriptedRefiner('{}').port), refiner };

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const step = await advanceRefinementLane(deps);
    expect(step.step).toBe('idle');
    expect(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id)?.stage).toBe('requested');
  });
});

/** The brief's example must parse under the schema the refiner is held to. */
describe('the brief and the schema are one contract', () => {
  test('the answer shape the brief prints is a document the schema accepts', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);

    const { port, requests } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    }));

    const deps = fx.deps(port);
    await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const brief = requests[0].task;
    const section = brief.slice(brief.indexOf('## Your answer'));
    expect(section).toContain('## Your answer');

    // A placeholder left in place is a legal value, so the printed document is acceptable as-is.
    const printed = extractJsonObject(section);
    const parsed = v.safeParse(RefinementProposalSchema, printed);
    expect(parsed.success ? 'accepted' : renderIssues(parsed.issues)).toBe('accepted');
    expect(parsed.success && JSON.stringify(parsed.output)).toBe(JSON.stringify(printed));

    for (const kind of REFINEMENT_EDIT_KINDS) expect(section).toContain(`"kind":"${kind}"`);
    expect(section).toContain('"scope":"workspace"');
    // Strictness and the rationale floor are stated, since a shape cannot show them.
    expect(section).toContain('and no others');
    expect(section).toContain(`\`rationale\` is ${String(MIN_EDIT_RATIONALE)} characters or longer`);
  });

  test('an answer missing the required keys is refused, classified, naming every key', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    // One key with no slot, and all three required keys absent.
    const { port } = scriptedRefiner('{"see_rpi":"connected a session to my rpi 5"}');
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');

    expect(row.stage).toBe('refused');

    for (const key of ['scope', 'summary', 'edits', 'see_rpi']) {
      expect(row.detail).toContain(`${key}: Invalid key`);
    }

    // A classified refusal, and nothing written.
    expect(row.detail).toContain('bad_input');
    expect(row.proposal).toBeNull();
    expect(row.routes).toEqual([]);
    expect(fx.facts.all()).toEqual([]);
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

    // The one memory authority holds it.
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(fx.facts.recall('user.answer_length')?.source).toContain(opened.id);

    const row = present(
      createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id),
      'the refinement row',
    );

    const route = routeFor(row.routes, 'fact');
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
      present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row').routes, 'fact',
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

    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    const row = present(store.get(opened.id), 'the refinement row');
    const route = routeFor(row.routes, 'prompt_section');
    expect(route.disposition).toBe('pending_trials');
    expect(route.owner).toBe('prompt_section_versions');
    expect(route.target).toBe(`${TARGET_ID}:1`);
    expect(row.stage).toBe('evaluating');

    // The live prompt is untouched.
    expect(activePromptSectionOverrides(fx.rt.storage.sql, fx.rt.actor)[TARGET_ID]).toBeUndefined();
    expect(buildSystemPromptSync(fx.rt, {
      sectionOverrides: activePromptSectionOverrides(fx.rt.storage.sql, fx.rt.actor),
    })).not.toContain('ASKED.');
  });

  test('a section proposal needs measured behavioural evidence — degeneracy refuses it', async () => {
    const fx = fixture();
    // Accepted turns only: no failure to optimise toward.
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

    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');
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

    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');
    const route = routeFor(row.routes, 'skill');
    expect(route.disposition).toBe('pending_owner_approval');
    expect(route.owner).toBe('instruction_approvals');
    expect(route.target).toBe(BREVITY_PATH);
    // The digest is a field, so settlement compares addresses rather than prose.
    expect(route.digest).toBe(instructionDigest(BREVITY_SKILL));
    expect(row.stage).toBe('evaluating');

    // Nothing under SKILLS_DIR, so the proposal reaches no prompt.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);
    expect(await gatheredSkillPaths(fx.rt)).toEqual([]);
    // Staged where nothing reads them; the owner reads them from the request view.
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity'))).toBe(BREVITY_SKILL);
    expect(refinementStagingPath(opened.id, 'brevity').startsWith(SKILLS_DIR)).toBe(false);
    // Granting is still the owner's act.
    expect(fx.approvals.list()).toEqual([]);

    // Unverified bytes carry no tool policy.
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

      const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');
      const route = routeFor(row.routes, 'skill');
      expect(route.disposition).toBe('refused');
      expect(route.reason).toContain(expected);
      // Nothing was written on any of the three refusals.
      expect(await readSkill(fx.rt, edit.path)).toBeNull();
    }
  });

  test('an existing final file or a standing decision refuses the proposal', async () => {
    const other = `${BREVITY_SKILL}\nSomebody else wrote this.`;

    // (a) the final path already holds bytes.
    const occupied = fixture();
    seedGradedTurns(occupied.rt, 3);
    await writeSkill(occupied.rt, BREVITY_PATH, other);
    const first = occupied.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const a = await requestRefinement(first, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(first);
    const aRoute = routeFor(present(createRefinementStore(occupied.rt.storage.sql, occupied.rt.actor).get(a.id), 'the refinement row').routes, 'skill');
    expect(aRoute.disposition).toBe('refused');
    expect(aRoute.reason).toContain('already exists');
    expect(await readSkill(occupied.rt, BREVITY_PATH)).toBe(other);

    // (b) an approved standing decision, even with no file yet.
    const decided = fixture();
    seedGradedTurns(decided.rt, 3);
    decided.approvals.approve(BREVITY_PATH, instructionDigest(other));
    const second = decided.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const b = await requestRefinement(second, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(second);
    const bRoute = routeFor(present(createRefinementStore(decided.rt.storage.sql, decided.rt.actor).get(b.id), 'the refinement row').routes, 'skill');
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
      present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row').routes, 'skill',
    );

    expect(route.disposition).toBe('refused');
    expect(route.reason).toContain('revoked');
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('the owner approving the exact digest settles the request as applied', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    // Undecided is not a verdict: no clock on the owner.
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    // The owner edited then approved different bytes, so this proposal is not in effect.
    fx.approvals.approve(BREVITY_PATH, instructionDigest(`${BREVITY_SKILL}\nedited.`));
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });

  test('a revocation after the write rolls the request back', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

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
      present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row').routes, 'subagent_spec',
    );

    expect(route.disposition).toBe('refused');
    expect(route.reason).toContain('no writable');
    expect(route.owner).toBe('');
  });

  test('one request table, owning no artifact, in exactly the shape it ships', () => {
    // A bare database, so what this init creates is exactly what is measured.
    const bare = createTestSql();

    const tables = () => bare.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.map((row) => row.name);

    const before = new Set(tables());
    initRefinementTables(bare.execRaw);
    const added = tables().filter((name) => !before.has(name));

    expect(added).toEqual(['refinement_requests']);

    // Names that would betray a second authority for an artifact.
    for (const forbidden of ['skill', 'prompt_section', 'fact', 'subordinate', 'actor_config']) {
      expect(added.some((name) => name.includes(forbidden))).toBe(false);
    }

    // The whole row, `actor_id` first: one workspace database holds several actors' requests.
    expect(bare.sql<{ name: string }>`
      SELECT name FROM pragma_table_info('refinement_requests')`.map((row) => row.name))
      .toEqual([
        'actor_id', 'id', 'trigger', 'scope', 'stage', 'claim', 'session_id', 'turn_ids',
        'debt_key', 'proposal', 'routes', 'detail', 'created_at', 'updated_at',
      ]);
    bare.close();
  });

  test('the request row references its trajectory and never copies a turn', () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 3);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    store.open({ trigger: 'explicit', scope: 'workspace', turnIds: negatives });

    // The row holds ids; turn text stays in `turn_outcomes`.
    const stored = fx.rt.storage.sql<{ turn_ids: string }>`
      SELECT turn_ids FROM refinement_requests`;

    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].turn_ids)).toEqual(negatives);
    expect(stored[0].turn_ids).not.toContain('always answer in one line');
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

    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const { request } = store.open({
      trigger: 'explicit', scope: 'workspace', turnIds: ['neg-0'],
    });

    expect(store.advance(request.id, 'requested', 'planning')).toBe(true);
    expect(store.advance(request.id, 'requested', 'planning')).toBe(false);
    expect(store.get(request.id)?.stage).toBe('planning');
  });

  test('the same debt batch opens exactly one request, however often it is derived', () => {
    const fx = fixture();
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

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
          status: 'completed', agent: 'refiner', lifetime: 'task', role: 'task',
          answer: proposalText(FACT_PROPOSAL),
          transcript: 'kept', elapsed_ms: 1,
        };
      },
      settle: () => false,
    };

    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    // A host died inside the refiner: `planning`, no proposal, nothing routed.
    expect(store.advance(opened.id, 'requested', 'planning')).toBe(true);
    expect(store.get(opened.id)?.proposal).toBeNull();
    expect(store.get(opened.id)?.routes).toEqual([]);

    // Activation recovery owes it again.
    expect(store.resetStalePlanning()).toBe(1);
    expect(store.get(opened.id)?.stage).toBe('requested');

    await advanceRefinementLane(deps);
    expect(runs).toBe(1);
    const row = present(store.get(opened.id), 'the refinement row');
    expect(row.routes).toHaveLength(1);
    // A fact-only proposal reaches applied instead of parking in `gated`.
    expect(row.stage).toBe('applied');
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');

    // Driving the lane again re-applies nothing.
    const again = await advanceRefinementLane(deps);
    expect(again.step).toBe('idle');
    expect(runs).toBe(1);
    expect(fx.facts.all()).toHaveLength(1);
  });

  test('a request abandoned AFTER the refiner answered reuses its plan, never re-asks', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    let runs = 0;

    // A second answer that differs: re-asking on recovery would route a different plan.
    const port: TemporaryAgentPort = {
      run: async () => {
        runs += 1;

        return {
          status: 'completed', agent: 'refiner', lifetime: 'task', role: 'task',
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(runs).toBe(1);
    expect(store.get(opened.id)?.proposal).not.toBeNull();

    // Simulate a death after the plan and the write landed.
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'planning' WHERE id = ${opened.id}`;
    expect(store.resetStalePlanning()).toBe(1);
    await advanceRefinementLane(deps);

    // The plan was reused: no second child agent, no second fact.
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const settledRoutes = present(store.get(opened.id), 'the refinement row').routes;
    expect(settledRoutes).toHaveLength(3);

    // Re-drive from `planning` per completed write; every pass adopts rather than duplicates.
    for (let pass = 0; pass < 3; pass += 1) {
      void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'planning'
        WHERE id = ${opened.id}`;
      store.resetStalePlanning();
      await advanceRefinementLane(deps);

      const routes = present(store.get(opened.id), 'the refinement row').routes;
      expect(routes).toHaveLength(3);
      expect(routeFor(routes, 'fact').disposition).toBe('applied');
      expect(routeFor(routes, 'prompt_section').disposition).toBe('pending_trials');
      // The same pending version every time.
      expect(routeFor(routes, 'prompt_section').target).toBe(
        routeFor(settledRoutes, 'prompt_section').target);
      expect(routeFor(routes, 'skill').disposition).toBe('pending_owner_approval');
      expect(fx.facts.all()).toHaveLength(1);
      // Staged, never promoted, across every re-drive.
      expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
      expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
        .toBe(BREVITY_SKILL);
      expect(listPromptSectionVersions(fx.rt.storage.sql, fx.rt.actor, 50)).toHaveLength(1);
    }
  });

  test('no clock bounds a request — recovery is by activation, never by elapsed time', () => {
    const fx = fixture();
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const { request } = store.open({
      trigger: 'explicit', scope: 'workspace', turnIds: ['neg-0'], now: 1,
    });

    store.advance(request.id, 'requested', 'planning');
    // Recovered because the claim is stale, not because it is old.
    expect(store.resetStalePlanning()).toBe(1);
    expect(store.get(request.id)?.stage).toBe('requested');
  });
});

/**
 * Hosts really deliver two concurrent `advanceRefinementLane` calls (callable plus
 * cadence), and recovery can re-queue a claim mid-refiner because the engine is built
 * lazily. Must hold: one ask per plan, one write per owner, one route set, no elapsed lease.
 */
describe('two passes at once — the claim, and what recovery may not revoke', () => {
  test('two deliveries of the same step run ONE refiner and write each owner once', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const refiner = deferredRefiner(EVERY_OWNER_PROPOSAL);
    const deps = fx.deps(refiner.port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    // The second driver arrives while the first is inside its child agent.
    const nudge = advanceRefinementLane(deps);
    const cadence = advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('planning');
    refiner.release();
    const [first, second] = await Promise.all([nudge, cadence]);

    // The claimer planned; the other found the row taken.
    expect(first.step).toBe('planned');
    expect(second.step).toBe('idle');
    expect(refiner.asks()).toBe(1);

    const row = present(store.get(opened.id), 'the refinement row');
    expect(row.routes).toHaveLength(3);
    expect(row.stage).toBe('evaluating');
    expect(fx.facts.all()).toHaveLength(1);
    expect(listPromptSectionVersions(fx.rt.storage.sql, fx.rt.actor, 50)).toHaveLength(1);
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
      .toBe(BREVITY_SKILL);
    // Nothing went live off a proposal.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(routeFor(row.routes, 'prompt_section').disposition).toBe('pending_trials');
  });

  test('recovery leaves a claim this process is still running alone', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const refiner = deferredRefiner(EVERY_OWNER_PROPOSAL, OTHER_OWNER_PROPOSAL);
    const deps = fx.deps(refiner.port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const inFlight = advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('planning');

    // The real recovery caller: an engine built after the nudge started.
    const recovery = new EvolutionEngine(fx.rt, fx.stores.history, { enabled: false });
    // It recovered its empty review queue and left the live claim alone.
    expect(recovery.sessionWindow.countQueuedReviews()).toBe(0);
    expect(store.get(opened.id)?.stage).toBe('planning');
    expect(store.resetStalePlanning()).toBe(0);

    refiner.release();
    expect((await inFlight).step).toBe('planned');
    // One ask, and its answer was routed.
    expect(refiner.asks()).toBe(1);
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(fx.facts.all()).toHaveLength(1);
    expect(present(store.get(opened.id), 'the refinement row').routes).toHaveLength(3);
    expect(listPromptSectionVersions(fx.rt.storage.sql, fx.rt.actor, 50)).toHaveLength(1);
  });

  test('a claim another process re-queued writes nothing behind its successor', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    const refiner = deferredRefiner(EVERY_OWNER_PROPOSAL, OTHER_OWNER_PROPOSAL);
    const deps = fx.deps(refiner.port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const revoked = advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('planning');

    // A second process cannot tell the claim from a dead one and re-queues it.
    void fx.rt.storage.sql`UPDATE refinement_requests
      SET stage = 'requested', claim = NULL WHERE stage = 'planning'`;

    // The successor plans from a second refiner answer.
    expect((await advanceRefinementLane(deps)).step).toBe('planned');
    expect(refiner.asks()).toBe(2);

    // The revoked pass returns with the first answer against owners the successor wrote.
    refiner.release();
    expect((await revoked).step).toBe('idle');

    const row = present(store.get(opened.id), 'the refinement row');
    expect(row.stage).toBe('evaluating');
    expect(row.routes).toHaveLength(3);
    // One write per owner, all the successor's.
    expect(fx.facts.all()).toHaveLength(1);
    expect(fx.facts.recall('user.answer_shape')?.value).toBe('one line');
    expect(fx.facts.recall('user.answer_length')).toBeNull();
    const versions = listPromptSectionVersions(fx.rt.storage.sql, fx.rt.actor, 50);
    expect(versions).toHaveLength(1);
    expect(versions[0].source).toBe(`${INCUMBENT.slice(0, -6)}BRIEF.`);
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
      .toBe(`${BREVITY_SKILL}\nName the ask.`);
  });

  test('a pass that threw is re-queued by the NEXT pass, in the same process', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    let asks = 0;

    // The port rejects mid-call: the pass unwinds without refusing or recording.
    const port: TemporaryAgentPort = {
      run: async () => {
        asks += 1;

        if (asks === 1) throw new Error('the refiner host went away');

        return {
          status: 'completed', agent: 'refiner-1', lifetime: 'task', role: 'task',
          answer: proposalText(EVERY_OWNER_PROPOSAL), transcript: 'kept', elapsed_ms: 1,
        };
      },
      settle: () => false,
    };

    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await expect(advanceRefinementLane(deps)).rejects.toThrow('the refiner host went away');
    // Left claimed by a dead pass; no owner touched.
    expect(store.get(opened.id)?.stage).toBe('planning');
    expect(fx.facts.all()).toEqual([]);

    // The next pass in this process re-queues and finishes it.
    const step = await advanceRefinementLane(deps);
    expect(step.step).toBe('planned');
    expect(asks).toBe(2);
    const row = present(store.get(opened.id), 'the refinement row');
    expect(row.stage).toBe('evaluating');
    expect(row.routes).toHaveLength(3);
    expect(fx.facts.all()).toHaveLength(1);
    expect(listPromptSectionVersions(fx.rt.storage.sql, fx.rt.actor, 50)).toHaveLength(1);
  });

  test('a claim is live until the pass ends, and never for a length of time', () => {
    const fx = fixture();
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const { request } = store.open({
      trigger: 'explicit', scope: 'workspace', turnIds: ['neg-0'], now: 1,
    });

    const claim = present(store.claim(request.id), 'the planning claim');
    expect(claim.held()).toBe(true);
    // A running pass's claim is never stale, however old.
    expect(store.resetStalePlanning()).toBe(0);
    // Nor may a second pass take it while held.
    expect(store.claim(request.id)).toBeNull();

    claim.release();
    // Once the pass is over, activation owes it again.
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    // The existing lane runs trials and decides; refinement promotes nothing.
    for (let i = 0; i < 20; i += 1) {
      const step = await advancePromptSectionLane(deps.control);

      if (step.step === 'trials' && step.trials.action) break;
    }

    expect(activePromptSectionOverrides(fx.rt.storage.sql, fx.rt.actor)[TARGET_ID]).toBe(CANDIDATE);

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

    // The candidate trials badly: the incumbent wins every paired comparison.
    let proposed = false;

    const deps = fx.deps(port, (candidate) => {
      if (!proposed) return candidate === CANDIDATE ? 0.9 : 0.4;

      return candidate === CANDIDATE ? 0.1 : 0.9;
    });

    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    proposed = true;
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    for (let i = 0; i < 20; i += 1) {
      const step = await advancePromptSectionLane(deps.control);

      if (step.step === 'trials' && step.trials.action) break;
    }

    expect(activePromptSectionOverrides(fx.rt.storage.sql, fx.rt.actor)[TARGET_ID]).toBeUndefined();

    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });
});

describe('evolution debt — the automatic trigger, and its visibility', () => {
  test('debt accumulates from unresolved negative outcomes', () => {
    const fx = fixture();
    expect(evolutionDebt(fx.rt.storage.sql, fx.rt.actor).turnIds).toEqual([]);

    seedGradedTurns(fx.rt, MIN_REFINEMENT_DEBT - 1);
    const shallow = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(shallow.turnIds).toHaveLength(MIN_REFINEMENT_DEBT - 1);
    expect(shallow.owed).toBe(false);
    // Goes red if the module's constant moves without this file's literal.
    expect(shallow.summary).toContain(`opens at ${String(MIN_REFINEMENT_DEBT)}`);

    seedGradedTurns(fx.rt, 1);
    const owed = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    const debt = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);

    const first = await refinementDebtRequest(deps);
    expect(first?.trigger).toBe('evolution_debt');
    expect(first?.stage).toBe('requested');
    expect(first?.turnIds).toEqual(debt.turnIds);

    // Primary guard: the batch is taken, so nothing is owed twice.
    expect(await refinementDebtRequest(deps)).toBeNull();
    expect(store.list()).toHaveLength(1);

    // Second guard: the unique debt key, for a racing derivation.
    const replayed = store.open({
      trigger: 'evolution_debt',
      scope: 'workspace',
      turnIds: debt.turnIds,
      debtKey: debt.key,
    });

    expect(replayed.created).toBe(false);
    expect(replayed.request.id).toBe(present(first, 'the first debt request').id);
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
    const remaining = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(remaining.turnIds).toEqual([]);
    expect(remaining.owed).toBe(false);

    // Fresh failures accrue debt under a different key.
    seedGradedTurns(fx.rt, MIN_REFINEMENT_DEBT, 0);
    const next = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
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
    // A permissive object would drop `scope` and apply the fact workspace-wide.
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

    return routeFor(present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row').routes, 'fact');
  }

  test('a short or few-worded fragment is refused however truly it appears', async () => {
    // Present in every seeded turn, but not evidence of intent.
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
    // Sourced from the agent's own response: refused.
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
      present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row').routes, 'fact',
    );

    expect(route.reason).toContain('always answer in one line');

    const card = buildChangelog(fx.rt.storage.sql, fx.rt.actor, { limit: 50 })
      .find((entry) => entry.id.startsWith(`refinement:${opened.id}`));

    expect(card?.items?.[0]?.evidence).toContain('always answer in one line');
    // The child carries the owner's revert.
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
        FACT_PROPOSAL.edits[0],
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

    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    proposed = true;
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    for (let i = 0; i < 20; i += 1) {
      const step = await advancePromptSectionLane(deps.control);

      if (step.step === 'trials' && step.trials.action) break;
    }

    expect(activePromptSectionOverrides(fx.rt.storage.sql, fx.rt.actor)[TARGET_ID]).toBeUndefined();

    await advanceRefinementLane(deps);
    const settled = present(store.get(opened.id), 'the refinement row');
    // The fact is live, so the request is not rolled_back.
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
    const brief = requests[0].task;

    const split = await buildOutcomeEvalSplit(fx.rt.storage.sql, fx.rt.actor, fx.stores.history.transcript(CHAT_SESSION_ID), EVAL_SIZE);
    expect(split.heldOutNegatives).toBeGreaterThan(0);

    // No val instance may appear in the brief.
    for (const instance of split.val) {
      expect(brief).not.toContain(instance.input);
    }

    // The train half is shown.
    expect(split.train.length).toBeGreaterThan(0);
    expect(brief).toContain(split.train[0].input);
    expect(brief).toContain('WITHHELD');
  });
});

describe('evolution debt pages, and never loses an older row', () => {
  test('a batch is capped, and the remainder is named rather than dropped', () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 20, 0);
    const debt = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);

    expect(debt.turnIds).toHaveLength(12);
    // The oldest twelve.
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

    // A windowed read would see only covered rows and strand the older failures.
    const next = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(next.owed).toBe(true);
    expect(next.turnIds).toEqual(negatives.slice(12));
    expect(next.key).not.toBe(present(first, 'the first debt request').turnIds.join(''));

    const second = await refinementDebtRequest(deps);
    expect(second?.id).not.toBe(present(first, 'the first debt request').id);
    expect(second?.turnIds).toEqual(negatives.slice(12));
    expect(evolutionDebt(fx.rt.storage.sql, fx.rt.actor).owed).toBe(false);
  });

  test('a covered batch newer than an uncovered one does not hide it', () => {
    const fx = fixture();
    const { negatives: older } = seedGradedTurns(fx.rt, 3, 0);
    const { negatives: newer } = seedGradedTurns(fx.rt, 14, 0);
    // A request takes the newest rows explicitly.
    createRefinementStore(fx.rt.storage.sql, fx.rt.actor).open({
      trigger: 'explicit', scope: 'workspace', turnIds: newer,
    });

    const debt = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
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

    // No child agent spent; the lane skips a refused row.
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
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

    // Promoted already trusted, never briefly live-but-unverified.
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

    // The crash window: approval landed, promotion did not.
    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL));
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    // Nothing discovers a path with no file.
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);

    // Whoever looks next completes it.
    await advanceRefinementLane(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
    expect(fx.approvals.trustOf(BREVITY_PATH, BREVITY_SKILL)).toBe('approved');
    expect(await readSkill(fx.rt, staged)).toBeNull();
    expect(store.get(id)?.stage).toBe('applied');

    // Idempotent.
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

    // `show` reports the drift, so the token check refuses first.
    const shown = await showRefinementRoute(deps, { requestId: id, routeIndex: 0 });
    expect(shown.ok === true && shown.view.intact).toBe(false);

    const drifted = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0,
      expectedDigest: shown.ok === true ? shown.view.digest : '',
      decision: 'approve',
    });

    expect(drifted.ok).toBe(false);
    expect(drifted.ok === false && drifted.error).toContain('not the edit you were shown');

    // The original token is refused at the staging check.
    const result = await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: instructionDigest(BREVITY_SKILL), decision: 'approve',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('changed since they were proposed');
    // Nothing trusted or promoted.
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
    // Left staged, so the collision is recoverable.
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
    const settled = present(store.get(id), 'the refinement row');
    expect(settled.stage).toBe('rolled_back');
    expect(settled.detail).toContain('rejected by you');
  });

  test('an undecided proposal waits forever — no clock, no default', async () => {
    const { fx, deps, store, id } = await stagedFixture();
    // Only the owner ends a pending request.
    void fx.rt.storage.sql`UPDATE refinement_requests SET created_at = 1, updated_at = 1
      WHERE id = ${id}`;

    for (let i = 0; i < 10; i += 1) {
      expect((await advanceRefinementLane(deps)).step).toBe('idle');
    }

    expect(store.get(id)?.stage).toBe('evaluating');
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('every way a decision reference can be wrong is refused by name', async () => {
    // (a) a settled request.
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

    // (b) routes not made yet.
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

    // (c) only the staged skill is decidable.
    const mixed = fixture();
    seedGradedTurns(mixed.rt, 3);

    const mixedDeps = mixed.deps(scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'a preference and a skill',
      edits: [FACT_PROPOSAL.edits[0], skillProposal(BREVITY_SKILL).edits[0]],
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

    // (d) bad edit index, bad request id, wrong digest token.
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
    // Nothing granted.
    expect(mixed.approvals.list()).toEqual([]);
    expect(await readSkill(mixed.rt, BREVITY_PATH)).toBeNull();
  });

  test('a decided row is not offered again', async () => {
    const { deps, id } = await stagedFixture();
    const digest = instructionDigest(BREVITY_SKILL);
    expect((await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: digest, decision: 'reject',
    })).ok).toBe(true);

    // A `rejected` row has nothing left to show or decide.
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
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('applied');

    // Killed between routing and settle: `gated` with the fact written.
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'gated' WHERE id = ${opened.id}`;
    const step = await advanceRefinementLane(deps);
    expect(step.step).toBe('settled');
    expect(store.get(opened.id)?.stage).toBe('applied');
  });
});

describe('promotion never half-lands — the read-back is what allows the unlink', () => {
  /** A file plane whose write of one path misbehaves. */
  function saboteur(
    rt: AgentRuntime,
    path: string,
    mode: 'throw' | 'tear',
  ): () => void {
    const vfs = rt.agentStateVfs ?? rt.storage.vfs;
    const real = vfs.writeFile.bind(vfs);
    vfs.writeFile = async (written: string, data: string | Uint8Array) => {
      if (written !== path) return real(written, data);

      if (mode === 'throw') throw new Error('disk full');

      // A torn write.
      return real(written, `${data instanceof Uint8Array ? '' : data}\ntruncated`);
    };

    return () => { vfs.writeFile = real; };
  }

  async function staged() {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
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

    // The trust row alone is harmless; the bytes stay staged.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);
    // The request keeps waiting with the reason.
    expect(present(store.get(id), 'the refinement row').routes[0]?.disposition).toBe('pending_owner_approval');

    // After repair, the next settle finishes.
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

    // The torn file is not ours to delete; the mismatch is surfaced.
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    expect(present(store.get(id), 'the refinement row').routes[0]?.disposition).toBe('pending_owner_approval');

    // A later settle refuses to overwrite unapproved bytes.
    stop();
    await advanceRefinementLane(deps);
    const row = present(store.get(id), 'the refinement row');
    expect(row.stage).toBe('evaluating');
    expect(row.detail).toContain('not the approved ones');
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
  });

  test('a foreign file appearing at the target after approval is never overwritten', async () => {
    const { fx, deps, store, id, path } = await staged();
    // Approved, not yet promoted.
    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL));
    // Somebody else writes there in the window.
    const foreign = `${BREVITY_SKILL}\nsomebody else got here first.`;
    await writeSkill(fx.rt, BREVITY_PATH, foreign);

    await advanceRefinementLane(deps);
    // Their bytes stand, ours stay staged.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(foreign);
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    const row = present(store.get(id), 'the refinement row');
    expect(row.stage).toBe('evaluating');
    expect(row.detail).toContain('refusing to overwrite');
  });

  test('a revocation discards the staging as well as rolling back', async () => {
    const { fx, deps, store, id, path } = await staged();
    fx.approvals.revoke(BREVITY_PATH);

    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('rolled_back');
    // Staging that will never be promoted is removed.
    expect(await readSkill(fx.rt, path)).toBeNull();
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('an owner decision survives a plan re-drive', async () => {
    const { fx, deps, store, id } = await staged();
    const digest = instructionDigest(BREVITY_SKILL);
    expect((await decideRefinementRoute(deps, {
      requestId: id, routeIndex: 0, expectedDigest: digest, decision: 'reject',
    })).ok).toBe(true);

    // A crash drags the row back to `planning`.
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'planning' WHERE id = ${id}`;
    store.resetStalePlanning();
    await advanceRefinementLane(deps);

    // The rejection stands; the owner is not asked again.
    expect(present(store.get(id), 'the refinement row').routes[0]?.disposition).toBe('rejected');
    expect(await readSkill(fx.rt, refinementStagingPath(id, 'brevity'))).toBeNull();
    expect(store.get(id)?.stage).toBe('rolled_back');
  });

  test('show returns the WHOLE file, never a preview', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    // Far past any card's excerpt budget.
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

    // The card is bounded.
    const card = buildChangelog(fx.rt.storage.sql, fx.rt.actor, { limit: 50 })
      .find((entry) => entry.id.startsWith(`refinement:${opened.id}`));

    expect(card?.items?.[0]?.evidence.length).toBeLessThan(long.length);
    expect(card?.items?.[0]?.evidence).toContain('chars');
  });
});
