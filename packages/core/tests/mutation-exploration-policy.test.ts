// Seven exploration policy decisions, PROVEN load-bearing by inverting them.
//
// Every decision here is a comparison, a precedence or a bound whose two readings are
// both plausible: `distance < novelty` and `distance > novelty`, `candidate < incumbent`
// and `candidate <= incumbent`, `'best' -> 'apply-winner'` and `'best' -> anything else`.
// An inversion of one of those changes no type, throws nothing, and leaves a suite green
// unless some test pins the direction — so a green suite is not evidence the direction is
// right. This file is that evidence: each mutation is applied mechanically and the NAMED
// test that defends it is executed against the mutant and required to fail.
//
// WHAT "TURNS A NAMED TEST RED" MEANS HERE, and it is executed rather than claimed. Each
// mutation carries a {@link Defended} — a file and an exact `test(...)` title — and a
// `defence` function whose body is that test's own assertions. The defence is run twice:
// against the pristine module, where it must pass, and against the mutant, where it must
// reject. A defence that passed both ways would prove the mutation harmless, and a
// defence naming a test that does not exist would prove nothing at all, so
// `every defended test exists exactly once where it is claimed` asserts the titles
// against the files. Both halves are needed: the first says the mutation matters, the
// second says the claim about which test catches it is true.
//
// WHY A MUTANT COPY AND NOT THE REAL FILE — the same reason `mutation-merge-back.test.ts`
// gives. Editing `src/strategy/objective.ts` in place would open a window in which any
// other test file loading that module gets the mutant, and a crash mid-run would leave
// the source inverted. Each mutation is written to its own throwaway modules beside this
// file, imported once, and removed.
//
// AND THE COPY IS A CLOSURE, which is the one thing this harness adds over that file's.
// `isBetter` and `admitsPublication` are observable only through `records.ts`, and a
// mutant `objective.ts` beside a pristine `records.ts` would be a mutation nothing can
// see — the suite would go green and read as proof. So a plan may copy a DEPENDENT with
// no edits at all, and every copied file's relative imports are re-pointed at the copies
// beside it rather than at the originals.
//
// EVERY MUTATION ASSERTS IT LANDED. `writeMutants` requires each snippet to occur EXACTLY
// once and throws otherwise, because a mutation whose edit silently missed is a test that
// proves a guard is load-bearing by never removing it.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { makeExecRaw, makeSql } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import * as pristineArchive from '../src/strategy/archive';
import * as pristineClamp from '../src/tools/clamp';
import * as pristineMergeBack from '../src/strategy/merge-back';
import * as pristineRecords from '../src/strategy/records';
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
import type { SqlExecutor } from '../src/types/primitives';

type ArchiveModule = typeof pristineArchive;
type ClampModule = typeof pristineClamp;
type MergeBackModule = typeof pristineMergeBack;
type RecordsModule = typeof pristineRecords;
type SwarmBudgetModule = typeof pristineSwarmBudget;

const HERE = new URL('.', import.meta.url).pathname;
const SRC = new URL('../src/', import.meta.url).pathname;

/** A file to copy, and what to change in it. */
interface Copy {
  /** Path under `packages/core/src/`, for example `strategy/objective.ts`. */
  readonly src: string;
  /** Literal find/replace pairs. Absent when the file is copied only so that it imports
   *  the mutants beside it rather than the pristine originals. */
  readonly edits?: readonly (readonly [find: string, replace: string])[];
}

const written: string[] = [];

afterAll(() => {
  for (const path of written) rmSync(path, { force: true });
});

/**
 * Write every file in `plan` beside this test file with its edits applied, and answer
 * with a lookup from planned `src` to the copy's path.
 *
 * A copied file's relative imports are resolved against ITS OWN directory and re-emitted
 * relative to this one, so a specifier pointing at another copied file lands on that
 * file's copy and every other specifier lands on the untouched original.
 */
function writeMutants(label: string, plan: readonly Copy[]): (src: string) => string {
  // A copy is named so the `*.test.ts` glob cannot match it and the runner never treats a
  // mutant as a suite of its own.
  const target = new Map(plan.map((copy) => [
    resolve(SRC, copy.src),
    resolve(HERE, `policy.mutant-${label}-${copy.src.replaceAll('/', '-')}`),
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
        const path = relative(HERE, to);
        return `from '${path.startsWith('.') ? path : `./${path}`}'`;
      },
    );
    const at = target.get(origin);
    if (at === undefined) throw new Error(`no copy planned for ${copy.src}`);
    writeFileSync(at, rewritten);
    written.push(at);
  }
  return (src) => {
    const at = target.get(resolve(SRC, src));
    if (at === undefined) throw new Error(`${src} is not in mutation "${label}"'s plan`);
    return at;
  };
}

/* ── The snippets, and the readings that invert them ──────────────────────── */

const NOVELTY_FLOOR = 'if (nearest !== null && nearest.distance < novelty) {';
const NEAREST_SEARCH =
  'if (nearest === null || distance < nearest.distance) nearest = { occupant, distance };';
const IS_BETTER =
  "return direction === 'minimise' ? candidate < incumbent : candidate > incumbent;";
const SEAL_CLEARED = "if (state.clearedBy !== null) return { kind: 'admitted' };";
const POLICY_BEST = "case 'best': return 'apply-winner';";
const CYCLE_SCAN = 'if (placed.has(member.nodeId)) continue;\n    const stuck = new Map(';
const BUDGET_ROOM = 'if (remainingChildren < width) {';
const CLAMP_TAIL = 'const tailLen = maxChars - headLen;';

/** Every snippet above, against the file it must sit in exactly once. */
const SNIPPETS: readonly (readonly [src: string, snippet: string])[] = [
  ['strategy/archive.ts', NOVELTY_FLOOR],
  ['strategy/archive.ts', NEAREST_SEARCH],
  ['strategy/objective.ts', IS_BETTER],
  ['strategy/objective.ts', SEAL_CLEARED],
  ['strategy/merge-back.ts', POLICY_BEST],
  ['strategy/merge-back.ts', CYCLE_SCAN],
  ['strategy/swarm.ts', BUDGET_ROOM],
  ['tools/clamp.ts', CLAMP_TAIL],
];

/**
 * The first line of every failed `expect`, and a RED proof asserts the rejection contains
 * it.
 *
 * Without this, a mutation that made the module throw — a `ReferenceError`, a SQL error, a
 * bad import rewrite — would satisfy a bare `rejects.toThrow()` and the suite would report
 * the decision as defended when nothing had measured the decision at all. "The mutant blew
 * up" and "the defended assertion went false" are different facts, and only the second is
 * evidence.
 */
const ASSERTION_FAILED = 'expect(received)';

/* ── The tests each mutation must turn red ────────────────────────────────── */

/** A test that defends a decision: the file that holds it and its exact title. */
interface Defended {
  readonly file: string;
  readonly name: string;
}

const RECORDS_SUITE = 'unit-exploration-records.test.ts';
const MERGE_SUITE = 'unit-merge-back.test.ts';
const BUDGET_SUITE = 'unit-swarm-budget.test.ts';
const CLAMP_SUITE = 'unit-clamp-tool-result.test.ts';

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
  name: 'honours a custom budget',
};

const DEFENDED: readonly Defended[] = [
  THRESHOLD_IS_A_FLOOR, NEAREST_IS_NAMED, DIRECTION_DECIDES, TIE_DOES_NOT_DISPLACE,
  SEAL_WRITES_NOTHING, POLICY_FROM_SETTLE, CYCLE_WHATEVER_THE_ORDER, EVERY_POLICY_REACHABLE,
  HONOURS_A_CUSTOM_BUDGET,
];

/* ── Fixtures, the shapes the defended tests use ──────────────────────────── */

function store(records: RecordsModule): SqlExecutor {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  records.initExplorationRecordsTable(makeExecRaw(db));
  return sql;
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

async function memberOf(
  origin: Origin, module: MergeBackModule, nodeId: string,
  files: readonly MemberFileChange[], deps: readonly string[] = [],
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
    context: 'fork',
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
      task: `sub-question ${String(i)}`, rationale: 'r', context: 'fork' as const,
    })),
  };
}

/* ── The defences, each the body of the named test it stands for ───────────── */

/** {@link THRESHOLD_IS_A_FLOOR}. */
async function thresholdIsAFloor(archive: ArchiveModule): Promise<void> {
  const permissive = store(pristineRecords);
  archive.admitToArchive(permissive, { publication: OPEN, write: cellWrite(), novelty: 0 });
  expect(archive.admitToArchive(permissive, {
    publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0,
  }).kind).toBe('recorded');

  const strict = store(pristineRecords);
  archive.admitToArchive(strict, { publication: OPEN, write: cellWrite(), novelty: 1 });
  expect(archive.admitToArchive(strict, {
    publication: OPEN, write: cellWrite({ artifact: FAR, value: 31 }), novelty: 1,
  }).kind).toBe('recorded');
  expect(archive.admitToArchive(strict, {
    publication: OPEN,
    write: cellWrite({ artifact: `${OCCUPANT} const answer = 42;`, value: 17 }),
    novelty: 1,
  })).toMatchObject({ kind: 'refused', cause: 'too-close' });
}

/** {@link NEAREST_IS_NAMED}. */
async function nearestIsNamed(archive: ArchiveModule): Promise<void> {
  const sql = store(pristineRecords);
  archive.admitToArchive(sql, {
    publication: OPEN, write: cellWrite({ artifact: FAR, value: 11 }), novelty: 0.5,
  });
  archive.admitToArchive(sql, {
    publication: OPEN, write: cellWrite({ artifact: OCCUPANT, value: 40 }), novelty: 0.5,
  });
  expect(pristineRecords.bestInCell(sql, {
    identity: CHEAPER, floor: FLOOR, descriptor: CELL,
  })?.artifact).toBe(FAR);
  expect(archive.admitToArchive(sql, {
    publication: OPEN, write: cellWrite({ artifact: NEAR, value: 19 }), novelty: 0.5,
  })).toMatchObject({
    cause: 'too-close',
    distance: pristineArchive.noveltyDistance(NEAR, OCCUPANT),
  });
}

/** {@link DIRECTION_DECIDES}. */
async function directionDecides(records: RecordsModule): Promise<void> {
  const sql = store(records);
  records.recordExploration(sql, {
    publication: OPEN, write: write({ identity: HIGHER, value: 0.6 }),
  });
  expect(records.recordExploration(sql, {
    publication: OPEN, write: write({ identity: HIGHER, value: 0.4 }),
  })).toEqual({ kind: 'refused', cause: 'not-better' });
  expect(records.recordExploration(sql, {
    publication: OPEN, write: write({ identity: HIGHER, value: 0.9 }),
  }).kind).toBe('recorded');
  expect(records.bestInCell(sql, {
    identity: HIGHER, floor: FLOOR, descriptor: null,
  })?.value).toBe(0.9);
}

/** {@link TIE_DOES_NOT_DISPLACE}. */
async function tieDoesNotDisplace(records: RecordsModule): Promise<void> {
  const sql = store(records);
  records.recordExploration(sql, { publication: OPEN, write: write() });
  expect(records.recordExploration(sql, { publication: OPEN, write: write() }))
    .toEqual({ kind: 'refused', cause: 'not-better' });
  expect(records.recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(1);
}

/** {@link SEAL_WRITES_NOTHING}. */
async function sealWritesNothing(records: RecordsModule): Promise<void> {
  const sql = store(records);
  expect(records.recordExploration(sql, { publication: SEALED, write: write() }))
    .toEqual({ kind: 'refused', cause: 'sealed' });
  expect(records.recordsFor(sql, { identity: CHEAPER, floor: FLOOR })).toHaveLength(0);
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
  const a = await memberOf(origin, mergeBack, 'n1', [
    { path: 'a.ts', base: 'A0\n', after: 'A1\n' },
  ]);
  const b = await memberOf(origin, mergeBack, 'n2', [
    { path: 'b.ts', base: 'B0\n', after: 'B1\n' },
  ], ['n3']);
  const c = await memberOf(origin, mergeBack, 'n3', [
    { path: 'c.ts', base: 'C0\n', after: 'C1\n' },
  ], ['n2']);

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
  const clamped = await clamp.clampToolResult('a'.repeat(5_000), { maxChars: 1_000 });
  expect(clamped.length).toBeLessThan(1_400);
}

/* ── The mutants, one loader per closure ──────────────────────────────────── */

// THE SHARED GROUND FOR EVERY CAST BELOW: a mutant is the original module's own text with
// the edits applied, and `writeMutants` requires every edit to have matched exactly once —
// so its export shape is the pristine module's by construction. A dynamic specifier
// carries no static type, and a wrong rewrite of the import depths throws at import rather
// than producing a wrong shape.

function mutantArchive(
  label: string, edits: readonly (readonly [string, string])[],
): Promise<ArchiveModule> {
  const at = writeMutants(label, [{ src: 'strategy/archive.ts', edits }]);
  // SAFETY: `archive.ts`'s own text, one matched edit applied, so the export shape is
  // `pristineArchive`'s by construction.
  return import(at('strategy/archive.ts')) as Promise<ArchiveModule>;
}

/** `objective.ts` is only observable through `records.ts`, so the dependent is copied
 *  unedited and re-pointed at the mutant beside it. */
function mutantRecords(
  label: string, edits: readonly (readonly [string, string])[],
): Promise<RecordsModule> {
  const at = writeMutants(label, [
    { src: 'strategy/objective.ts', edits },
    { src: 'strategy/records.ts' },
  ]);
  // SAFETY: `records.ts`'s own text, unedited, importing the edited `objective.ts` beside
  // it — so the export shape is `pristineRecords`'s by construction.
  return import(at('strategy/records.ts')) as Promise<RecordsModule>;
}

function mutantMergeBack(
  label: string, edits: readonly (readonly [string, string])[],
): Promise<MergeBackModule> {
  const at = writeMutants(label, [{ src: 'strategy/merge-back.ts', edits }]);
  // SAFETY: `merge-back.ts`'s own text, one matched edit applied, so the export shape is
  // `pristineMergeBack`'s by construction.
  return import(at('strategy/merge-back.ts')) as Promise<MergeBackModule>;
}

/** `arbitrateBranch` is reached through the budget that debits it, so both travel. */
function mutantSwarmBudget(
  label: string, edits: readonly (readonly [string, string])[],
): Promise<SwarmBudgetModule> {
  const at = writeMutants(label, [
    { src: 'strategy/swarm.ts', edits },
    { src: 'strategy/swarm-budget.ts' },
  ]);
  // SAFETY: `swarm-budget.ts`'s own text, unedited, importing the edited `swarm.ts` beside
  // it — so the export shape is `pristineSwarmBudget`'s by construction.
  return import(at('strategy/swarm-budget.ts')) as Promise<SwarmBudgetModule>;
}

function mutantClamp(
  label: string, edits: readonly (readonly [string, string])[],
): Promise<ClampModule> {
  const at = writeMutants(label, [{ src: 'tools/clamp.ts', edits }]);
  // SAFETY: `clamp.ts`'s own text, one matched edit applied, so the export shape is
  // `pristineClamp`'s by construction.
  return import(at('tools/clamp.ts')) as Promise<ClampModule>;
}

/* ── The novelty comparison ───────────────────────────────────────────────── */

describe('the archive novelty comparison is load-bearing', () => {
  test('GREEN: the floor admits at the threshold and refuses below it', async () => {
    await thresholdIsAFloor(pristineArchive);
  });

  // Both readings refuse SOMETHING, which is why one threshold is not enough to tell
  // them apart: under `>` the archive refuses everything a floor should admit and admits
  // everything it should refuse, and a suite asserting only "a near-copy was refused"
  // stays green through the swap.
  test(`RED: reading the floor as a ceiling turns "${THRESHOLD_IS_A_FLOOR.name}" red`, async () => {
    const mutant = await mutantArchive('floor-as-ceiling', [
      [NOVELTY_FLOOR, 'if (nearest !== null && nearest.distance > novelty) {'],
    ]);
    await expect(thresholdIsAFloor(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });

  test('GREEN: the refusal names the nearest occupant', async () => {
    await nearestIsNamed(pristineArchive);
  });

  // A SECOND comparison on the same surface, and it inverts independently of the floor:
  // the fold that finds the nearest occupant keeps the closest, and keeping the farthest
  // leaves every threshold reading a distance no candidate collided with. Nothing throws
  // and the floor test above still passes, so only this one catches it.
  test(`RED: searching for the farthest occupant turns "${NEAREST_IS_NAMED.name}" red`, async () => {
    const mutant = await mutantArchive('farthest-occupant', [
      [NEAREST_SEARCH,
        'if (nearest === null || distance > nearest.distance) nearest = { occupant, distance };'],
    ]);
    await expect(nearestIsNamed(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

/* ── `isBetter`, in both of the ways it can be wrong ──────────────────────── */

describe('`isBetter` is load-bearing in its direction and in its strictness', () => {
  test('GREEN: the direction decides which way is better', async () => {
    await directionDecides(pristineRecords);
  });

  test(`RED: swapping the direction arms turns "${DIRECTION_DECIDES.name}" red`, async () => {
    const mutant = await mutantRecords('direction-swapped', [
      [IS_BETTER,
        "return direction === 'minimise' ? candidate > incumbent : candidate < incumbent;"],
    ]);
    await expect(directionDecides(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });

  test('GREEN: a tie does not displace', async () => {
    await tieDoesNotDisplace(pristineRecords);
  });

  // THE MUTATION THE PROOF ASKED FOR. `RecordsStore.lean —
  // the_tie_rule_is_not_what_makes_it_monotone` shows that admitting a tie leaves the
  // store's monotone invariant TRUE, and `RecordsStore.lean —
  // lenient_best_never_falls` shows it stays true over every trace. So no monotonicity
  // property can catch this relaxation and no proof will ever be the thing that defends
  // it — the strictness answers to the displacement count, and this is its only gate.
  test(`RED: relaxing the comparison to accept a tie turns "${TIE_DOES_NOT_DISPLACE.name}" red`, async () => {
    const mutant = await mutantRecords('tie-admitted', [
      [IS_BETTER,
        "return direction === 'minimise' ? candidate <= incumbent : candidate >= incumbent;"],
    ]);
    await expect(tieDoesNotDisplace(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

/* ── The seal ─────────────────────────────────────────────────────────────── */

describe('the publication seal is load-bearing', () => {
  test('GREEN: a breached run writes nothing', async () => {
    await sealWritesNothing(pristineRecords);
  });

  // The inversion is not "delete the check" — it is reading the cleared field the other
  // way, which is the mistake a reader makes on a field whose absence means "still
  // sealed". It publishes exactly the run §4.4 exists to withhold, and it is invisible
  // to any test that only ever asserts a re-derivation publishes again.
  test(`RED: reading the cleared seal inverted turns "${SEAL_WRITES_NOTHING.name}" red`, async () => {
    const mutant = await mutantRecords('seal-inverted', [
      [SEAL_CLEARED, "if (state.clearedBy === null) return { kind: 'admitted' };"],
    ]);
    await expect(sealWritesNothing(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

/* ── The merge policy derivation ──────────────────────────────────────────── */

describe('the merge policy derivation is load-bearing', () => {
  test('GREEN: each settle shape maps to its policy', async () => {
    await policyFromSettle(pristineMergeBack);
  });

  // A switch arm returning a policy that EXISTS is the dangerous shape: nothing
  // typechecks differently, `mergeBack` runs, and a scored settle silently applies every
  // member instead of its one winner.
  test(`RED: pointing 'best' at another real policy turns "${POLICY_FROM_SETTLE.name}" red`, async () => {
    const mutant = await mutantMergeBack('best-rebases', [
      [POLICY_BEST, "case 'best': return 'sequential-rebase';"],
    ]);
    await expect(policyFromSettle(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

/* ── The dependency order's all-or-nothing refusal ────────────────────────── */

describe("the cycle scan's all-or-nothing is load-bearing", () => {
  test('GREEN: a cycle refuses the whole set, orderable prefix included', async () => {
    await cycleWhateverTheOrder(pristineMergeBack);
  });

  // `mutation-merge-back.test.ts` already proves the ORDER is derived. This is the other
  // half and it inverts separately: skip the scan that finds an unplaced member and the
  // function returns `{ kind: 'ordered' }` carrying whatever the sweeps managed to place.
  // The merge then applies the orderable prefix of a set whose remainder can never land,
  // which is half a merge published — and it reports `applied`, not a refusal, so nothing
  // downstream can tell.
  test(`RED: skipping the cycle scan turns "${CYCLE_WHATEVER_THE_ORDER.name}" red`, async () => {
    const mutant = await mutantMergeBack('no-cycle-scan', [
      [CYCLE_SCAN, 'if (true) continue;\n    const stuck = new Map('],
    ]);
    await expect(cycleWhateverTheOrder(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

/* ── Budget arbitration ───────────────────────────────────────────────────── */

describe('budget arbitration is load-bearing', () => {
  test('GREEN: every refusal policy is still reachable through the budget', async () => {
    await everyPolicyReachable(pristineSwarmBudget);
  });

  // Inverting the conservation comparison makes the arbiter throw nothing and no single
  // budget go negative. What it does, measured against the reachability set: a proposal
  // with ONE child of room and a width of two is ACCEPTED, and a proposal with ten
  // children of room is refused `budget-exhausted` instead of reaching the context check
  // behind it. So the arm fires on the inputs it exists to pass and passes the inputs it
  // exists to refuse, `context-conflict` becomes unreachable, and every individual
  // verdict still looks legal.
  test(`RED: inverting the room comparison turns "${EVERY_POLICY_REACHABLE.name}" red`, async () => {
    const mutant = await mutantSwarmBudget('room-inverted', [
      [BUDGET_ROOM, 'if (remainingChildren > width) {'],
    ]);
    await expect(everyPolicyReachable(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

/* ── The clamp arithmetic ─────────────────────────────────────────────────── */

describe('the clamp arithmetic is load-bearing', () => {
  test('GREEN: a custom budget is honoured', async () => {
    await honoursACustomBudget(pristineClamp);
  });

  // The head and the tail must SUM to the cap. Taking the whole cap for the tail is the
  // arithmetic slip that leaves the result nearly twice its budget, and nothing throws:
  // the marker is still honest, the spill still round-trips, and the only observable is
  // a length nobody asserts unless a test pins it.
  test(`RED: giving the tail the whole cap turns "${HONOURS_A_CUSTOM_BUDGET.name}" red`, async () => {
    const mutant = await mutantClamp('tail-takes-the-cap', [
      [CLAMP_TAIL, 'const tailLen = maxChars;'],
    ]);
    await expect(honoursACustomBudget(mutant)).rejects.toThrow(ASSERTION_FAILED);
  });
});

/* ── The harness cannot prove a guard it did not remove ───────────────────── */

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

  // A mutation that claims to turn a named test red proves nothing if the name has
  // rotted: the RED assertion above would still pass, because it runs THIS file's copy of
  // the assertions rather than that file's test. So the titles are checked against the
  // files that hold them.
  test('every defended test exists exactly once where it is claimed', () => {
    const missing = DEFENDED.filter((defended) => {
      const source = readFileSync(resolve(HERE, defended.file), 'utf8');
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
