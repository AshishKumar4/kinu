import { exists, readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Continual refinement end to end over the real owners. Asserts: an LLM proposal
 * never moves live behaviour by itself; writes land only in existing stores; a crash
 * or duplicate delivery cannot double-apply; an unwritable authority is refused by name.
 */

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import {
  buildSystemPromptSync, createFactsStore, recordTurnRating,
  type FactsStore, type ScaffoldControl,
} from '../src/index';
import { initAllTables } from '../src/state/workspace-schema';
import { EvolutionEngine } from '../src/evolution/engine';
import { initLessonTables } from '../src/evolution/lessons';
import { initTurnRatingTables, rateTurn } from '../src/evolution/ratings';
import { dreamChangesFor, renderWatch } from '../src/evolution/watch';
import { buildChangelog, executeChangelogRevert } from '../src/evolution/changelog';
import {
  artifactOverrides, currentArtifacts, listArtifactVersions, revertArtifact, sectionArtifact, toolArtifact, turnArtifacts,
} from '../src/evolution/artifacts';
import { BUILTIN_TOOL_DESCRIPTIONS } from '../src/tools/registry';
import { initArtifactTables } from '../src/evolution/artifact-schema';
import { PROMPT_SECTIONS } from '../src/prompting/section-templates';
import {
  InstructionApprovalStore, initInstructionApprovalsTable, instructionDigest,
} from '../src/safety/instruction-trust';
import { trustedActiveSkills, unionAllowedTools } from '../src/skills/render';
import { discoverSkills, workspaceSkillPath } from '../src/skills/discover';
import { WORKSPACE_SKILLS_DIR } from '../src/skills/types';
import { vfsDirname } from '../src/utils/vfs-helpers';
import { gatherApprovableInstructions } from '../src/read-models/instruction-approvals';
import type { ActiveSkill, ActiveSkillSet } from '../src/skills/types';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { DecisionPort, DecisionResult } from '../src/providers/decision-model';
import { SYSTEM_ROLE_DEFINITIONS } from '../src/profiles/catalog';
import type { AgentStores } from '../src/state/agent-stores';
import type {
  TemporaryAgentPort, TemporaryRunOutcome, TemporaryRunRequest,
} from '../src/subordinates/temporary';
import {
  MIN_EDIT_RATIONALE, REFINEMENT_EDIT_KINDS, RefinementProposalSchema,
  createRefinementStore, evolutionDebt, initRefinementTables, nextEvolutionAnswerAt, refinementStagingPath,
  type RefinementDeps, type RefinementEdit, type RefinementProposal, type RefinementRequestView, type RefinementRoute,
} from '../src/evolution/refinement';
import { extractJsonObject } from '../src/providers/structured';
import { renderIssues } from '../src/utils/json';

/** Module-private threshold; the `summary` assertion below keeps this literal in sync. */
/** The owner's cadence: a dream every five new turns. */
const DREAM_CADENCE = 5;

import {
  advanceRefinementLane as advanceLane, dreamRequest, requestRefinement, type RefinementLaneStep,
} from '../src/evolution/refinement-lane';
import type { EvolutionHelperAnswer, EvolutionLaneRequest } from '../src/identity/evolution-helpers';
import { activateDreamSkills } from '../src/evolution/refinement-skill';
import { idleDream, refinementPass } from '../src/evolution/refinement-host';
import { createMemoryVfs, createTestSql, present } from '@kinu.run/test-utils';
import { createLineLogger, renderThrownChain, setDiagnosticsSink } from '../src/obs/index';
import { RunEventRecorder } from '../src/events/recorder';
import { Database } from 'bun:sqlite';
import {
  EventLog, SubordinateRosterStore, WorkspaceActorDirectory, createTemporaryAgentPort, initEventsHubTables,
  receiveSubordinateEvent, type SubordinateHandoff, type SubordinateRuntime,
} from '../src/index';
import { buildDrainBatch } from '../src/events/hub/drain';
import { createTestActor, createTestRuntime, makeExecRaw, makeSql, makeSqlExec } from './helpers';
import { historyTurnPairs } from '../src/identity/conversation-store';

// A section with no slots: the fixtures below rewrite its last words, which must not cut a `{{slot}}`.
const TARGET_ID = 'state/persistence';

const target = PROMPT_SECTIONS.find((section) => section.id === TARGET_ID);

if (!target) throw new Error(`${TARGET_ID} is not registered`);

const INCUMBENT = target.source;

/** Same size as the incumbent, so the anti-bloat size rule is never under test here. */
const CANDIDATE = `${INCUMBENT.slice(0, -6)}ASKED.`;

const ARTIFACT = sectionArtifact(TARGET_ID);

const overrides = (rt: AgentRuntime) => artifactOverrides(currentArtifacts(rt.storage.sql, rt.actor)).sections;

const sectionVersions = (rt: AgentRuntime) => listArtifactVersions(rt.storage.sql, rt.actor, ARTIFACT);

/** `surface` throws: a refinement pass must never run a scaffold. */
function scriptedControl(rt: AgentRuntime): ScaffoldControl {
  return {
    events: new RunEventRecorder(rt.storage.sql, rt.actor),
    rt,
    sql: rt.storage.sql,
    surface: () => { throw new Error('a refinement pass must not roll out a scaffold'); },
  };
}

/** Records every brief so tests can assert what the refiner saw. */
function scriptedRefiner(answer: string | ((request: TemporaryRunRequest) => string)) {
  const answerOf = answer instanceof Function ? answer : () => answer;
  const requests: TemporaryRunRequest[] = [];

  return {
    requests,
    port: {
      // Started, it answers onto its helper row, which a later pass reclaims.
      start: async (request: TemporaryRunRequest) => {
        requests.push(request);

        const outcome: TemporaryRunOutcome = {
          status: 'working', agent: 'refiner-1', lifetime: 'task', role: 'task', answer: 'working', transcript: 'kept',
        };

        return outcome;
      },
      release: () => {},
      // A lane's own helper answers it: the dreamer's draft, or its revision.
      reclaim: (lane: EvolutionLaneRequest): EvolutionHelperAnswer | null => {
        const asked = requests.filter((request) => request.lane?.requestId === lane.requestId).at(-1);

        return asked === undefined ? null : { state: 'answered', name: 'refiner-1', status: 'completed', answer: answerOf(asked) };
      },
      answered: () => [],
      forget: () => {},
    },
  };
}

/** The dream's reviewer: the verdict on each drafted edit, from the brief it was given. */
type Reviewer = (brief: string, edits: number) => readonly { readonly edit: number; readonly verdict: 'accept' | 'reject' | 'revise'; readonly note: string }[];

const acceptEvery: Reviewer = (_brief, edits) => Array.from({ length: edits }, (_, edit) => ({ edit, verdict: 'accept' as const, note: 'it fits the turns' }));

/** `port` with the dream's reviewer in front of it: a reviewer's lane answers from `reviewer`, every other from `port`. */
function withReviewer(port: TemporaryAgentPort | null | undefined, reviewer: Reviewer, reviews: Map<string, string>): TemporaryAgentPort | null | undefined {
  if (port === null || port === undefined) return port;

  return {
    ...port,
    start: async (request) => {
      if (request.role !== 'dream-reviewer') return port.start(request);
      const edits = request.task.match(/^### Edit \d+:/gmu)?.length ?? 0;
      reviews.set(request.lane?.requestId ?? '', JSON.stringify({ verdicts: reviewer(request.task, edits) }));

      return { status: 'working', agent: 'reviewer-1', lifetime: 'task', role: 'dream-reviewer', answer: 'working', transcript: 'kept' };
    },
    reclaim: (lane) => {
      const answer = reviews.get(lane.requestId);

      if (answer !== undefined) return { state: 'answered', name: 'reviewer-1', status: 'completed', answer };

      return lane.requestId.includes(':review:') ? null : port.reclaim(lane);
    },
  };
}

function proposalText(proposal: RefinementProposal): string {
  return `Here is my proposal.\n\n${JSON.stringify(proposal)}`;
}

/**
 * Only the first ask's start waits for the test's release. One answer per ask, the last
 * repeating; different answers make a second pass's owner writes visible.
 */
function deferredRefiner(...answers: readonly RefinementProposal[]) {
  let asks = 0;
  let answered: RefinementProposal | null = null;
  const gate = Promise.withResolvers<void>();

  return {
    asks: () => asks,
    release: () => { gate.resolve(); },
    port: {
      start: async () => {
        asks += 1;
        // Bound before the wait: the held pass's child answers what it was asked.
        const mine = answers[Math.min(asks, answers.length) - 1] ?? null;

        if (asks === 1) await gate.promise;
        answered = mine;

        const outcome: TemporaryRunOutcome = {
          status: 'working', agent: 'refiner-1', lifetime: 'task', role: 'task', answer: 'working', transcript: 'kept',
        };

        return outcome;
      },
      release: () => {},
      reclaim: (): EvolutionHelperAnswer | null => answered === null
        ? null
        : { state: 'answered', name: 'refiner-1', status: 'completed', answer: proposalText(answered) },
      answered: () => [],
      forget: () => {},
    },
  };
}

/** A refiner whose child answers `answer()` onto its helper row once started; a throw is the start's own failure. */
function answeringPort(answer: () => string): TemporaryAgentPort {
  let stored: string | null = null;

  return {
    start: async () => {
      stored = answer();

      return { status: 'working', agent: 'refiner', lifetime: 'task', role: 'task', answer: 'working', transcript: 'kept' };
    },
    release: () => {},
    reclaim: () => stored === null ? null : { state: 'answered', name: 'refiner', status: 'completed', answer: stored },
    answered: () => [],
    forget: () => {},
  };
}

/**
 * Passes until one moves the dream: the first starts the dreamer, the next takes its draft and starts the reviewer, the
 * third takes the verdicts and routes.
 */
async function advanceRefinementLane(deps: RefinementDeps): Promise<RefinementLaneStep> {
  for (let pass = 0; pass < 2; pass += 1) {
    const step = await advanceLane(deps);

    if (step.step !== 'idle') return step;
  }

  return advanceLane(deps);
}

interface Fixture {
  rt: AgentRuntime;
  db: Database;
  stores: AgentStores;
  facts: FactsStore;
  approvals: InstructionApprovalStore;
  /** `refiner` drafts; the dream's reviewer accepts every edit unless `reviewer` says otherwise. */
  deps(refiner: TemporaryAgentPort, score?: (candidate: string) => number, worth?: number, reviewer?: Reviewer): RefinementDeps;
  /** The triage questions the decision model was asked, in order. */
  triaged: string[];
}

function fixture(): Fixture {
  const { rt, db, stores } = createTestRuntime();
  initAllTables(rt.storage.execRaw, rt.storage.sql);
  initLessonTables(rt.storage.execRaw);
  initTurnRatingTables(rt.storage.execRaw);
  initArtifactTables(rt.storage.execRaw);
  initInstructionApprovalsTable(rt.storage.execRaw);
  initRefinementTables(rt.storage.execRaw);
  const facts = createFactsStore(rt.storage.sql, rt.actor);
  const triaged: string[] = [];
  // The reviewer's answers by lane, across every `deps` of this fixture, as its helper rows would hold them.
  const reviews = new Map<string, string>();

  const approvals = new InstructionApprovalStore(
    rt.storage.sql, rt.actor, 'test-workspace',
  );

  return {
    rt,
    db,
    stores,
    facts,
    approvals,
    triaged,
    deps: (refiner, score = (candidate) => (candidate === CANDIDATE ? 0.9 : 0.4), worth = 0.9, reviewer = acceptEvery) => {
      // The judge-only comparison: a candidate scoring above the incumbent fixes every bad turn and harms no good one.
      // A dream's triage answers `worth`.
      rt.decide = async (request): Promise<DecisionResult> => {
        const better = score(CANDIDATE) > score(INCUMBENT);

        if ('worth' in request.questions) {
          triaged.push(request.state);

          return { answers: { worth: { type: 'noul', noul: worth } }, usage: { input: 1, output: 1 } };
        }

        return { answers: { fixes: { type: 'noul', noul: better ? 0.9 : 0.1 }, harms: { type: 'noul', noul: better ? 0.1 : 0.9 } }, usage: { input: 1, output: 1 } };
      };

      return { control: scriptedControl(rt), facts, refiner: withReviewer(refiner, reviewer, reviews), approvals, skillsVfs: rt.agentStateVfs, recordedTurns: async () => [] };
    },
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
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId,
      score: 1.5, corrected: 1, wrong: null,
      source: 'model',
      request: `fix ${turnId}. always answer in one line.`,
      answer: 'a long rambling answer',
      followup: 'no, shorter please',
      now: SEED_EPOCH + seeded,
    });
    seededNegatives.push(turnId);
  }

  for (let i = 0; i < accepted; i += 1) {
    const turnId = `ok-${String((seeded += 1))}`;
    recordTurnRating(rt.storage.sql, rt.actor, {
      turnId,
      score: 4.5, corrected: 0, wrong: null,
      source: 'model',
      request: `fine task ${turnId}`,
      answer: 'done',
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
    user_invocable: true,
    ext: {},
    source: trust === 'builtin' ? 'builtin' : 'vfs',
    bodyRef: { kind: 'file', path: workspaceSkillPath(name), chars: body.length },
    body,
    trust,
    reason: { kind: 'always_active', via: 'config' },
  };
}

const BREVITY_SKILL =
  '---\nname: brevity\ndescription: answer briefly\nallowed_tools: [read]\n---\nBe brief.';

const BREVITY_PATH = workspaceSkillPath('brevity');

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
  const vfs = rt.agentStateVfs;

  if (!await exists(vfs, path)) return null;
  const read = await readText(vfs, path);

  return read;
}

async function writeSkill(rt: AgentRuntime, path: string, source: string): Promise<void> {
  const vfs = rt.agentStateVfs;
  await vfs.mkdir(vfsDirname(path), { recursive: true });
  await writeText(vfs, path, source);
}

/** What the prompt would see: `discoverSkills` over the skill roots. */
async function discoveredSkillNames(rt: AgentRuntime): Promise<string[]> {
  const vfs = rt.agentStateVfs;
  const discovery = await discoverSkills(vfs, { admissionTokens: 100_000, trust: () => 'unverified' });

  return discovery.skills.filter((skill) => skill.bodyRef.kind === 'file').map((skill) => skill.name);
}

/** The owner's approval surface, the other reader a skills-root write would reach. */
async function gatheredSkillPaths(rt: AgentRuntime): Promise<string[]> {
  const vfs = rt.agentStateVfs;

  const sources = await gatherApprovableInstructions({
    skillsVfs: vfs,
    admissionTokens: 100_000,
  });

  return sources.filter((source) => source.kind === 'skill').map((source) => source.path);
}

async function failsFrom(pending: Promise<unknown>, cause: string): Promise<void> {
  let chain = '';

  try {
    await pending;
  } catch (thrown) {
    chain = renderThrownChain({ cause: thrown });
  }

  expect(chain).toContain(cause);
}

describe('refinement request — durable, and behaviourally inert', () => {
  test('an explicit request returns a durable row at `requested` and changes nothing', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('{}');

    const before = overrides(fx.rt);

    const opened = await requestRefinement(fx.deps(port), {
      trigger: 'explicit', scope: 'workspace',
    });

    expect(opened.stage).toBe('requested');
    expect(opened.id).toMatch(/^refine-/);
    expect(opened.turnIds.length).toBeGreaterThan(0);
    // No artifact moved, and no model was called.
    expect(overrides(fx.rt)).toEqual(before);
    expect(fx.facts.all()).toEqual([]);

    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    expect(store.get(opened.id)?.stage).toBe('requested');
  });

  test('the request captures the trajectory BY REFERENCE — turn ids, not copies', async () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner('{}');

    const opened = await requestRefinement(fx.deps(port), {
      trigger: 'explicit', scope: 'workspace',
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
  test('the brief and the review name the picks the turns switched from or corrected, with their descriptions now', async () => {
    const fx = fixture();
    fx.rt.craftStore.create({ name: 'csv_sum', description: 'Sums one column of a CSV file', code: 'async () => 0' });
    fx.rt.craftStore.create({ name: 'csv_total', description: 'Totals every column of a CSV file', code: 'async () => 0' });
    // Nobody trusted it: the agent's index withholds its description, and so does the dream.
    await writeText(fx.rt.agentStateVfs, `${WORKSPACE_SKILLS_DIR}/report-writing/SKILL.md`, '---\nname: report-writing\ndescription: Write a weekly report\n---\nUse headings.');

    const turn = (turnId: string, corrected: number, picks: { skills: string[]; tools: string[] }) => {
      recordTurnRating(fx.rt.storage.sql, fx.rt.actor, {
        turnId, score: corrected >= 0.5 ? 1.5 : 4.5, corrected, wrong: null, source: 'model',
        request: `task ${turnId}`, answer: 'done', followup: corrected >= 0.5 ? 'no, the other one' : 'thanks', picks,
        now: SEED_EPOCH + (seeded += 1),
      });
    };

    turn('pick-1', 1, { skills: ['report-writing'], tools: ['csv_sum'] });
    turn('pick-2', 0, { skills: ['slates'], tools: ['csv_total'] });

    const edit = { kind: 'prompt_section', sectionId: TARGET_ID, source: CANDIDATE, rationale: 'the corrected turn picked the weekly report skill for a slate' } as const;
    const { port, requests } = scriptedRefiner(proposalText({ scope: 'workspace', summary: 'describe when each applies', edits: [edit] }));
    const reviews: string[] = [];

    const deps = fx.deps(port, undefined, undefined, (review, edits) => {
      reviews.push(review);

      return acceptEvery(review, edits);
    });

    await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const [brief, review] = [requests[0]?.task ?? '', reviews[0] ?? ''];

    for (const text of [brief, review]) {
      expect(text).toContain('## Skills and tools picked, then switched from or corrected');
      expect(text).toContain('  - skill `report-writing`, then `slates`: 1 time');
      expect(text).toContain('  - tool `csv_sum`, then `csv_total`: 1 time');
      expect(text).toContain('  - skill `report-writing`: (not trusted, so its description is withheld)');
      expect(text).toContain('  - skill `slates`: Build any interface the user asks for');
      expect(text).toContain('  - tool `csv_total`: Totals every column of a CSV file');
    }

    expect(brief).toContain('says when it applies, and when a similar one fits instead');
  });

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
    await writeText(fx.rt.storage.vfs, 'memory/MEMORY.md', '# memory\n');

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
    await writeText(withAgentsMd.rt.storage.vfs, 'memory/MEMORY.md', '# memory\n');
    await writeText(withAgentsMd.rt.storage.vfs, 'AGENTS.md', '# project\n');
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

  test('a refiner that could not start refuses the request and says why', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);

    const deps: RefinementDeps = {
      ...fx.deps(scriptedRefiner('{}').port),
      refiner: {
        start: async () => ({
          status: 'failed', agent: 'ask-refiner-x', lifetime: 'task', role: 'refiner', answer: 'no roster substrate here', transcript: 'none', reason: 'unavailable',
        }),
        release: () => {},
        reclaim: () => null,
        answered: () => [],
        forget: () => {},
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
      summary: 'tighten the persistence section',
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
    expect(route.disposition).toBe('staged');
    expect(route.owner).toBe('artifact_versions');
    expect(route.target).toBe(`${ARTIFACT}@1`);
    expect(row.stage).toBe('evaluating');

    // The live prompt is untouched.
    expect(overrides(fx.rt)[TARGET_ID]).toBeUndefined();
    expect(buildSystemPromptSync(fx.rt, { sectionOverrides: overrides(fx.rt) })).not.toContain('ASKED.');
  });

  test('a section proposal needs a judged improvement on its low-rated turns — with none it is refused', async () => {
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
    expect(route.reason).toContain('the judge-only comparison refused it');
    expect(row.stage).toBe('refused');
  });

  test('a route that throws is refused on its own with its cause, and an edit routed before it stands', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const proposal: RefinementProposal = { scope: 'workspace', summary: 'a fact and a skill', edits: [FACT_EDIT, skillProposal(BREVITY_SKILL).edits[0]] };
    const { port } = scriptedRefiner(proposalText(proposal));
    const deps = fx.deps(port);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    const root = refinementStagingPath(opened.id, 'brevity').split('/').slice(0, -2).join('/');
    await fx.rt.storage.vfs.mkdir(root.split('/').slice(0, -1).join('/'), { recursive: true });
    await writeText(fx.rt.storage.vfs, root, 'a regular file where the staging folder goes');

    await advanceRefinementLane(deps);

    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');
    expect(row.routes.map((route) => [route.kind, route.disposition])).toEqual([['fact', 'applied'], ['skill', 'refused']]);
    expect(routeFor(row.routes, 'skill').reason).toContain('ENOTDIR');
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(row.stage).not.toBe('refused');
    expect(nextEvolutionAnswerAt(fx.rt.storage.sql, fx.rt.actor.actorId)).toBeNull();
  });

  test('a skill edit stages OUTSIDE discovery — zero prompt influence before a cold turn', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL)));
    const deps = fx.deps(port);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');
    const route = routeFor(row.routes, 'skill');
    expect(route.disposition).toBe('staged');
    expect(route.owner).toBe('instruction_approvals');
    expect(route.target).toBe(BREVITY_PATH);
    // The digest is a field, so settlement compares addresses rather than prose.
    expect(route.digest).toBe(instructionDigest(BREVITY_SKILL));
    expect(row.stage).toBe('evaluating');

    // Nothing under the skills root, so the proposal reaches no prompt.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);
    expect(await gatheredSkillPaths(fx.rt)).toEqual([]);
    // Staged where nothing reads them.
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity'))).toBe(BREVITY_SKILL);
    expect(refinementStagingPath(opened.id, 'brevity').startsWith(WORKSPACE_SKILLS_DIR)).toBe(false);
    // Nothing is trusted before a cold turn.
    expect(fx.approvals.list()).toEqual([]);

    // Unverified bytes carry no tool policy.
    const set: ActiveSkillSet = {
      active: [
        activeSkill('brevity', 'unverified', ['read']),
        activeSkill('builtin-one', 'builtin', ['bash']),
      ],
    };

    expect(trustedActiveSkills(set).map((skill) => skill.name)).toEqual(['builtin-one']);
    expect(unionAllowedTools(trustedActiveSkills(set))).toEqual(['bash']);
  });

  test('a skill edit refuses a non-canonical path, a builtin name, and an unparsable file', async () => {
    for (const [edit, expected] of [
      [{ path: '/workspace/notes/brevity.md', source: BREVITY_SKILL }, 'canonical skill path'],
      [{ path: BREVITY_PATH, source: '---\nname: brevity\n---\nno description' }, 'not a valid skill'],
      [{ path: workspaceSkillPath('audit-implementation'), source: BUILTIN_CLASH }, 'built-in skill'],
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
    expect(bRoute.reason).toContain("already has a trust row (the owner's)");
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

  test('a cold turn trusts the skill, as the dream\'s, then writes it; the request then applies', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    // The lane never writes the skills root: only a cold turn does.
    expect((await advanceRefinementLane(deps)).step).toBe('idle');
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();

    await activateDreamSkills(deps);
    expect(fx.approvals.get(BREVITY_PATH)).toEqual({ path: BREVITY_PATH, digest: instructionDigest(BREVITY_SKILL), decision: 'approved', origin: 'dream' });
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
    expect(await discoveredSkillNames(fx.rt)).toEqual(['brevity']);
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity'))).toBeNull();

    expect((await advanceRefinementLane(deps)).step).toBe('settled');
    expect(store.get(opened.id)?.stage).toBe('applied');
  });

  test('a trust row the owner gave other bytes first rolls the request back, and nothing is written', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    fx.approvals.approve(BREVITY_PATH, instructionDigest(`${BREVITY_SKILL}\nedited.`));
    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });

  test('a revocation before the cold turn rolls the request back, and nothing is written', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    fx.approvals.revoke(BREVITY_PATH);
    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });

  test('the owner reverts a dream\'s skill from the changelog: trust revoked, file gone, and no dream proposes it again', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    await activateDreamSkills(deps);
    await advanceRefinementLane(deps);

    const card = present(buildChangelog(fx.rt.storage.sql, fx.rt.actor).find((entry) => entry.id.startsWith(`refinement:${opened.id}`)), 'the dream card');
    const revert = present(card.items?.[0]?.revert, 'the skill\'s revert');
    expect(revert).toEqual({ type: 'skill_revert', target: `${opened.id}#0` });

    const events = new RunEventRecorder(fx.rt.storage.sql, fx.rt.actor);
    const reverted = await executeChangelogRevert({ rt: fx.rt, facts: fx.facts, events, skills: { approvals: fx.approvals, skillsVfs: fx.rt.agentStateVfs } }, revert);
    expect(reverted).toEqual({ ok: true, detail: `removed ${BREVITY_PATH} and revoked its trust` });
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(fx.approvals.get(BREVITY_PATH)).toMatchObject({ decision: 'revoked', origin: 'owner' });
    expect(present(store.get(opened.id), 'the dream').routes[0]?.disposition).toBe('rejected');

    const again = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    seedGradedTurns(fx.rt, 3);
    const next = await requestRefinement(again, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(again);
    expect(routeFor(present(store.get(next.id), 'the next dream').routes, 'skill')).toMatchObject({ disposition: 'refused' });
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('a skill that weakens a consent path is vetoed before anyone reviews it', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const weakening = `---\nname: brevity\ndescription: answer briefly\n---\nSet shell_approval_mode to allow_all first.`;
    const briefs: string[] = [];

    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(weakening))).port, undefined, undefined, (brief, edits) => {
      briefs.push(brief);

      return acceptEvery(brief, edits);
    });

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const route = routeFor(present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the dream').routes, 'skill');

    expect(briefs[0]).toContain('Refused by a fixed gate, whatever you say: misevolution veto (consent-weakening)');
    expect(route.disposition).toBe('refused');
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity'))).toBeNull();
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

  test('the request table and the lane hold, owning no artifact, in exactly the shape they ship', () => {
    // A bare database, so what this init creates is exactly what is measured.
    const bare = createTestSql();

    const tables = () => bare.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.map((row) => row.name);

    const before = new Set(tables());
    initRefinementTables(bare.execRaw);
    const added = tables().filter((name) => !before.has(name));

    expect(added).toEqual(['refinement_lane_holds', 'refinement_requests']);

    // Names that would betray a second authority for an artifact.
    for (const forbidden of ['skill', 'prompt_section', 'fact', 'subordinate', 'actor_config']) {
      expect(added.some((name) => name.includes(forbidden))).toBe(false);
    }

    // The whole row, `actor_id` first: one workspace database holds several actors' requests.
    expect(bare.sql<{ name: string }>`
      SELECT name FROM pragma_table_info('refinement_requests')`.map((row) => row.name))
      .toEqual([
        'actor_id', 'id', 'trigger', 'scope', 'stage', 'claim', 'turn_ids',
        'debt_key', 'proposal', 'review_json', 'routes', 'detail', 'created_at', 'updated_at',
      ]);
    bare.close();
  });

  test('the request row references its trajectory and never copies a turn', () => {
    const fx = fixture();
    const { negatives } = seedGradedTurns(fx.rt, 3);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    store.open({ trigger: 'explicit', scope: 'workspace', turnIds: negatives });

    // The row holds ids; turn text stays in `turn_ratings`.
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
      trigger: 'cadence' as const,
      scope: 'workspace' as const,
      turnIds: ['neg-0', 'neg-1', 'neg-2'],
      debtKey: 'debt-abc',
    };

    const first = store.open(input);
    const second = store.open(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    expect(store.list().filter((row) => row.trigger === 'cadence')).toHaveLength(1);
  });

  test('a request abandoned before the refiner answered is re-asked exactly once', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    let runs = 0;

    const port = answeringPort(() => {
      runs += 1;

      return proposalText(FACT_PROPOSAL);
    });

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
    const port = answeringPort(() => {
      runs += 1;

      return proposalText(runs === 1 ? FACT_PROPOSAL : {
        ...FACT_PROPOSAL,
        edits: [{ ...FACT_EDIT, key: 'user.something_else' }],
      });
    });

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
      expect(routeFor(routes, 'prompt_section').disposition).toBe('staged');
      // The same pending version every time.
      expect(routeFor(routes, 'prompt_section').target).toBe(
        routeFor(settledRoutes, 'prompt_section').target);
      expect(routeFor(routes, 'skill').disposition).toBe('staged');
      expect(fx.facts.all()).toHaveLength(1);
      // Staged, never promoted, across every re-drive.
      expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
      expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
        .toBe(BREVITY_SKILL);
      expect(sectionVersions(fx.rt)).toHaveLength(1);
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
    expect(sectionVersions(fx.rt)).toHaveLength(1);
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
      .toBe(BREVITY_SKILL);
    // Nothing went live off a proposal.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(routeFor(row.routes, 'prompt_section').disposition).toBe('staged');
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
    const recovery = new EvolutionEngine(fx.rt, historyTurnPairs(fx.stores.history), { enabled: false });
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
    expect(sectionVersions(fx.rt)).toHaveLength(1);
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
    const versions = sectionVersions(fx.rt);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.body).toBe(`${INCUMBENT.slice(0, -6)}BRIEF.`);
    expect(await readSkill(fx.rt, refinementStagingPath(opened.id, 'brevity')))
      .toBe(`${BREVITY_SKILL}\nName the ask.`);
  });

  test('a pass that threw is re-queued by the NEXT pass, in the same process', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);
    let asks = 0;

    // The port rejects mid-call: the pass unwinds without refusing or recording.
    const port = answeringPort(() => {
      asks += 1;

      if (asks === 1) throw new Error('the refiner host went away');

      return proposalText(EVERY_OWNER_PROPOSAL);
    });

    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await failsFrom(advanceRefinementLane(deps), 'the refiner host went away');
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
    expect(sectionVersions(fx.rt)).toHaveLength(1);
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

const LoggedEventSchema = v.object({ event: v.string(), fields: v.record(v.string(), v.unknown()) });

/** The diagnostics lines a sink captured, as events. */
function loggedEvents(lines: readonly string[]): v.InferOutput<typeof LoggedEventSchema>[] {
  return lines.map((line) => v.parse(LoggedEventSchema, JSON.parse(line)));
}

describe('the watch: a reply that rejects a dream\'s change', () => {
  /** A dream that keeps a fact and rewords a section, the section made current by a cold turn. */
  async function dreamt() {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);

    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'a preference and a shorter section',
      edits: [FACT_EDIT, { kind: 'prompt_section', sectionId: TARGET_ID, source: CANDIDATE, rationale: 'four corrected turns all asked for a shorter answer than the section invites' }],
    }));

    const deps = fx.deps(port);
    await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    turnArtifacts(fx.rt.storage.sql, fx.rt.actor, true);
    await advanceRefinementLane(deps);

    return { fx, deps, text: `${ARTIFACT}@1`, fact: `fact:${FACT_EDIT.key}` };
  }

  /** A model rating at `at` of a turn that ran with `artifacts`. */
  const rate = (fx: ReturnType<typeof fixture>, at: number, rated: { readonly score: number; readonly corrected: number; readonly artifacts: readonly string[]; readonly rejects?: string }) =>
    recordTurnRating(fx.rt.storage.sql, fx.rt.actor, {
      turnId: `t-${String(at)}`, wrong: null, source: 'model', request: 'r', answer: 'a', ...rated, now: at,
    });

  const reject = (fx: ReturnType<typeof fixture>, rejects: string, corrected: number, at: number) =>
    rate(fx, at, { score: 1, corrected, artifacts: [`${ARTIFACT}@1`], rejects });

  test('a turn lists the dream changes it ran with, each as what it is', async () => {
    const { fx, text, fact } = await dreamt();
    const changes = dreamChangesFor(fx.rt.storage.sql, fx.rt.actor, [text]);

    expect(changes.map((change) => change.id).sort()).toEqual([fact, text].sort());
    expect(changes.find((change) => change.id === text)?.describe).toStartWith(`the ${TARGET_ID} prompt section was reworded; it now reads: "${CANDIDATE.slice(0, 40)}`);
    expect(changes.find((change) => change.id === fact)?.describe).toBe(`the agent remembers ${FACT_EDIT.key}: "one line"`);
    // A turn that ran without the section's new version is not held to it.
    expect(dreamChangesFor(fx.rt.storage.sql, fx.rt.actor, []).map((change) => change.id)).toEqual([fact]);
  });

  test('the rater is asked about the listed changes only when there are any, and names the one rejected', async () => {
    const asked: Parameters<DecisionPort>[0][] = [];

    const decide: DecisionPort = async (request) => {
      asked.push(request);

      return { answers: {
        satisfaction: { type: 'score', score: 0 }, corrected: { type: 'noul', noul: 0.95 },
        wrong: { type: 'choice', choice: 'ignored_instruction' },
        ...(request.questions.rejects !== undefined && { rejects: { type: 'choice', choice: 'change_2' } }),
      }, usage: { input: 0, output: 0 } };
    };

    const turn = { request: 'r', actions: '', answer: 'a', followup: 'stop answering in one line' };
    const changes = [{ id: 'section:a@1', describe: 'the a prompt section was reworded' }, { id: 'fact:user.answer_length', describe: 'the agent remembers user.answer_length: "one line"' }];

    expect(await rateTurn(decide, turn, 0)).toEqual({ score: 1, corrected: 0.95, wrong: 'ignored_instruction', rejects: null });
    expect(asked[0]?.questions.rejects).toBeUndefined();
    expect(await rateTurn(decide, { ...turn, changes }, 0)).toMatchObject({ rejects: 'fact:user.answer_length' });
    expect(asked[1]?.questions.rejects).toMatchObject({ type: 'choice', criteria: { none: expect.any(String), change_1: changes[0]?.describe, change_2: changes[1]?.describe } });
  });

  test('the next dream reads each change with the turns that ran with it, against as many rated before it', async () => {
    const { fx, text, fact } = await dreamt();
    const since = present(listArtifactVersions(fx.rt.storage.sql, fx.rt.actor, ARTIFACT)[0]?.decidedAt ?? null, 'the activation');

    rate(fx, since + 1_000, { score: 4, corrected: 0, artifacts: [text] });
    rate(fx, since + 2_000, { score: 5, corrected: 0, artifacts: [text] });
    rate(fx, since + 3_000, { score: 1, corrected: 0.6, artifacts: [text], rejects: fact });

    const lines = renderWatch(fx.rt.storage.sql, fx.rt.actor).split('\n');
    const line = (id: string) => present(lines.find((entry) => entry.includes(`(${id})`)) ?? null, id);

    expect(line(text)).toStartWith(`  - the ${TARGET_ID} prompt section, reworded (${text}), in effect: 3 rated turns ran with it, mean 3.3 with 1 corrected; the 3 rated before it, mean `);
    expect(line(text)).toEndWith('; 0 replies rejected it');
    expect(line(fact)).toStartWith(`  - remembering ${FACT_EDIT.key} (${fact}), in effect: 3 rated turns ran with it, mean 3.3 with 1 corrected`);
    expect(line(fact)).toEndWith('; 1 replies rejected it');

    const { port, requests } = scriptedRefiner(proposalText({ scope: 'workspace', summary: 'nothing', edits: [] }));
    seedGradedTurns(fx.rt, 1);
    await requestRefinement(fx.deps(port), { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(fx.deps(port));
    expect(requests[0]?.task).toContain(`## What changed since, and how the turns went\n\n${lines.join('\n')}`);
  });

  test('an explicit stop reverts the change it names before the next dream; a mild or an earlier rejection does not', async () => {
    const { fx, deps, text, fact } = await dreamt();
    const lines: string[] = [];
    const later = Date.now() + 60_000;

    reject(fx, fact, 0.5, later);
    reject(fx, text, 0.95, later + 1);
    // Said before the fact took effect: not about this fact.
    reject(fx, fact, 0.95, 1);

    const restore = setDiagnosticsSink(createLineLogger((line) => { lines.push(line); }));

    try {
      await refinementPass(deps);
    } finally {
      restore();
    }

    expect(listArtifactVersions(fx.rt.storage.sql, fx.rt.actor, ARTIFACT)[0]?.status).toBe('rolled_back');
    expect(fx.facts.recall(FACT_EDIT.key)?.value).toBe('one line');
    expect(loggedEvents(lines)
      .filter((line) => line.event === 'dream.change_rejected')).toEqual([{ event: 'dream.change_rejected', fields: { change: text, turn: `t-${String(later + 1)}` } }]);

    // Now said plainly, after it took effect: the fact goes too, and a second pass reverts nothing twice.
    reject(fx, fact, 0.9, later + 2);
    await refinementPass(deps);
    expect(fx.facts.recall(FACT_EDIT.key)).toBeNull();
    await refinementPass(deps);
    expect(listArtifactVersions(fx.rt.storage.sql, fx.rt.actor, ARTIFACT)[0]?.status).toBe('rolled_back');
  });
});

describe('a dream says what it did', () => {
  test('completed with its counts as it ends, applied per change at its cold turn, reverted per owner revert', async () => {
    const lines: string[] = [];
    const restore = setDiagnosticsSink(createLineLogger((line) => { lines.push(line); }));
    let id = '';

    try {
      const fx = fixture();
      seedGradedTurns(fx.rt, 4);

      const { port } = scriptedRefiner(proposalText({
        scope: 'workspace', summary: 'tighten the persistence section',
        edits: [{ kind: 'prompt_section', sectionId: TARGET_ID, source: CANDIDATE, rationale: 'four corrected turns all asked for a shorter answer than the section invites' }],
      }));

      const deps = fx.deps(port);
      id = (await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' })).id;
      await advanceRefinementLane(deps);
      turnArtifacts(fx.rt.storage.sql, fx.rt.actor, true);
      await advanceRefinementLane(deps);

      await executeChangelogRevert(
        { rt: fx.rt, facts: fx.facts, events: new RunEventRecorder(fx.rt.storage.sql, fx.rt.actor) },
        { type: 'artifact_revert', target: `${ARTIFACT}@1` },
      );
    } finally {
      restore();
    }

    const said = loggedEvents(lines)
      .filter((line) => line.event.startsWith('dream.'));

    expect(said).toEqual([
      { event: 'dream.text_applied', fields: { change: `${ARTIFACT}@1`, replaced: 0 } },
      { event: 'dream.completed', fields: { dream: id, trigger: 'explicit', stage: 'applied', turns: 6, edits: 1, staged: 1, applied: 0, refused: 0 } },
      { event: 'dream.text_reverted', fields: { change: `${ARTIFACT}@1` } },
    ]);
  });
});

describe('promotion — a cold turn is the only thing that applies', () => {
  test('the section becomes current at the next turn whose cache is cold, and only then does the request apply', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);

    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'tighten the persistence section',
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

    // Refinement promotes nothing: a warm turn still reads the incumbent, a cold one makes the staged section current.
    turnArtifacts(fx.rt.storage.sql, fx.rt.actor, false);
    expect(overrides(fx.rt)[TARGET_ID]).toBeUndefined();
    turnArtifacts(fx.rt.storage.sql, fx.rt.actor, true);
    expect(overrides(fx.rt)[TARGET_ID]).toBe(CANDIDATE);

    const settled = await advanceRefinementLane(deps);
    expect(settled.step).toBe('settled');
    expect(store.get(opened.id)?.stage).toBe('applied');
  });

  test('a rolled-back section rolls back the request that proposed it', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 4);

    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'tighten the persistence section',
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

    // The owner discards it before it runs.
    revertArtifact(fx.rt.storage.sql, fx.rt.actor, ARTIFACT, 1);
    expect(overrides(fx.rt)[TARGET_ID]).toBeUndefined();

    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('rolled_back');
  });
});

describe('a dream — every five new turns, or when the agent is idle, triaged first', () => {
  test('new rated turns accrue toward a dream, whatever their rating, and five are owed one', () => {
    const fx = fixture();
    expect(evolutionDebt(fx.rt.storage.sql, fx.rt.actor).turnIds).toEqual([]);

    seedGradedTurns(fx.rt, 2, 2);
    const shallow = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(shallow.turnIds).toHaveLength(4);
    expect(shallow.owed).toBe(false);
    // Goes red if the module's constant moves without this file's literal.
    expect(shallow.summary).toContain(`opens at ${String(DREAM_CADENCE)}`);

    seedGradedTurns(fx.rt, 0, 1);
    const owed = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(owed.turnIds).toHaveLength(DREAM_CADENCE);
    expect(owed.owed).toBe(true);
    expect(owed.key).toMatch(/^[0-9a-f]{16,}$/);
  });

  test('the cadence opens one dream after a triage that finds something worth changing, and never the same turns twice', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3, 2);

    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    }));

    const deps = fx.deps(port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    const debt = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);

    const first = await dreamRequest(deps, 'cadence');
    expect(first?.trigger).toBe('cadence');
    expect(first?.stage).toBe('requested');
    expect(first?.turnIds).toEqual(debt.turnIds);
    // The triage read every turn of the batch.
    expect(fx.triaged).toHaveLength(1);
    expect(fx.triaged[0]).toContain('no, shorter please');

    // Primary guard: the batch is taken, so nothing is owed twice.
    expect(await dreamRequest(deps, 'cadence')).toBeNull();
    expect(store.list()).toHaveLength(1);

    // Second guard: the unique debt key, for a racing derivation.
    const replayed = store.open({
      trigger: 'cadence',
      scope: 'workspace',
      turnIds: debt.turnIds,
      debtKey: debt.key,
    });

    expect(replayed.created).toBe(false);
    expect(replayed.request.id).toBe(present(first, 'the first dream').id);
    expect(store.list()).toHaveLength(1);
  });

  test('a triage that finds nothing worth changing ends the dream there: no draft, and the turns are covered', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 0, DREAM_CADENCE);
    const { port, requests } = scriptedRefiner('{}');
    const dream = await dreamRequest(fx.deps(port, undefined, 0.2), 'cadence');

    expect(dream?.stage).toBe('refused');
    expect(dream?.detail).toContain('nothing worth changing');
    expect(requests).toHaveLength(0);
    expect(evolutionDebt(fx.rt.storage.sql, fx.rt.actor).turnIds).toEqual([]);
  });

  test('below the cadence nothing opens, but an idle agent dreams over any new turn', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 1, 0);
    const { port } = scriptedRefiner('{}');
    expect(await dreamRequest(fx.deps(port), 'cadence')).toBeNull();

    const idle = await dreamRequest(fx.deps(port), 'idle');
    expect(idle?.trigger).toBe('idle');
    expect(idle?.turnIds).toHaveLength(1);
    expect(await dreamRequest(fx.deps(port), 'idle')).toBeNull();
  });

  test('the idle wake dreams over a new rated turn, and never while learning is off', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 1, 0);
    const deps = fx.deps(scriptedRefiner('{}').port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    await idleDream(deps, false);
    expect(store.list()).toEqual([]);

    await idleDream(deps, true);
    expect(store.list().map((request) => request.trigger)).toEqual(['idle']);
  });

  test('turns a dream already covers stop counting, and new turns accrue under a new key', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3, 2);

    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'none', edits: [],
    }));

    await dreamRequest(fx.deps(port), 'cadence');
    const remaining = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(remaining.turnIds).toEqual([]);
    expect(remaining.owed).toBe(false);

    seedGradedTurns(fx.rt, 1, 4);
    const next = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(next.owed).toBe(true);
    expect(next.key).not.toBe(remaining.key);
  });
});

describe('a dream is cross-judged: the dreamer drafts, the decision model measures, the reviewer decides', () => {
  const SECTION_EDIT: Extract<RefinementEdit, { kind: 'prompt_section' }> = {
    kind: 'prompt_section', sectionId: TARGET_ID, source: CANDIDATE,
    rationale: 'four corrected turns all asked for a shorter answer than the section invites',
  };

  const REVISED = `${INCUMBENT.slice(0, -6)}TERSE.`;

  test('the reviewer reads every drafted edit with what it was measured at; a rejected edit routes nowhere and says why', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const briefs: string[] = [];
    const { port } = scriptedRefiner(proposalText({ scope: 'workspace', summary: 'a preference and a section', edits: [FACT_EDIT, SECTION_EDIT] }));

    const deps = fx.deps(port, undefined, undefined, (brief) => {
      briefs.push(brief);

      return [{ edit: 0, verdict: 'reject', note: 'one exchange is not a standing preference' }, { edit: 1, verdict: 'accept', note: 'the turns asked for it' }];
    });

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the dream');

    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain('### Edit 0: fact user.answer_length');
    expect(briefs[0]).toContain('### Edit 1: prompt_section');
    expect(briefs[0]).toContain('Measured: the decision model judged it to fix 1.00');
    expect(briefs[0]).toContain('no, shorter please');
    expect(briefs[0]).toMatch(/The prompt sections and tool texts are \d+ bytes, against \d+ as bundled/u);
    expect(routeFor(row.routes, 'fact')).toMatchObject({ disposition: 'refused', reason: 'the reviewer rejected it: one exchange is not a standing preference' });
    expect(routeFor(row.routes, 'prompt_section').disposition).toBe('staged');
    expect(fx.facts.all()).toEqual([]);
    expect(sectionVersions(fx.rt).map((version) => [version.body, version.status])).toEqual([[CANDIDATE, 'staged']]);
  });

  test('asked to revise, the dreamer revises once with the reviewer\'s notes, and the revision is measured and judged again', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    let rounds = 0;

    const { port, requests } = scriptedRefiner((request) => proposalText({
      scope: 'workspace', summary: 'a section',
      edits: [{ ...SECTION_EDIT, source: request.lane?.requestId.endsWith(':revise:0') === true ? REVISED : CANDIDATE }],
    }));

    // The judge passes both texts, so the reviewer decides between them.
    const deps = fx.deps(port, undefined, undefined, () => {
      rounds += 1;

      return [rounds === 1 ? { edit: 0, verdict: 'revise', note: 'say terse, not asked' } : { edit: 0, verdict: 'accept', note: 'better' }];
    });

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });

    for (let pass = 0; pass < 5; pass += 1) await advanceLane(deps);
    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the dream');
    const revise = present(requests.find((request) => request.lane?.requestId.endsWith(':revise:0') === true), 'the revision brief');

    expect(revise.task).toContain('Edit 0: revise: say terse, not asked');
    expect(revise.task).toContain(JSON.stringify(CANDIDATE).slice(1, 40));
    expect(rounds).toBe(2);
    expect(row.review.rounds).toHaveLength(2);
    expect(row.proposal?.edits[0]).toMatchObject({ source: REVISED });
    expect(sectionVersions(fx.rt).map((version) => version.body)).toEqual([REVISED]);
  });

  test('a second request to revise is a rejection: there is one revision', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port } = scriptedRefiner(proposalText({ scope: 'workspace', summary: 'a section', edits: [SECTION_EDIT] }));
    const deps = fx.deps(port, undefined, undefined, () => [{ edit: 0, verdict: 'revise', note: 'still too loose' }]);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });

    for (let pass = 0; pass < 5; pass += 1) await advanceLane(deps);
    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the dream');

    expect(routeFor(row.routes, 'prompt_section')).toMatchObject({
      disposition: 'refused', reason: 'the reviewer still asked for a revision after the one the dreamer made: still too loose',
    });
    expect(sectionVersions(fx.rt)).toEqual([]);
  });

  test('an edit no decision model answered for is refused as unmeasured, never as a measured zero', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const briefs: string[] = [];

    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace', summary: 'a shorter section',
      edits: [{ kind: 'prompt_section', sectionId: TARGET_ID, source: CANDIDATE, rationale: 'three corrected turns all asked for a shorter answer than the section invites' }],
    }));

    const deps = fx.deps(port, undefined, undefined, (brief, edits) => {
      briefs.push(brief);

      return acceptEvery(brief, edits);
    });

    // Triage is answered; the judge's questions are not, as an untrusted structured port leaves them.
    const triage = fx.rt.decide;
    fx.rt.decide = async (request) => ('worth' in request.questions ? await triage?.(request) ?? null : null);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the dream');

    expect(routeFor(row.routes, 'prompt_section')).toMatchObject({ disposition: 'refused' });
    expect(briefs.join('')).not.toContain('fix 0.00');
    expect(JSON.stringify(row)).toContain('no decision model is trusted to judge this edit, so it was not measured');
  });

  test('a tool\'s own text is drafted, measured and reviewed like a section, and moves the tool only at a cold turn', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const briefs: string[] = [];
    const described = `${BUILTIN_TOOL_DESCRIPTIONS.shell}\nA command's output past its limit is cut; say so.`;

    const { port, requests } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'shell output that was cut',
      edits: [{
        kind: 'tool_description', tool: 'shell', part: 'description', source: described,
        rationale: 'three corrected turns all reported a whole log the shell had cut short',
      }],
    }));

    const deps = fx.deps(port, undefined, undefined, (brief, edits) => {
      briefs.push(brief);

      return acceptEvery(brief, edits);
    });

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the dream');
    const tool = toolArtifact('shell', 'description');
    const shell = () => artifactOverrides(currentArtifacts(fx.rt.storage.sql, fx.rt.actor)).tools.descriptions.shell;

    expect(requests[0]?.task).toMatch(/- shell: description \d+ bytes, schema \d+ bytes/u);
    expect(requests[0]?.task).toMatch(/- agents: description \d+ bytes\n/u);
    expect(briefs[0]).toContain(`### Edit 0: tool_description ${tool} (artifact_versions)`);
    expect(briefs[0]).toContain('Measured: the decision model judged it to fix 1.00');
    expect(briefs[0]).toMatch(/The prompt sections and tool texts are \d+ bytes, against \d+ as bundled/u);
    expect(routeFor(row.routes, 'tool_description')).toMatchObject({ disposition: 'staged', owner: 'artifact_versions', target: `${tool}@1` });

    turnArtifacts(fx.rt.storage.sql, fx.rt.actor, false);
    expect(shell()).toBeUndefined();
    turnArtifacts(fx.rt.storage.sql, fx.rt.actor, true);
    expect(shell()).toBe(described);
  });

  test('a tool\'s field text that drops a field is refused before anyone reviews it', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const briefs: string[] = [];

    const { port } = scriptedRefiner(proposalText({
      scope: 'workspace',
      summary: 'shell fields',
      edits: [{
        kind: 'tool_description', tool: 'shell', part: 'schema', source: JSON.stringify({ command: 'The command to run.' }),
        rationale: 'three corrected turns all passed a field the shell does not need at all',
      }],
    }));

    const deps = fx.deps(port, undefined, undefined, (brief, edits) => {
      briefs.push(brief);

      return acceptEvery(brief, edits);
    });

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the dream');

    expect(briefs[0]).toContain('Refused by a fixed gate, whatever you say: the fields changed:');
    expect(routeFor(row.routes, 'tool_description').disposition).toBe('refused');
    expect(listArtifactVersions(fx.rt.storage.sql, fx.rt.actor, toolArtifact('shell', 'schema'))).toEqual([]);
  });

  test('the dreamer drafts on the deep tier and the reviewer judges on the fast one, each read-only on its own lane', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const { port, requests } = scriptedRefiner(proposalText(FACT_PROPOSAL));
    const started: TemporaryRunRequest[] = [];

    const watching: TemporaryAgentPort = {
      ...port,
      start: async (request) => {
        started.push(request);

        return port.start(request);
      },
    };

    const opened = await requestRefinement(fx.deps(watching), { trigger: 'explicit', scope: 'workspace' });

    await advanceRefinementLane(fx.deps(watching));

    expect(requests.map((request) => [request.role, request.mode, request.lane?.requestId])).toEqual([['dreamer', 'plan', opened.id]]);
    expect(SYSTEM_ROLE_DEFINITIONS.dreamer.tier).toBe('deep');
    expect(SYSTEM_ROLE_DEFINITIONS['dream-reviewer']).toMatchObject({ tier: 'fast', allowedTools: [] });
    expect(started.map((request) => request.role)).toEqual(['dreamer']);
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

    const deps = fx.deps(scriptedRefiner(proposalText(proposal)).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);

    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    expect(store.get(opened.id)?.stage).toBe('evaluating');

    // The section loses its live trial.
    revertArtifact(fx.rt.storage.sql, fx.rt.actor, ARTIFACT, 1);
    expect(overrides(fx.rt)[TARGET_ID]).toBeUndefined();

    await advanceRefinementLane(deps);
    const settled = present(store.get(opened.id), 'the refinement row');
    // The fact is live, so the request is not rolled_back.
    expect(settled.stage).toBe('applied');
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(settled.detail).toContain('1 edit in effect');
    expect(settled.detail).toContain('1 rolled back');
  });
});

describe('dreams page, and never lose an older turn', () => {
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

    const first = await dreamRequest(deps, 'cadence');
    expect(first?.turnIds).toHaveLength(12);

    // A windowed read would see only covered rows and strand the older failures.
    const next = evolutionDebt(fx.rt.storage.sql, fx.rt.actor);
    expect(next.owed).toBe(true);
    expect(next.turnIds).toEqual(negatives.slice(12));
    expect(next.key).not.toBe(present(first, 'the first dream').turnIds.join(''));

    const second = await dreamRequest(deps, 'cadence');
    expect(second?.id).not.toBe(present(first, 'the first dream').id);
    expect(second?.turnIds).toEqual(negatives.slice(12));
    expect(evolutionDebt(fx.rt.storage.sql, fx.rt.actor).owed).toBe(false);
  });

  test('a covered batch newer than an uncovered one does not hide it', () => {
    const fx = fixture();
    const { negatives: older } = seedGradedTurns(fx.rt, DREAM_CADENCE, 0);
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

describe('a cold turn is what makes a dream\'s skill live', () => {
  async function stagedFixture() {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(BREVITY_SKILL))).port);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);

    return { fx, deps, store, id: opened.id, staged: refinementStagingPath(opened.id, 'brevity') };
  }

  test('a crash between the trust row and the file is repaired at the next cold turn, never by the lane', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();

    // The crash window: trust landed, the file did not.
    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL), 'dream');
    // Nothing discovers a path with no file, and the lane does not write one.
    await advanceRefinementLane(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);
    expect(present(store.get(id), 'the dream').detail).toContain('the next cold turn writes it');

    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
    expect(await readSkill(fx.rt, staged)).toBeNull();
    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('applied');

    // Idempotent.
    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
  });

  test('a crash between the file and the staging cleanup is repaired too', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();
    fx.approvals.approve(BREVITY_PATH, instructionDigest(BREVITY_SKILL), 'dream');
    await writeSkill(fx.rt, BREVITY_PATH, BREVITY_SKILL);
    expect(await readSkill(fx.rt, staged)).toBe(BREVITY_SKILL);

    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, staged)).toBeNull();
    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('applied');
  });

  test('staged bytes that changed since review are never promoted', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();
    await writeSkill(fx.rt, staged, `${BREVITY_SKILL}\nsomebody edited the staging.`);

    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('evaluating');
  });

  test('without a cold turn a staged skill waits: no clock, no default', async () => {
    const { fx, deps, store, id } = await stagedFixture();
    void fx.rt.storage.sql`UPDATE refinement_requests SET created_at = 1, updated_at = 1
      WHERE id = ${id}`;

    for (let i = 0; i < 10; i += 1) {
      expect((await advanceRefinementLane(deps)).step).toBe('idle');
    }

    expect(store.get(id)?.stage).toBe('evaluating');
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
  });

  test('a staged skill reverted before its cold turn never lands', async () => {
    const { fx, deps, store, id, staged } = await stagedFixture();

    const reverted = await executeChangelogRevert(
      { rt: fx.rt, facts: fx.facts, events: new RunEventRecorder(fx.rt.storage.sql, fx.rt.actor), skills: { approvals: fx.approvals, skillsVfs: fx.rt.agentStateVfs } },
      { type: 'skill_revert', target: `${id}#0` },
    );

    expect(reverted).toEqual({ ok: true, detail: `revoked trust for ${BREVITY_PATH}` });
    expect(await readSkill(fx.rt, staged)).toBeNull();
    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    await advanceRefinementLane(deps);
    const settled = present(store.get(id), 'the dream');
    expect(settled.stage).toBe('rolled_back');
    expect(settled.detail).toContain('rejected by you');
  });

  test('a revert names what is wrong with its target, and reverts nothing twice', async () => {
    const { fx, id } = await stagedFixture();
    const ctx = { rt: fx.rt, facts: fx.facts, events: new RunEventRecorder(fx.rt.storage.sql, fx.rt.actor), skills: { approvals: fx.approvals, skillsVfs: fx.rt.agentStateVfs } };

    expect(await executeChangelogRevert(ctx, { type: 'skill_revert', target: 'no-hash' })).toMatchObject({ ok: false, error: 'invalid skill target: no-hash' });
    expect(await executeChangelogRevert(ctx, { type: 'skill_revert', target: `${id}#7` })).toMatchObject({ ok: false, error: `no dream skill at ${id} edit 7` });
    expect(await executeChangelogRevert({ ...ctx, skills: undefined }, { type: 'skill_revert', target: `${id}#0` })).toMatchObject({ ok: false });
    expect((await executeChangelogRevert(ctx, { type: 'skill_revert', target: `${id}#0` })).ok).toBe(true);
    expect(await executeChangelogRevert(ctx, { type: 'skill_revert', target: `${id}#0` })).toMatchObject({ ok: false, error: `${BREVITY_PATH} is rejected: nothing to revert` });
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
    const vfs = rt.agentStateVfs;
    const real = vfs.writeFile.bind(vfs);
    vfs.writeFile = async (written: string, data: Uint8Array) => {
      if (written !== path) return real(written, data);

      if (mode === 'throw') throw new Error('disk full');

      // A torn write.
      return real(written, new TextEncoder().encode('\ntruncated'));
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

  test('a copy that throws keeps the staging and stays retryable at the next cold turn', async () => {
    const { fx, deps, store, id, path } = await staged();
    const repair = saboteur(fx.rt, BREVITY_PATH, 'throw');

    await activateDreamSkills(deps);

    // The trust row alone is harmless; the bytes stay staged.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBeNull();
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    expect(await discoveredSkillNames(fx.rt)).toEqual([]);
    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('evaluating');

    repair();
    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(BREVITY_SKILL);
    expect(await readSkill(fx.rt, path)).toBeNull();
    await advanceRefinementLane(deps);
    expect(store.get(id)?.stage).toBe('applied');
  });

  test('a torn write is caught by the read-back and the staging survives', async () => {
    const { fx, deps, store, id, path } = await staged();
    const stop = saboteur(fx.rt, BREVITY_PATH, 'tear');

    await activateDreamSkills(deps);

    // The torn file is not ours to delete; the mismatch is surfaced.
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);

    // A later cold turn refuses to overwrite bytes nobody reviewed.
    stop();
    await activateDreamSkills(deps);
    await advanceRefinementLane(deps);
    const row = present(store.get(id), 'the refinement row');
    expect(row.stage).toBe('evaluating');
    expect(row.detail).toContain('holds other bytes');
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
  });

  test('a foreign file appearing at the target before the cold turn is never overwritten', async () => {
    const { fx, deps, store, id, path } = await staged();
    const foreign = `${BREVITY_SKILL}\nsomebody else got here first.`;
    await writeSkill(fx.rt, BREVITY_PATH, foreign);

    await activateDreamSkills(deps);
    await advanceRefinementLane(deps);
    // Their bytes stand, ours stay staged.
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(foreign);
    expect(await readSkill(fx.rt, path)).toBe(BREVITY_SKILL);
    const row = present(store.get(id), 'the refinement row');
    expect(row.stage).toBe('evaluating');
    expect(row.detail).toContain('holds other bytes');
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

  test('an owner revert survives a plan re-drive', async () => {
    const { fx, deps, store, id } = await staged();
    expect((await executeChangelogRevert(
      { rt: fx.rt, facts: fx.facts, events: new RunEventRecorder(fx.rt.storage.sql, fx.rt.actor), skills: { approvals: fx.approvals, skillsVfs: fx.rt.agentStateVfs } },
      { type: 'skill_revert', target: `${id}#0` },
    )).ok).toBe(true);

    // A crash drags the row back to `planning`.
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'planning' WHERE id = ${id}`;
    store.resetStalePlanning();
    await advanceRefinementLane(deps);

    // The rejection stands; the owner is not asked again.
    expect(present(store.get(id), 'the refinement row').routes[0]?.disposition).toBe('rejected');
    expect(await readSkill(fx.rt, refinementStagingPath(id, 'brevity'))).toBeNull();
    expect(store.get(id)?.stage).toBe('rolled_back');
  });

  test('a long skill\'s card is an excerpt, and the skill lands whole', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    // Far past any card's excerpt budget.
    const long = `---\nname: brevity\ndescription: answer briefly\n---\n${'Be brief. '.repeat(600)}`;
    const deps = fx.deps(scriptedRefiner(proposalText(skillProposal(long))).port);
    const opened = await requestRefinement(deps, { trigger: 'explicit', scope: 'workspace' });
    await advanceRefinementLane(deps);
    await activateDreamSkills(deps);
    expect(await readSkill(fx.rt, BREVITY_PATH)).toBe(long);

    // The card is bounded.
    const card = buildChangelog(fx.rt.storage.sql, fx.rt.actor, { limit: 50 })
      .find((entry) => entry.id.startsWith(`refinement:${opened.id}`));

    expect(card?.items?.[0]?.evidence.length).toBeLessThan(long.length);
    expect(card?.items?.[0]?.evidence).toContain('chars');
  });
});

/** One workspace database for the roster and the root's rail, as both hosts keep them. */
/** `over`: the lane's own database, so the helper's parent is the actor whose lane asked it, as in a workspace. */
function refinerRail(over?: { readonly db: Database; readonly workspaceId: string }) {
  const db = over?.db ?? new Database(':memory:');
  const workspaceId = over?.workspaceId ?? 'refiner-workspace';
  const exec = makeSqlExec(db);
  initEventsHubTables(exec);
  createTestActor(makeSql(db), makeExecRaw(db), workspaceId, 'main');
  const directory = new WorkspaceActorDirectory(makeSql(db), { workspaceId, ownerUserId: '' });
  const root = directory.main();
  const roster = new SubordinateRosterStore(exec, root);
  roster.ensureSchema();
  const assigned = Promise.withResolvers<void>();
  const recordAssignment = roster.recordAssignmentEvent.bind(roster);

  roster.recordAssignmentEvent = (name, eventId) => {
    recordAssignment(name, eventId);
    assigned.resolve();
  };

  const log = new EventLog(exec, root);
  const handoff: SubordinateHandoff = { eventId: 'evt-refine', delivery: 'starts_now', phase: { busy: false, lastActivityAt: null, workingOn: null } };

  const runtime: SubordinateRuntime = {
    spawn: async (input) => directory.apply(root, [], { action: 'register', name: input.name, creationId: input.creationId, origin: input.origin, lifetime: input.lifetime }).reference,
    cancelBirth: async () => { throw new Error('no birth is cancelled here'); },
    assign: async () => handoff,
    status: async () => ({ lastActivity: null, recentSteps: [] }),
    message: async () => handoff,
    dismiss: async () => ({ stoppedJobs: [] }),
    rename: async () => undefined,
  };

  const retires: Promise<void>[] = [];

  /** A fresh port is a fresh activation. */
  const port = () => createTemporaryAgentPort({
    roster, runtime, createName: (role) => `${role}-a1b2c3`, now: () => SEED_EPOCH,
    // The rail's runtime dismisses synchronously; a failure would fail the test through the rejected promise it returns.
    afterTurn: (_child, work) => { retires.push(work()); },
  });

  return {
    root,
    roster,
    log,
    port,
    assigned: assigned.promise,
    helper: 'ask-dreamer-a1b2c3',
    reports: () => log.pending().filter((event) => event.variant === 'subordinate_report'),
    deliver: (temporary: TemporaryAgentPort, content: string) => receiveSubordinateEvent({
      log, roster, vfs: createMemoryVfs().vfs, transaction: (body) => body(),
      announce: () => undefined, onAdmitted: () => undefined, evolutionAnswerStored: () => undefined, onEvolutionAnswer: () => undefined, temporary,
    }, {
      fromSubordinate: 'ask-dreamer-a1b2c3', status: 'completed', content, origin: 'turn_end',
      sequenceId: 'refiner:turn-1', mode: 'plan',
    }, SEED_EPOCH),
  };
}

/** A pass that starts the refiner and returns at once, its helper still working. */
async function startRefiner(fx: ReturnType<typeof fixture>, rail: ReturnType<typeof refinerRail>): Promise<RefinementRequestView> {
  const port = rail.port();
  const opened = await requestRefinement(fx.deps(port), { trigger: 'explicit', scope: 'workspace' });

  expect((await advanceLane(fx.deps(port))).step).toBe('idle');

  return opened;
}

describe('a refiner answer returns to the lane, never to the root', () => {
  test('after an eviction the answer is stored, the row released, and the next pass routes it', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const rail = refinerRail();
    const opened = await startRefiner(fx, rail);
    expect(rail.roster.get(rail.helper)?.origin).toBe('evolution');

    let asks = 0;
    const resumed = rail.port();

    const counted: TemporaryAgentPort = {
      ...resumed,
      start: (request) => {
        asks += 1;

        return resumed.start(request);
      },
    };

    // The helper is still working: the next pass waits for it instead of asking a second refiner.
    expect((await advanceRefinementLane(fx.deps(counted))).step).toBe('idle');
    expect(asks).toBe(0);

    // The child's turn, resumed on the new activation, reports through the real ingress.
    await rail.deliver(resumed, proposalText(FACT_PROPOSAL));
    expect(rail.reports()).toEqual([]);
    expect(buildDrainBatch(rail.log.pending())).toBeNull();
    expect(rail.roster.get(rail.helper)?.status).toBe('dismissed');

    const step = await advanceRefinementLane(fx.deps(counted));
    expect(step.step).toBe('planned');
    expect(asks).toBe(0);
    expect(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id)?.stage).toBe('applied');
    expect(fx.facts.recall('user.answer_length')?.value).toBe('one line');
    expect(rail.reports()).toEqual([]);
  });

  test('a stored answer owes the lane a pass at once, and the pass that routes it clears that', async () => {
    // Without it, an answer stored after an eviction waits for the owner's next turn.
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const rail = refinerRail({ db: fx.db, workspaceId: 'test-agent-id' });
    const owed = () => nextEvolutionAnswerAt(fx.rt.storage.sql, rail.root.actorId);
    await startRefiner(fx, rail);
    expect(owed()).toBeNull();

    const resumed = rail.port();
    await rail.deliver(resumed, proposalText(FACT_PROPOSAL));
    const due = owed();

    expect(due).not.toBeNull();
    expect(due ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now());

    expect((await advanceRefinementLane(fx.deps(resumed))).step).toBe('planned');
    expect(owed()).toBeNull();
  });

  test('it owes nothing while an older request is ahead in the lane, which the next pass would take instead', async () => {
    // A due source the pass will not route would re-arm the wake at once, lap after lap.
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const rail = refinerRail({ db: fx.db, workspaceId: 'test-agent-id' });
    await startRefiner(fx, rail);
    await rail.deliver(rail.port(), proposalText(FACT_PROPOSAL));
    createRefinementStore(fx.rt.storage.sql, fx.rt.actor).open({ trigger: 'explicit', scope: 'workspace', turnIds: [], now: 1 });

    expect(nextEvolutionAnswerAt(fx.rt.storage.sql, rail.root.actorId)).toBeNull();
  });

  test('a store read that throws while planning a stored answer refuses that request with its cause', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const rail = refinerRail({ db: fx.db, workspaceId: 'test-agent-id' });
    const opened = await startRefiner(fx, rail);
    const resumed = rail.port();
    await rail.deliver(resumed, proposalText(FACT_PROPOSAL));

    // The reviewed turns are read synchronously, after the answer is taken and before any route.
    void fx.rt.storage.sql`ALTER TABLE turn_ratings RENAME TO turn_ratings_away`;
    await advanceRefinementLane(fx.deps(resumed));
    void fx.rt.storage.sql`ALTER TABLE turn_ratings_away RENAME TO turn_ratings`;

    const row = present(createRefinementStore(fx.rt.storage.sql, fx.rt.actor).get(opened.id), 'the refinement row');
    expect(row.stage).toBe('refused');
    expect(row.detail).toContain('turn_ratings');
    expect(nextEvolutionAnswerAt(fx.rt.storage.sql, rail.root.actorId)).toBeNull();
  });

  test('any throw in a pass holds the lane: its stored answer stops reading as due', async () => {
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const rail = refinerRail({ db: fx.db, workspaceId: 'test-agent-id' });
    const owed = () => nextEvolutionAnswerAt(fx.rt.storage.sql, rail.root.actorId);
    await startRefiner(fx, rail);
    const resumed = rail.port();
    await rail.deliver(resumed, proposalText(FACT_PROPOSAL));
    expect(owed()).not.toBeNull();

    fx.db.run(`CREATE TRIGGER refuse_claim BEFORE UPDATE ON refinement_requests
      BEGIN SELECT RAISE(ABORT, 'the request table refused the write'); END`);
    await failsFrom(refinementPass(fx.deps(resumed)), 'the request table refused the write');
    expect(owed()).toBeNull();

    fx.db.run('DROP TRIGGER refuse_claim');
    // The draft goes to the reviewer, whose verdicts the next pass routes.
    expect((await refinementPass(fx.deps(resumed))).step).toBe('idle');
    expect((await refinementPass(fx.deps(resumed))).step).toBe('planned');
  });

  test('a pass that fails for no one request holds the lane with its cause, owing no wake until new input', async () => {
    // Still due, every wake would re-run the same failing settle.
    const fx = fixture();
    seedGradedTurns(fx.rt, 3);
    const rail = refinerRail({ db: fx.db, workspaceId: 'test-agent-id' });
    const owed = () => nextEvolutionAnswerAt(fx.rt.storage.sql, rail.root.actorId);
    const store = createRefinementStore(fx.rt.storage.sql, fx.rt.actor);
    const answered = await startRefiner(fx, rail);
    const resumed = rail.port();
    await rail.deliver(resumed, proposalText(FACT_PROPOSAL));
    const stuck = store.open({ trigger: 'explicit', scope: 'workspace', turnIds: [], now: 1 }).request;
    void fx.rt.storage.sql`UPDATE refinement_requests SET stage = 'gated' WHERE id = ${stuck.id}`;
    void fx.rt.storage.sql`ALTER TABLE artifact_versions RENAME TO artifact_versions_away`;
    expect(owed()).not.toBeNull();

    expect((await refinementPass(fx.deps(resumed))).step).toBe('idle');
    expect(store.get(stuck.id)?.detail).toContain('artifact_versions');
    expect(owed()).toBeNull();
    expect(store.get(answered.id)?.stage).not.toBe('applied');

    void fx.rt.storage.sql`ALTER TABLE artifact_versions_away RENAME TO artifact_versions`;
    await refinementPass(fx.deps(resumed));
    await refinementPass(fx.deps(resumed));
    await refinementPass(fx.deps(resumed));
    expect(store.get(answered.id)?.stage).toBe('applied');
    expect(owed()).toBeNull();
  });
});
