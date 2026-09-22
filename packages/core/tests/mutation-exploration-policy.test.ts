// Exploration policy decisions proven load-bearing: each named defending test must pass on
// the pristine module and fail on a mutant copy.
import { describe, expect, test } from 'bun:test';
import { readFileSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createTestActors, scratchDir } from '@kinu.run/test-utils';
import { Database } from 'bun:sqlite';
import { makeExecRaw, makeSql } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import * as pristineArchive from '../src/strategy/archive';
import * as pristineClamp from '../src/tools/clamp';
import * as pristineMergeBack from '../src/strategy/merge-back';
import * as pristineRecords from '../src/strategy/records';
import * as pristineObjective from '../src/strategy/objective';
import * as pristineSwarmBudget from '../src/strategy/swarm-budget';
import { BRANCH_REFUSAL_POLICIES } from '../src/strategy/swarm';
import type { ArchiveWrite } from '../src/strategy/archive';
import type {
  MemberApply, MemberFileChange, MergeBackReport, MergeMember, MergePolicy,
} from '../src/strategy/merge-back';
import type { ExplorationWrite } from '../src/strategy/records';
import type {
  BranchProposal, ResolvedSwarmCaps, SwarmConfig,
} from '../src/strategy/swarm';
import type {
  Floor, FloorBreach, ObjectiveIdentity, PublicationState,
} from '../src/strategy/objective';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { SqlExecutor } from '../src/types/primitives';

type ArchiveModule = typeof pristineArchive;

type ClampModule = typeof pristineClamp;

type MergeBackModule = typeof pristineMergeBack;

type RecordsModule = typeof pristineRecords;

type SwarmBudgetModule = typeof pristineSwarmBudget;

type ObjectiveModule = typeof pristineObjective;

const TEST_DIR = new URL('.', import.meta.url).pathname;

// Canonical: the loader resolves a copy's imports from its real path, and macOS `tmpdir()`
// is a symlink one level shallower than its target.
const MUTANTS = realpathSync(scratchDir('mutation-exploration-policy'));

const SRC = new URL('../src/', import.meta.url).pathname;

symlinkSync(resolve(TEST_DIR, '../../../node_modules'), resolve(MUTANTS, 'node_modules'), 'dir');

interface Copy {
  readonly src: string;
  /** Absent when the file is copied only so it imports the mutants beside it. */
  readonly edits?: readonly (readonly [find: string, replace: string])[];
}

function writeMutants(label: string, plan: readonly Copy[]): (src: string) => string {
  // Named so the `*.test.ts` glob never runs a mutant as a suite.
  const target = new Map(plan.map((copy) => [
    resolve(SRC, copy.src),
    resolve(MUTANTS, `policy.mutant-${label}-${copy.src.replaceAll('/', '-')}`),
  ]));

  for (const copy of plan) {
    const origin = resolve(SRC, copy.src);
    let source = readFileSync(origin, 'utf8');

    for (const [find, replace] of copy.edits ?? []) {
      const occurrences = source.split(find).length - 1;

      if (occurrences !== 1) {
        throw new Error(
          `mutation "${label}" expected exactly one occurrence of ${JSON.stringify(find)} in `
          + `${copy.src} and found ${String(occurrences)}. The snippet has moved, so this `
          + 'mutation would have proven nothing — update the snippet rather than the assertion.',
        );
      }

      source = source.replace(find, replace);
    }

    const dir = origin.slice(0, origin.lastIndexOf('/'));

    const rewritten = source.replaceAll(
      /from '(\.[^']*)'/g,
      (_whole: string, specifier: string) => {
        const resolved = resolve(dir, specifier);
        const to = target.get(`${resolved}.ts`) ?? resolved;
        const path = relative(MUTANTS, to);

        return `from '${path.startsWith('.') ? path : `./${path}`}'`;
      },
    );

    const at = target.get(origin);

    if (at === undefined) throw new Error(`no copy planned for ${copy.src}`);
    writeFileSync(at, rewritten);
  }

  return (src) => {
    const at = target.get(resolve(SRC, src));

    if (at === undefined) throw new Error(`${src} is not in mutation "${label}"'s plan`);

    return at;
  };
}

const NOVELTY_FLOOR = 'if (nearest !== null && nearest.distance < novelty) {';

const NEAREST_SEARCH =
  'if (nearest === null || distance < nearest.distance) nearest = { occupant, distance };';

const IS_BETTER =
  "return direction === 'minimise' ? candidate < incumbent : candidate > incumbent;";

const PARETO_WEAKER = "if (axis.direction === 'maximise' ? l < r : l > r) return false;";

const SEAL_CLEARED = "if (state.clearedBy !== null) return { kind: 'admitted' };";

const POLICY_BEST = "case 'best': return 'apply-winner';";

const CYCLE_SCAN = 'if (placed.has(member.nodeId)) continue;\n\n    const stuck = new Map(';

const BUDGET_ROOM = 'if (remainingChildren < width) {';

const CLAMP_TAIL = 'const tail = text.slice(tailStart(text, room - headLen));';

const SNIPPETS: readonly (readonly [src: string, snippet: string])[] = [
  ['strategy/archive.ts', NOVELTY_FLOOR],
  ['strategy/archive.ts', NEAREST_SEARCH],
  ['strategy/objective.ts', IS_BETTER],
  ['strategy/objective.ts', SEAL_CLEARED],
  ['strategy/objective.ts', PARETO_WEAKER],
  ['strategy/merge-back.ts', POLICY_BEST],
  ['strategy/merge-back.ts', CYCLE_SCAN],
  ['strategy/swarm.ts', BUDGET_ROOM],
  ['tools/clamp.ts', CLAMP_TAIL],
];

/**
 * The first line of a failed `expect`: a RED proof must reject with an assertion failure,
 * not a crash in the mutant.
 */
const ASSERTION_FAILED = /expect\(.{0,24}?received/s;
// Bun assertion errors carry no structural identity, so the message is the only channel.
// Under a TTY colour codes land between tokens, so the literal 'expect(received)' fails;
// the bounded gap keeps a crash message from matching by accident.

interface Defended {
  readonly file: string;
  readonly name: string;
}

const RECORDS_SUITE = 'unit-exploration-records.test.ts';

const MERGE_SUITE = 'unit-merge-back.test.ts';

const BUDGET_SUITE = 'unit-swarm-budget.test.ts';

const CLAMP_SUITE = 'unit-clamp-tool-result.test.ts';

const PARETO_SUITE = 'unit-pareto-advance.test.ts';

const THRESHOLD_IS_A_FLOOR: Defended = {
  file: RECORDS_SUITE,
  name: 'THE THRESHOLD IS READ AS A FLOOR: 0 admits the near-copy, 1 refuses the far one',
};

const NEAREST_IS_NAMED: Defended = {
  file: RECORDS_SUITE,
  name: 'THE NEAREST occupant is named, not whichever one the cell was sorted on top',
};

const DIRECTION_DECIDES: Defended = {
  file: RECORDS_SUITE,
  name: 'the DIRECTION decides which way is better, so a maximise objective is not silently inverted',
};

const TIE_DOES_NOT_DISPLACE: Defended = {
  file: RECORDS_SUITE,
  name: 'a TIE does not displace: `isBetter` is strict and a re-record of the same number moved nothing',
};

const SEAL_WRITES_NOTHING: Defended = {
  file: RECORDS_SUITE,
  name: 'a breached run writes NOTHING, and the refusal names the seal',
};

const POLICY_FROM_SETTLE: Defended = {
  file: MERGE_SUITE,
  name: 'each settle shape maps to the policy *Merge-back* derives',
};

const CYCLE_WHATEVER_THE_ORDER: Defended = {
  file: MERGE_SUITE,
  name: 'a cycle is refused whatever order it is offered in',
};

const EVERY_POLICY_REACHABLE: Defended = {
  file: BUDGET_SUITE,
  name: 'the arbiter it wraps is unchanged: every policy is still reachable through it',
};

const HONOURS_A_CUSTOM_BUDGET: Defended = {
  file: CLAMP_SUITE,
  name: 'the shared budget is honoured',
};

const PARETO_DIRECTION: Defended = {
  file: PARETO_SUITE,
  name: 'honours each declared vector direction instead of assuming maximise',
};

const DEFENDED: readonly Defended[] = [
  THRESHOLD_IS_A_FLOOR, NEAREST_IS_NAMED, DIRECTION_DECIDES, TIE_DOES_NOT_DISPLACE,
  SEAL_WRITES_NOTHING, POLICY_FROM_SETTLE, CYCLE_WHATEVER_THE_ORDER, EVERY_POLICY_REACHABLE,
  HONOURS_A_CUSTOM_BUDGET, PARETO_DIRECTION,
];

/** Seed and read must share one actor, or reads come back empty and a mutant passes. */
function store(records: RecordsModule): [SqlExecutor, ActorHandle] {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  records.initExplorationRecordsTable(execRaw);

  return [sql, createTestActors(sql, execRaw).main];
}

const CHEAPER: ObjectiveIdentity = {
  metric: 'oracle_calls',
  unit: 'oracle calls',
  direction: 'minimise',
  scale: 'log',
  verifierDigest: pristineRecords.verifierDigestOf(
    { kind: 'exec-ratio', spec: { params: { n: 24 } } }, 'exec-ratio@abc123',
  ),
};

const HIGHER: ObjectiveIdentity = { ...CHEAPER, metric: 'pass_rate', direction: 'maximise' };

const FLOOR: Floor = {
  value: 12,
  kind: 'certificate',
  bestKnownHonest: 23,
  proof: 'Every token must appear in at least one comparison and a comparison touches two.',
};

const OPEN: PublicationState = { kind: 'open' };

const BREACH: FloorBreach = {
  floor: FLOOR,
  measured: { kind: 'measured', value: 8, detail: '8 oracle calls' },
  margin: (23 - 12) / 23,
  hypotheses: ['floor_wrong', 'verifier_gameable'],
};

const SEALED: PublicationState = { kind: 'sealed', breach: BREACH, clearedBy: null };

const CELL = 'candOps=23';

const OCCUPANT = 'export function solve(input, oracle) { return input.tokens[0]; }';

/** One token away from {@link OCCUPANT}: distance 1/9. */
const NEAR = `${OCCUPANT} // tweak`;

/** No shared vocabulary at all, so distance 1. */
const FAR = 'const answer = 42;';

function write(over?: Partial<ExplorationWrite>): ExplorationWrite {
  return {
    identity: CHEAPER,
    descriptor: null,
    artifact: 'export function solve() { return 1; }',
    value: 23,
    detail: "23 oracle calls against the reference's 276",
    measured: { refOps: 276, candOps: 23 },
    preset: 'optimise',
    label: null,
    rootId: 'root-1',
    configDigest: 'cfg-1',
    depth: 5,
    branches: 3,
    floor: FLOOR,
    costUsd: null,
    costTokens: 4_096,
    at: 1_700_000_000_000,
    ...over,
  };
}

function cellWrite(over?: Partial<ArchiveWrite>): ArchiveWrite {
  return { ...write(), descriptor: CELL, artifact: OCCUPANT, ...over };
}

interface Origin {
  readonly at: Map<string, string>;
  readonly readOrigin: (path: string) => Promise<string | null>;
  readonly applyMember: MemberApply;
}

function originOf(initial: Record<string, string>): Origin {
  const at = new Map(Object.entries(initial));

  return {
    at,
    readOrigin: async (path) => at.get(path) ?? null,
    applyMember: async (files) => {
      for (const file of files) {
        if (file.after === null) at.delete(file.path);
        else at.set(file.path, file.after);
      }
    },
  };
}

interface MergeMemberSeed {
  origin: Origin;
  module: MergeBackModule;
  nodeId: string;
  files: readonly MemberFileChange[];
  deps?: readonly string[];
}

async function memberOf(
  { origin, module, nodeId, files, deps = [] }: MergeMemberSeed,
): Promise<MergeMember> {
  const diff = { nodeId, files: [...files], provenance: 'private-home' as const };

  return {
    nodeId,
    diff,
    verdict: {
      memberDigest: module.memberDigestOf(diff),
      baseDigest: await module.baseDigestOf(diff, origin.readOrigin),
      clean: true,
    },
    scope: null,
    deps,
    score: 1,
  };
}

function runMerge(
  module: MergeBackModule, origin: Origin, policy: MergePolicy,
  members: readonly MergeMember[],
): Promise<MergeBackReport> {
  return module.mergeBack({ policy, members }, {
    log: createRecordingLogger(),
    preset: 'mutation',
    readOrigin: origin.readOrigin,
    applyMember: origin.applyMember,
  });
}

function swarmConfig(over?: Partial<SwarmConfig>): SwarmConfig {
  return {
    unit: { kind: 'answer' },
    context: 'inherit',
    expand: 'sample',
    score: { kind: 'verify' },
    advance: { kind: 'uct' },
    carry: { kind: 'none' },
    ...over,
  };
}

function caps(depth: number, branches: number): ResolvedSwarmCaps {
  return {
    depth: { value: depth, origin: 'call' },
    branches: { value: branches, origin: 'call' },
  };
}

function proposal(width: number): BranchProposal {
  return {
    rationale: 'this thread deserves its own budget',
    branches: Array.from({ length: width }, (_unused, i) => ({
      task: `sub-question ${String(i)}`, rationale: 'r', context: 'inherit' as const,
    })),
  };
}

/** {@link THRESHOLD_IS_A_FLOOR}. */
async function thresholdIsAFloor(archive: ArchiveModule): Promise<void> {
  const permissive = store(pristineRecords);
  archive.admitToArchive(...permissive, { publication: OPEN, write: cellWrite(), novelty: 0 });
  expect(archive.admitToArchive(...permissive, {
    publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0,
  }).kind).toBe('recorded');

  const strict = store(pristineRecords);
  archive.admitToArchive(...strict, { publication: OPEN, write: cellWrite(), novelty: 1 });
  expect(archive.admitToArchive(...strict, {
    publication: OPEN, write: cellWrite({ artifact: FAR, value: 31 }), novelty: 1,
  }).kind).toBe('recorded');
  expect(archive.admitToArchive(...strict, {
    publication: OPEN,
    write: cellWrite({ artifact: `${OCCUPANT} const answer = 42;`, value: 17 }),
    novelty: 1,
  })).toMatchObject({ kind: 'refused', cause: 'too-close' });
}

/** {@link NEAREST_IS_NAMED}. */
async function nearestIsNamed(archive: ArchiveModule): Promise<void> {
  const board = store(pristineRecords);
  archive.admitToArchive(...board, {
    publication: OPEN, write: cellWrite({ artifact: FAR, value: 11 }), novelty: 0.5,
  });
  archive.admitToArchive(...board, {
    publication: OPEN, write: cellWrite({ artifact: OCCUPANT, value: 40 }), novelty: 0.5,
  });
  expect(pristineRecords.bestInCell(...board, {
    identity: CHEAPER, floor: FLOOR, descriptor: CELL,
  })?.artifact).toBe(FAR);
  expect(archive.admitToArchive(...board, {
    publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
  })).toMatchObject({
    cause: 'too-close',
    distance: pristineArchive.noveltyDistance(NEAR, OCCUPANT),
  });
}

/** {@link DIRECTION_DECIDES}. */
async function directionDecides(records: RecordsModule): Promise<void> {
  const board = store(records);
  records.recordExploration(...board, {
    publication: OPEN, write: write({ identity: HIGHER, value: 0.6 }),
  });
  expect(records.recordExploration(...board, {
    publication: OPEN, write: write({ identity: HIGHER, value: 0.4 }),
  })).toEqual({ kind: 'refused', cause: 'not-better' });
  expect(records.recordExploration(...board, {
    publication: OPEN, write: write({ identity: HIGHER, value: 0.9 }),
  }).kind).toBe('recorded');
  expect(records.bestInCell(...board, {
    identity: HIGHER, floor: FLOOR, descriptor: null,
  })?.value).toBe(0.9);
}

/** {@link PARETO_DIRECTION}. */
async function paretoDirectionDecides(objective: ObjectiveModule): Promise<void> {
  const front = objective.paretoFront([
    { id: 'quality', direction: 'maximise' },
    { id: 'cost', direction: 'minimise' },
  ], [
    { id: 'high-quality-expensive', evidence: { quality: 0.9, cost: 10 } },
    { id: 'lower-quality-cheap', evidence: { quality: 0.8, cost: 2 } },
    { id: 'worse-both', evidence: { quality: 0.7, cost: 12 } },
  ]);

  expect(front.map((candidate) => candidate.id))
    .toEqual(['high-quality-expensive', 'lower-quality-cheap']);
}

/** {@link TIE_DOES_NOT_DISPLACE}. */
async function tieDoesNotDisplace(records: RecordsModule): Promise<void> {
  const board = store(records);
  records.recordExploration(...board, { publication: OPEN, write: write() });
  expect(records.recordExploration(...board, { publication: OPEN, write: write() }))
    .toEqual({ kind: 'refused', cause: 'not-better' });
  expect(records.recordsFor(...board, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
}

/** {@link SEAL_WRITES_NOTHING}. */
async function sealWritesNothing(records: RecordsModule): Promise<void> {
  const board = store(records);
  expect(records.recordExploration(...board, { publication: SEALED, write: write() }))
    .toEqual({ kind: 'refused', cause: 'sealed' });
  expect(records.recordsFor(...board, { identity: CHEAPER, floor: FLOOR })).toHaveLength(0);
}

/** {@link POLICY_FROM_SETTLE}. */
async function policyFromSettle(mergeBack: MergeBackModule): Promise<void> {
  expect(mergeBack.mergePolicyOf('best')).toBe('apply-winner');
  expect(mergeBack.mergePolicyOf('archive')).toBe('sequential-rebase');
  expect(mergeBack.mergePolicyOf('front')).toBe('sequential-rebase');
  expect(mergeBack.mergePolicyOf('merge')).toBe('synthesis');
}

/** {@link CYCLE_WHATEVER_THE_ORDER}. */
async function cycleWhateverTheOrder(mergeBack: MergeBackModule): Promise<void> {
  const origin = originOf({ 'a.ts': 'A0\n', 'b.ts': 'B0\n', 'c.ts': 'C0\n' });

  const a = await memberOf({
    origin, module: mergeBack, nodeId: 'n1',
    files: [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }],
  });

  const b = await memberOf({
    origin, module: mergeBack, nodeId: 'n2',
    files: [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }], deps: ['n3'],
  });

  const c = await memberOf({
    origin, module: mergeBack, nodeId: 'n3',
    files: [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], deps: ['n2'],
  });

  const report = await runMerge(mergeBack, origin, 'sequential-rebase', [a, b, c]);
  const [outcome] = report.outcomes;
  expect(outcome?.kind).toBe('refused');

  if (outcome?.kind !== 'refused') return;
  expect(outcome.refusal.cause).toBe('dependency-cycle');
  expect(outcome.refusal.error).toContain('n2 -> n3 -> n2');
  expect(origin.at.get('a.ts')).toBe('A0\n');
}

/** {@link EVERY_POLICY_REACHABLE}. */
async function everyPolicyReachable(budget: SwarmBudgetModule): Promise<void> {
  const decisions = [
    new budget.SwarmBudget(10).arbitrate({
      config: swarmConfig({ advance: { kind: 'none' } }),
      caps: caps(1, 3), atDepth: 0, proposal: proposal(2),
    }),
    new budget.SwarmBudget(10).arbitrate({
      config: swarmConfig(), caps: caps(5, 3), atDepth: 1, proposal: proposal(9),
    }),
    new budget.SwarmBudget(10).arbitrate({
      config: swarmConfig(), caps: caps(1, 3), atDepth: 1, proposal: proposal(2),
    }),
    new budget.SwarmBudget(1).arbitrate({
      config: swarmConfig(), caps: caps(5, 3), atDepth: 3, proposal: proposal(2),
    }),
    new budget.SwarmBudget(10).arbitrate({
      config: swarmConfig({ context: 'fresh' }), caps: caps(5, 3), atDepth: 1, proposal: proposal(2),
    }),
  ];

  const reached = decisions.flatMap(
    (decision) => (decision.kind === 'refused' ? [decision.policy] : []),
  );

  expect(reached).toEqual([...BRANCH_REFUSAL_POLICIES]);
}

/** {@link HONOURS_A_CUSTOM_BUDGET}. */
async function honoursACustomBudget(clamp: ClampModule): Promise<void> {
  const clamped = await clamp.clampToolResult('a'.repeat(50_000));
  expect(clamped.length).toBeLessThanOrEqual(clamp.DEFAULT_TOOL_RESULT_MAX_CHARS);
}

function mutantOf(src: string, label: string, edits: readonly (readonly [string, string])[]) {
  const at = writeMutants(label, [{ src, edits }]);

  return import(at(src));
}

/** Imports the mutant through an unedited dependent copy. */
function mutantThrough(
  src: string, dependent: string, label: string, edits: readonly (readonly [string, string])[],
) {
  const at = writeMutants(label, [{ src, edits }, { src: dependent }]);

  return import(at(dependent));
}

describe('the archive novelty comparison is load-bearing', () => {
  test('GREEN: the floor admits at the threshold and refuses below it', async () => {
    await thresholdIsAFloor(pristineArchive);
  });

  // Both readings refuse something, so one threshold cannot tell them apart.
  test(`RED: reading the floor as a ceiling turns "${THRESHOLD_IS_A_FLOOR.name}" red`, async () => {
    const mutant: ArchiveModule = await mutantOf('strategy/archive.ts', 'floor-as-ceiling', [
      [NOVELTY_FLOOR, 'if (nearest !== null && nearest.distance > novelty) {'],
    ]);

    await expect(thresholdIsAFloor(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });

  test('GREEN: the refusal names the nearest occupant', async () => {
    await nearestIsNamed(pristineArchive);
  });

  // Inverts independently of the floor: keeping the farthest occupant leaves the floor test green.
  test(`RED: searching for the farthest occupant turns "${NEAREST_IS_NAMED.name}" red`, async () => {
    const mutant: ArchiveModule = await mutantOf('strategy/archive.ts', 'farthest-occupant', [
      [NEAREST_SEARCH,
        'if (nearest === null || distance > nearest.distance) nearest = { occupant, distance };'],
    ]);

    await expect(nearestIsNamed(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe('`isBetter` is load-bearing in its direction and in its strictness', () => {
  test('GREEN: the direction decides which way is better', async () => {
    await directionDecides(pristineRecords);
  });

  test(`RED: swapping the direction arms turns "${DIRECTION_DECIDES.name}" red`, async () => {
    const mutant: RecordsModule = await mutantThrough('strategy/objective.ts', 'strategy/records.ts', 'direction-swapped', [
      [IS_BETTER,
        "return direction === 'minimise' ? candidate > incumbent : candidate < incumbent;"],
    ]);

    await expect(directionDecides(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });

  test('GREEN: a tie does not displace', async () => {
    await tieDoesNotDisplace(pristineRecords);
  });

  // No monotonicity property catches this relaxation (`RecordsStore.lean —
  // the_tie_rule_is_not_what_makes_it_monotone`, `RecordsStore.lean — lenient_best_never_falls`),
  // so this is the strictness's only gate.
  test(`RED: relaxing the comparison to accept a tie turns "${TIE_DOES_NOT_DISPLACE.name}" red`, async () => {
    const mutant: RecordsModule = await mutantThrough('strategy/objective.ts', 'strategy/records.ts', 'tie-admitted', [
      [IS_BETTER,
        "return direction === 'minimise' ? candidate <= incumbent : candidate >= incumbent;"],
    ]);

    await expect(tieDoesNotDisplace(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe('the publication seal is load-bearing', () => {
  test('GREEN: a breached run writes nothing', async () => {
    await sealWritesNothing(pristineRecords);
  });

  // Reading the cleared field inverted publishes exactly the run the seal withholds.
  test(`RED: reading the cleared seal inverted turns "${SEAL_WRITES_NOTHING.name}" red`, async () => {
    const mutant: RecordsModule = await mutantThrough('strategy/objective.ts', 'strategy/records.ts', 'seal-inverted', [
      [SEAL_CLEARED, "if (state.clearedBy === null) return { kind: 'admitted' };"],
    ]);

    await expect(sealWritesNothing(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe('the merge policy derivation is load-bearing', () => {
  test('GREEN: each settle shape maps to its policy', async () => {
    await policyFromSettle(pristineMergeBack);
  });

  // Returning another real policy typechecks and runs, applying every member instead of the winner.
  test(`RED: pointing 'best' at another real policy turns "${POLICY_FROM_SETTLE.name}" red`, async () => {
    const mutant: MergeBackModule = await mutantOf('strategy/merge-back.ts', 'best-rebases', [
      [POLICY_BEST, "case 'best': return 'sequential-rebase';"],
    ]);

    await expect(policyFromSettle(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe("the cycle scan's all-or-nothing is load-bearing", () => {
  test('GREEN: a cycle refuses the whole set, orderable prefix included', async () => {
    await cycleWhateverTheOrder(pristineMergeBack);
  });

  // Skipping the scan applies the orderable prefix of an unorderable set and reports `applied`.
  test(`RED: skipping the cycle scan turns "${CYCLE_WHATEVER_THE_ORDER.name}" red`, async () => {
    const mutant: MergeBackModule = await mutantOf('strategy/merge-back.ts', 'no-cycle-scan', [
      [CYCLE_SCAN, 'if (true) continue;\n\n    const stuck = new Map('],
    ]);

    await expect(cycleWhateverTheOrder(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe('budget arbitration is load-bearing', () => {
  test('GREEN: every refusal policy is still reachable through the budget', async () => {
    await everyPolicyReachable(pristineSwarmBudget);
  });

  // Inverted, the arbiter accepts a width-two proposal with one child of room and makes
  // `context-conflict` unreachable, while every verdict still looks legal.
  test(`RED: inverting the room comparison turns "${EVERY_POLICY_REACHABLE.name}" red`, async () => {
    const mutant: SwarmBudgetModule = await mutantThrough('strategy/swarm.ts', 'strategy/swarm-budget.ts', 'room-inverted', [
      [BUDGET_ROOM, 'if (remainingChildren > width) {'],
    ]);

    await expect(everyPolicyReachable(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe('the clamp arithmetic is load-bearing', () => {
  test('GREEN: the shared budget is honoured', async () => {
    await honoursACustomBudget(pristineClamp);
  });

  // Head and tail must sum to what the marker leaves; a whole-cap tail nearly doubles the result.
  test(`RED: giving the tail the whole cap turns "${HONOURS_A_CUSTOM_BUDGET.name}" red`, async () => {
    const mutant: ClampModule = await mutantOf('tools/clamp.ts', 'tail-takes-the-cap', [
      [CLAMP_TAIL, 'const tail = text.slice(tailStart(text, DEFAULT_TOOL_RESULT_MAX_CHARS));'],
    ]);

    await expect(honoursACustomBudget(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe('Pareto direction is load-bearing', () => {
  test('GREEN: each declared vector direction is honoured', async () => {
    await paretoDirectionDecides(pristineObjective);
  });

  test(`RED: weakening a minimise axis turns "${PARETO_DIRECTION.name}" red`, async () => {
    const mutant: ObjectiveModule = await mutantOf('strategy/objective.ts', 'pareto-direction-inverted', [
      [PARETO_WEAKER, "if (axis.direction === 'maximise' ? l < r : l < r) return false;"],
    ]);

    await expect(paretoDirectionDecides(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

describe('the harness cannot prove a guard it did not remove', () => {
  test('a snippet that is not present exactly once throws instead of passing', () => {
    expect(() => writeMutants('bogus', [
      { src: 'strategy/objective.ts', edits: [['a snippet objective.ts does not contain', '']] },
    ])).toThrow('found 0');
  });

  test('every snippet this file mutates sits in its file exactly once', () => {
    const moved = SNIPPETS.filter(([src, snippet]) => {
      const source = readFileSync(resolve(SRC, src), 'utf8');

      return source.split(snippet).length - 1 !== 1;
    }).map(([src, snippet]) => `${src}: ${snippet.slice(0, 40)}`);

    expect(moved).toEqual([]);
  });

  // RED proofs run this file's copy of the assertions, so the named titles must still exist.
  test('every defended test exists exactly once where it is claimed', () => {
    const missing = DEFENDED.filter((defended) => {
      const source = readFileSync(resolve(TEST_DIR, defended.file), 'utf8');

      return source.split(`test('${defended.name}'`).length - 1
        + source.split(`test("${defended.name}"`).length - 1 !== 1;
    }).map((defended) => `${defended.file}: ${defended.name}`);

    expect(missing).toEqual([]);
  });

  test('a plan may not ask for a copy it did not declare', () => {
    const at = writeMutants('undeclared', [{ src: 'tools/clamp.ts' }]);
    expect(() => at('strategy/objective.ts')).toThrow('is not in mutation');
  });
});
