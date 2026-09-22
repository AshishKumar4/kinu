// Merge-back policies and refusals; the size and stale-verdict refusals are red-proven in
// mutation-merge-back.test.ts. Specified by docs/EXPLORATION.md — "Merge-back" and
// "The publication seal".
import { describe, test, expect } from 'bun:test';
import { MAX_TX_BLOB_BYTES, MAX_TX_LOGICAL_ROWS } from '@nimbus-sh/core/constants.js';
import { present } from '@kinu.run/test-utils';
import { createRecordingLogger, type RecordingLogger } from '../src/obs/index';
import {
  MERGE_POLICIES, SETTLE_RULES, APPLY_PRECONDITIONS, TRANSACTION_BOUNDS,
  mergePolicyOf, memberDigestOf, baseDigestOf, planMemberApply,
  memberApplyBound, mergeBack, admitCarry, settleCarry,
  type DiffProvenance, type MemberApply, type MemberDiff, type MemberFileChange,
  type MergeBackReport, type MergeMember, type MergeNodeRequest, type MergePolicy,
  type Reverifier,
} from '../src/strategy/merge-back';
import type { PublicationState } from '../src/strategy/objective';
import type { SwarmCarrySetting } from '../src/strategy/swarm';

interface FakeOrigin {
  readonly at: Map<string, string>;
  readonly readOrigin: (path: string) => Promise<string | null>;
  readonly applyMember: MemberApply;
  /** One entry per `applyMember` call; the length is the transaction count. */
  readonly transactions: (readonly MemberFileChange[])[];
}

function fakeOrigin(initial: Record<string, string> = {}): FakeOrigin {
  const at = new Map(Object.entries(initial));
  const transactions: (readonly MemberFileChange[])[] = [];

  return {
    at,
    transactions,
    readOrigin: async (path) => at.get(path) ?? null,
    applyMember: async (files) => {
      transactions.push(files);
      // Staged then committed, so a throw mid-way leaves nothing behind.
      const staged = new Map(at);

      for (const file of files) {
        if (file.after === null) staged.delete(file.path);
        else staged.set(file.path, file.after);
      }

      at.clear();

      for (const [path, content] of staged) at.set(path, content);
    },
  };
}

function diffOf(
  nodeId: string,
  files: readonly MemberFileChange[],
  provenance: DiffProvenance = 'private-home',
): MemberDiff {
  return { nodeId, files: [...files].sort((a, b) => a.path.localeCompare(b.path)), provenance };
}

/** Staleness comes only from moving the origin, never a hand-written digest. */
async function memberOf(
  origin: FakeOrigin,
  nodeId: string,
  files: readonly MemberFileChange[],
  over: Partial<MergeMember> & { readonly provenance?: DiffProvenance } = {},
): Promise<MergeMember> {
  const { provenance, ...rest } = over;
  const diff = diffOf(nodeId, files, provenance);

  return {
    nodeId,
    diff,
    verdict: {
      memberDigest: memberDigestOf(diff),
      baseDigest: await baseDigestOf(diff, origin.readOrigin),
      clean: true,
    },
    scope: null,
    deps: [],
    score: 1,
    ...rest,
  };
}

interface Harness {
  readonly origin: FakeOrigin;
  readonly log: RecordingLogger;
  readonly run: (
    policy: MergePolicy,
    members: readonly MergeMember[],
    over?: {
      readonly applyMember?: MemberApply | undefined;
      readonly reverify?: Reverifier;
      readonly spawnMergeNode?: (request: MergeNodeRequest) => Promise<string>;
      readonly settled?: readonly string[];
    },
  ) => Promise<MergeBackReport>;
}

function recordClean(asked: string[]) {
  return async ({ member, baseDigest }: { member: { nodeId: string; diff: Parameters<typeof memberDigestOf>[0] }; baseDigest: string }) => {
    asked.push(member.nodeId);

    return { memberDigest: memberDigestOf(member.diff), baseDigest, clean: true };
  };
}

function harness(initial: Record<string, string> = {}): Harness {
  const origin = fakeOrigin(initial);
  const log = createRecordingLogger();

  return {
    origin,
    log,
    run: (policy, members, over = {}) => mergeBack({ policy, members, settled: over.settled }, {
      log,
      preset: 'test',
      readOrigin: origin.readOrigin,
      applyMember: 'applyMember' in over ? over.applyMember : origin.applyMember,
      reverify: over.reverify,
      spawnMergeNode: over.spawnMergeNode,
    }),
  };
}

function named(log: RecordingLogger, event: string) {
  return log.emitted.filter((line) => line.event === event);
}

describe('the policy is derived from settle, never chosen', () => {
  test('each settle shape maps to the policy *Merge-back* derives', () => {
    expect(mergePolicyOf('best')).toBe('apply-winner');
    expect(mergePolicyOf('archive')).toBe('sequential-rebase');
    expect(mergePolicyOf('front')).toBe('sequential-rebase');
    expect(mergePolicyOf('merge')).toBe('synthesis');
  });

  // `synthesis` must exist: a list missing it would still typecheck.
  test('synthesis is a named policy and not an unhandled settle', () => {
    expect(MERGE_POLICIES).toContain('synthesis');
    expect(mergePolicyOf('merge')).toBe('synthesis');
  });


  test("the six settle rules and the substrate's preconditions stay distinct lists", () => {
    expect(SETTLE_RULES).toHaveLength(6);
    // Widened by assignment: disjoint literal types would make `toContain` unable to fail.
    const rules: readonly string[] = SETTLE_RULES;

    for (const precondition of APPLY_PRECONDITIONS) {
      expect(rules).not.toContain(precondition);
    }
  });
});

describe('apply-winner', () => {
  test("the winner's diff reaches the origin", async () => {
    const h = harness({ 'a.ts': 'old\n' });

    const winner = await memberOf(h.origin, 'n1', [
      { path: 'a.ts', base: 'old\n', after: 'new\n' },
      { path: 'b.ts', base: null, after: 'added\n' },
    ]);

    const report = await h.run('apply-winner', [winner]);

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied']);
    expect(report.stoppedAt).toBeNull();
    expect(h.origin.at.get('a.ts')).toBe('new\n');
    expect(h.origin.at.get('b.ts')).toBe('added\n');
  });

  // A per-file loop would show two transactions here.
  test('a member rides exactly one transaction, whatever its file count', async () => {
    const h = harness({ 'a.ts': 'old\n' });

    const winner = await memberOf(h.origin, 'n1', [
      { path: 'a.ts', base: 'old\n', after: '1\n' },
      { path: 'b.ts', base: null, after: '2\n' },
      { path: 'c.ts', base: null, after: '3\n' },
    ]);

    await h.run('apply-winner', [winner]);

    expect(h.origin.transactions).toHaveLength(1);
    expect(h.origin.transactions[0]).toHaveLength(3);
  });

  test('every other diff is discarded, even when offered', async () => {
    const h = harness({});
    const winner = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'won\n' }]);
    const loser = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: null, after: 'lost\n' }]);

    const report = await h.run('apply-winner', [winner, loser]);

    expect(report.outcomes).toHaveLength(1);
    expect(h.origin.at.has('b.ts')).toBe(false);
    expect(h.origin.transactions).toHaveLength(1);
  });

  test('a refused winner lands nothing — the losers stay discarded', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const winner = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const loser = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    const report = await h.run('apply-winner', [{
      ...winner, verdict: { ...present(winner.verdict, "winner's verdict"), clean: false },
    }, loser]);

    expect(report.outcomes.map((o) => o.kind)).toEqual(['refused']);
    expect(report.stoppedAt).toBe('n1');
    expect(h.origin.at.get('b.ts')).toBe('B0\n');
  });

  test('a deletion is applied as a deletion', async () => {
    const h = harness({ 'gone.ts': 'bye\n' });
    const winner = await memberOf(h.origin, 'n1', [{ path: 'gone.ts', base: 'bye\n', after: null }]);

    await h.run('apply-winner', [winner]);

    expect(h.origin.at.has('gone.ts')).toBe(false);
  });

  test('the apply emits swarm.merge_applied with fields', async () => {
    const h = harness({});
    const winner = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'hello\n' }]);

    await h.run('apply-winner', [winner]);

    const [applied] = named(h.log, 'swarm.merge_applied');
    expect(applied?.fields).toMatchObject({
      preset: 'test', policy: 'apply-winner', node: 'n1', files: 1, bytes: 6,
    });
  });
});

describe('sequential-rebase', () => {
  test('diffs land in tree order, each onto the result of the last', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    const report = await h.run('sequential-rebase', [first, second]);

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(h.origin.at.get('a.ts')).toBe('A1\n');
    expect(h.origin.at.get('b.ts')).toBe('B1\n');
    // One transaction per member, so a later failure cannot roll back an earlier success.
    expect(h.origin.transactions).toHaveLength(2);
  });

  // No re-verification wired, so the fail-closed answer is to refuse.
  test('a member whose base moved is refused when nothing can re-verify it', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    // Same content: not a conflict, only a moved base (rule 4).
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    const report = await h.run('sequential-rebase', [first, second]);

    expect(report.stoppedAt).toBeNull();
    const [, outcome] = report.outcomes;
    expect(outcome?.kind).toBe('refused');

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('verdict-stale');
    expect(outcome.refusal.reason).toBe('unavailable');
    expect(outcome.refusal.error).toContain('stale verdict never applies');
    expect(h.origin.at.get('shared.ts')).toBe('V1\n');
  });

  test('a base change forces re-verification through the registry before apply', async () => {
    const h = harness({ 'shared.ts': 'V0\n', 'own.ts': 'O0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    const second = await memberOf(h.origin, 'n2', [
      { path: 'shared.ts', base: 'V0\n', after: 'V1\n' },
      { path: 'own.ts', base: 'O0\n', after: 'O1\n' },
    ]);

    const asked: string[] = [];

    const report = await h.run('sequential-rebase', [first, second], {
      reverify: recordClean(asked),
    });

    expect(asked).toEqual(['n2']);
    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(h.origin.at.get('own.ts')).toBe('O1\n');
  });

  test('a member whose base did not move is not re-verified', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    const asked: string[] = [];
    await h.run('sequential-rebase', [first, second], {
      reverify: recordClean(asked),
    });

    expect(asked).toEqual([]);
  });

  test('a re-verification that does not pass refuses', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      reverify: async ({ member, baseDigest }) => ({
        memberDigest: memberDigestOf(member.diff), baseDigest, clean: false,
      }),
    });

    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('verdict-stale');
    expect(outcome.refusal.error).toContain('did not pass');
  });

  test('a re-verification bound to a different base does not revalidate the apply', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      reverify: async ({ member }) => ({
        memberDigest: memberDigestOf(member.diff), baseDigest: 'some-other-base', clean: true,
      }),
    });

    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('verdict-stale');
    expect(outcome.refusal.error).toContain('different base');
  });

  test('a refusal from the registry travels as its own reason, not as prose', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      reverify: async () => ({ reason: 'unsupported', error: 'no verifier for this unit' }),
    });

    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.reason).toBe('unsupported');
    expect(outcome.refusal.cause).toBe('verdict-stale');
  });

  test('the stale refusal emits swarm.merge_refused with the cause as a field', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    await h.run('sequential-rebase', [first, second]);

    const [refused] = named(h.log, 'swarm.merge_refused');
    expect(refused?.fields).toMatchObject({
      preset: 'test', policy: 'sequential-rebase', node: 'n2',
      cause: 'verdict-stale', reason: 'unavailable',
    });
  });

  test('the settle event counts a skipped refusal without naming a stop', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    await h.run('sequential-rebase', [first, second]);

    const [settled] = named(h.log, 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({
      policy: 'sequential-rebase', members: 2, applied: 1, refused: 1, stopped_at: '',
    });
  });
});

// A skipped member joins neither `applied` nor the rebase frontier, so later members' gates
// still see any dependence on it.
describe('a refused member is skipped, not stopped at', () => {
  test('a clean member lands behind a refused one', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const dirty = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const clean = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    const report = await h.run('sequential-rebase', [{
      ...dirty, verdict: { ...present(dirty.verdict, "dirty's verdict"), clean: false },
    }, clean]);

    expect(report.outcomes.map((o) => o.kind)).toEqual(['refused', 'applied']);
    expect(h.origin.at.get('b.ts')).toBe('B1\n');
    expect(h.origin.at.get('a.ts')).toBe('A0\n');
    expect(report.stoppedAt).toBeNull();
  });

  test("a skipped member's refusal is still reported, never absorbed", async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const dirty = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const clean = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    const report = await h.run('sequential-rebase', [{
      ...dirty, verdict: { ...present(dirty.verdict, "dirty's verdict"), clean: false },
    }, clean]);

    const [first] = report.outcomes;

    if (first?.kind !== 'refused') throw new Error('expected a refusal');
    expect(first.refusal.cause).toBe('verdict-unclean');
    expect(named(h.log, 'swarm.merge_refused')).toHaveLength(1);
    expect(named(h.log, 'swarm.merge_refused')[0]?.fields).toMatchObject({
      preset: 'test', policy: 'sequential-rebase', node: 'n1', cause: 'verdict-unclean',
    });
  });

  test('a member whose base assumed the skipped one is refused as drift', async () => {
    const h = harness({ 'a.ts': 'A0\n' });
    const skipped = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const onTop = await memberOf(h.origin, 'n2', [{ path: 'a.ts', base: 'A1\n', after: 'A2\n' }]);

    const report = await h.run('sequential-rebase', [{
      ...skipped, verdict: { ...present(skipped.verdict, "skipped's verdict"), clean: false },
    }, onTop]);

    // n1 never joined the rebase frontier, so n2's divergence at `a.ts` is foreign drift.
    expect(report.outcomes.map((o) => o.kind)).toEqual(['refused', 'refused']);
    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('base-drift');
    expect(outcome.refusal.error).toContain('a.ts');
    expect(h.origin.at.get('a.ts')).toBe('A0\n');
  });

  test('a member that declares the skipped one is refused by rule 1', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const skipped = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);

    const dependent = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }], {
      deps: ['n1'],
    });

    const report = await h.run('sequential-rebase', [{
      ...skipped, verdict: { ...present(skipped.verdict, "skipped's verdict"), clean: false },
    }, dependent]);

    expect(report.order).toEqual(['n1', 'n2']);
    expect(report.outcomes.map((o) => o.kind)).toEqual(['refused', 'refused']);
    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-unsettled');
    expect(outcome.refusal.error).toContain('n1');
    expect(h.origin.at.get('b.ts')).toBe('B0\n');
  });
});

// The dependent is offered first, so a wrong order shows as a rule 1 refusal.
describe('the members are applied in the dependency order they declare', () => {
  test('a dependent offered first is applied last, and rule 1 never fires', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n', 'c.ts': 'C0\n' });
    const a = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const b = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    const c = await memberOf(h.origin, 'n3', [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], {
      deps: ['n1', 'n2'],
    });

    const report = await h.run('sequential-rebase', [c, a, b]);

    expect(report.order).toEqual(['n1', 'n2', 'n3']);
    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied', 'applied']);
    expect(report.stoppedAt).toBeNull();
    const [settled] = named(h.log, 'swarm.merge_settled');
    expect(settled?.fields.order).toBe('n1,n2,n3');
  });

  test('a set with no edges keeps the order it was offered in', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const a = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const b = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    // Stable: the one-member policies apply the incumbent a scored settle offers first.
    expect((await h.run('sequential-rebase', [b, a])).order).toEqual(['n2', 'n1']);
  });

  test('a dependency this run already landed is settled, and its dependent applies', async () => {
    const h = harness({ 'c.ts': 'C0\n' });

    const c = await memberOf(h.origin, 'n3', [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], {
      deps: ['n1'],
    });

    // `n1` landed in an earlier barrier of the same run.
    const report = await h.run('sequential-rebase', [c], { settled: ['n1'] });

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied']);
    expect(h.origin.at.get('c.ts')).toBe('C1\n');
  });

  test('the same dependent refuses by name when nothing says the dependency landed', async () => {
    const h = harness({ 'c.ts': 'C0\n' });

    const c = await memberOf(h.origin, 'n3', [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], {
      deps: ['n1'],
    });

    const report = await h.run('sequential-rebase', [c]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-unsettled');
    expect(outcome.refusal.error).toContain('n1');
    expect(outcome.refusal.error).toContain('Order the members');
    expect(h.origin.at.get('c.ts')).toBe('C0\n');
  });

  test('a cycle is refused by name, naming the cycle, and nothing is applied', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });

    const a = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }], {
      deps: ['n2'],
    });

    const b = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }], {
      deps: ['n1'],
    });

    const report = await h.run('sequential-rebase', [a, b]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-cycle');
    expect(outcome.refusal.reason).toBe('bad_input');
    expect(outcome.refusal.error).toContain('n1 -> n2 -> n1');
    expect(report.stoppedAt).toBe('n1');
    expect(report.order).toEqual([]);
    expect(h.origin.transactions).toHaveLength(0);
    expect(h.origin.at.get('a.ts')).toBe('A0\n');
    expect(named(h.log, 'swarm.merge_settled')).toHaveLength(1);
    expect(named(h.log, 'swarm.merge_refused')[0]?.fields).toMatchObject({
      node: 'n1', cause: 'dependency-cycle',
    });
  });

  test('a cycle is refused whatever order it is offered in', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n', 'c.ts': 'C0\n' });
    const a = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);

    const b = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }], {
      deps: ['n3'],
    });

    const c = await memberOf(h.origin, 'n3', [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], {
      deps: ['n2'],
    });

    // Order is a property of the set: applying the orderable prefix would publish half a merge.
    const report = await h.run('sequential-rebase', [a, b, c]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-cycle');
    expect(outcome.refusal.error).toContain('n2 -> n3 -> n2');
    expect(h.origin.at.get('a.ts')).toBe('A0\n');
  });

  test('only sequential-rebase orders — apply-winner applies the member it was handed', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'c.ts': 'C0\n' });
    const a = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);

    const c = await memberOf(h.origin, 'n3', [{ path: 'c.ts', base: 'C0\n', after: 'C1\n' }], {
      deps: ['n1'],
    });

    // The same set refuses under `apply-winner`, which does not reorder.
    const winner = await h.run('apply-winner', [c, a]);
    const [outcome] = winner.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-unsettled');
    expect(winner.order).toEqual(['n3', 'n1']);
  });
});

describe('the verdict binds a pair, and the base is the half that moves', () => {
  test('the member digest does not move when the origin does', async () => {
    const origin = fakeOrigin({ 'a.ts': 'A0\n' });
    const diff = diffOf('n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const before = memberDigestOf(diff);

    origin.at.set('a.ts', 'someone-else\n');

    expect(memberDigestOf(diff)).toBe(before);
  });

  test('the base digest moves when the origin does', async () => {
    const origin = fakeOrigin({ 'a.ts': 'A0\n' });
    const diff = diffOf('n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const before = await baseDigestOf(diff, origin.readOrigin);

    origin.at.set('a.ts', 'someone-else\n');

    expect(await baseDigestOf(diff, origin.readOrigin)).not.toBe(before);
  });

  test('the base digest covers only the paths the member touches', async () => {
    const origin = fakeOrigin({ 'a.ts': 'A0\n', 'elsewhere.ts': 'E0\n' });
    const diff = diffOf('n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const before = await baseDigestOf(diff, origin.readOrigin);

    origin.at.set('elsewhere.ts', 'changed\n');

    expect(await baseDigestOf(diff, origin.readOrigin)).toBe(before);
  });

  test('an absent path digests differently from an empty one', async () => {
    const origin = fakeOrigin({});
    const diff = diffOf('n1', [{ path: 'a.ts', base: null, after: 'A1\n' }]);
    const absent = await baseDigestOf(diff, origin.readOrigin);

    origin.at.set('a.ts', '');

    expect(await baseDigestOf(diff, origin.readOrigin)).not.toBe(absent);
  });
});

describe('conflict-spawns-a-merge-node', () => {
  test('two members that changed a path differently produce a merge node', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'MINE\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'THEIRS\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      spawnMergeNode: async () => 'merge-node-1',
    });

    const [, outcome] = report.outcomes;
    expect(outcome?.kind).toBe('merge-node');

    if (outcome?.kind !== 'merge-node') throw new Error('expected a merge node');
    expect(outcome.request.parents).toEqual(['n1', 'n2']);
    expect(outcome.request.paths).toEqual(['shared.ts']);
    expect(outcome.spawned).toBe('merge-node-1');
  });

  test('a conflict is not a refusal', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'MINE\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'THEIRS\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      spawnMergeNode: async () => 'merge-node-1',
    });

    expect(report.outcomes.filter((o) => o.kind === 'refused')).toHaveLength(0);
  });

  // No model resolves a conflict in place.
  test('nothing is merged in place — the origin is untouched by the conflicting member', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'MINE\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'THEIRS\n' }]);

    await h.run('sequential-rebase', [first, second], { spawnMergeNode: async () => 'm1' });

    expect(h.origin.at.get('shared.ts')).toBe('MINE\n');
    expect(h.origin.transactions).toHaveLength(1);
  });

  test('the merge node is given a task that names both parents and the paths', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'MINE\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'THEIRS\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      spawnMergeNode: async () => 'm1',
    });

    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'merge-node') throw new Error('expected a merge node');
    expect(outcome.request.task).toContain('n1');
    expect(outcome.request.task).toContain('n2');
    expect(outcome.request.task).toContain('shared.ts');
    expect(outcome.request.task).toContain('graded like any other candidate');
  });

  test('two members that wrote identical content do not spawn a merge node', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'SAME\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'SAME\n' }]);

    let spawns = 0;
    await h.run('sequential-rebase', [first, second], {
      spawnMergeNode: async () => {
        spawns += 1;

        return 'm1';
      },
      reverify: async ({ member, baseDigest }) => ({
        memberDigest: memberDigestOf(member.diff), baseDigest, clean: true,
      }),
    });

    expect(spawns).toBe(0);
  });

  test('an unwired spawner still detects and names the conflict', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'MINE\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'THEIRS\n' }]);

    const report = await h.run('sequential-rebase', [first, second]);

    const [, outcome] = report.outcomes;

    if (outcome?.kind !== 'merge-node') throw new Error('expected a merge node');
    // Null: the conflict was named but nothing graded it.
    expect(outcome.spawned).toBeNull();
  });

  test('the spawn emits swarm.merge_node_spawned with fields', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'MINE\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'THEIRS\n' }]);

    await h.run('sequential-rebase', [first, second], { spawnMergeNode: async () => 'm1' });

    const [spawned] = named(h.log, 'swarm.merge_node_spawned');
    expect(spawned?.fields).toMatchObject({
      preset: 'test', policy: 'conflict-spawns-a-merge-node',
      derived_from: 'sequential-rebase', node: 'n2', conflicts_with: 'n1',
      paths: 1, spawned: 'm1',
    });
  });

  test('a deletion against an edit is a conflict', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'EDITED\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: null }]);

    const report = await h.run('sequential-rebase', [first, second], {
      spawnMergeNode: async () => 'm1',
    });

    expect(report.outcomes[1]?.kind).toBe('merge-node');
    expect(h.origin.at.get('shared.ts')).toBe('EDITED\n');
  });
});

describe('synthesis', () => {
  test('nothing is applied, because N reports combined is the answer', async () => {
    const h = harness({ 'a.ts': 'A0\n' });
    const one = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const two = await memberOf(h.origin, 'n2', [{ path: 'a.ts', base: 'A0\n', after: 'A2\n' }]);

    const report = await h.run('synthesis', [one, two]);

    expect(report.outcomes).toEqual([]);
    expect(report.stoppedAt).toBeNull();
    expect(h.origin.transactions).toHaveLength(0);
    expect(h.origin.at.get('a.ts')).toBe('A0\n');
  });

  test('members that would conflict are not ranked and do not spawn a merge node', async () => {
    const h = harness({ 'a.ts': 'A0\n' });
    const one = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const two = await memberOf(h.origin, 'n2', [{ path: 'a.ts', base: 'A0\n', after: 'A2\n' }]);

    let spawns = 0;

    const report = await h.run('synthesis', [one, two], {
      spawnMergeNode: async () => {
        spawns += 1;

        return 'm1';
      },
    });

    expect(spawns).toBe(0);
    expect(report.outcomes).toEqual([]);
  });

  test('an unscored, unverified member is not refused', async () => {
    const h = harness({});

    const unjudged = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }], {
      verdict: null, score: null,
    });

    const report = await h.run('synthesis', [unjudged]);

    expect(report.outcomes).toEqual([]);
  });

  test('the settle event records a synthesis that applied nothing', async () => {
    const h = harness({});
    const one = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }]);

    await h.run('synthesis', [one]);

    const [settled] = named(h.log, 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({
      preset: 'test', policy: 'synthesis', members: 1,
      applied: 0, refused: 0, merge_nodes: 0, stopped_at: '',
    });
  });
});

describe('the size refusal', () => {
  test('the ceilings come from the substrate rather than a second copy', () => {
    expect(TRANSACTION_BOUNDS.blobBytes).toBe(MAX_TX_BLOB_BYTES);
    expect(TRANSACTION_BOUNDS.logicalRows).toBe(MAX_TX_LOGICAL_ROWS);
  });

  test('a member within the bound plans as fitting', () => {
    const plan = planMemberApply(diffOf('n1', [{ path: 'a.ts', base: null, after: 'small\n' }]));
    expect(memberApplyBound(plan)).toBeNull();
  });

  test('a member over the byte ceiling is refused, and the bound is named', async () => {
    const h = harness({});

    const huge = await memberOf(h.origin, 'n1', [
      { path: 'huge.bin', base: null, after: 'x'.repeat(MAX_TX_BLOB_BYTES + 1) },
    ]);

    const report = await h.run('apply-winner', [huge]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('oversized');
    // Many tiny files and one huge file have opposite fixes.
    expect(outcome.refusal.error).toContain('blobBytes');
    expect(outcome.refusal.error).toContain(String(MAX_TX_BLOB_BYTES));
  });

  test('the check happens before the apply, so nothing is written', async () => {
    const h = harness({ 'keep.ts': 'untouched\n' });

    const huge = await memberOf(h.origin, 'n1', [
      { path: 'keep.ts', base: 'untouched\n', after: 'x'.repeat(MAX_TX_BLOB_BYTES + 1) },
    ]);

    await h.run('apply-winner', [huge]);

    expect(h.origin.transactions).toHaveLength(0);
    expect(h.origin.at.get('keep.ts')).toBe('untouched\n');
  });

  test('a member over the row ceiling is refused, naming that bound instead', async () => {
    const h = harness({});

    const many = await memberOf(h.origin, 'n1', Array.from(
      { length: MAX_TX_LOGICAL_ROWS + 1 },
      (_unused, index) => ({ path: `f${String(index)}.ts`, base: null, after: 'x\n' }),
    ));

    const report = await h.run('apply-winner', [many]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('oversized');
    expect(outcome.refusal.error).toContain('logicalRows');
    expect(h.origin.transactions).toHaveLength(0);
  });

  test('the refusal emits swarm.merge_oversized with the bound as fields', async () => {
    const h = harness({});

    const huge = await memberOf(h.origin, 'n1', [
      { path: 'huge.bin', base: null, after: 'x'.repeat(MAX_TX_BLOB_BYTES + 1) },
    ]);

    await h.run('apply-winner', [huge]);

    const [oversized] = named(h.log, 'swarm.merge_oversized');
    expect(oversized?.fields).toMatchObject({
      preset: 'test', policy: 'apply-winner', node: 'n1', cause: 'oversized',
      bound: 'blobBytes', actual: MAX_TX_BLOB_BYTES + 1, maximum: MAX_TX_BLOB_BYTES,
    });
    expect(named(h.log, 'swarm.merge_refused')).toHaveLength(0);
  });

  test('a member at exactly the ceiling is not refused', async () => {
    const h = harness({});

    const exact = await memberOf(h.origin, 'n1', [
      { path: 'big.bin', base: null, after: 'x'.repeat(MAX_TX_BLOB_BYTES) },
    ]);

    const report = await h.run('apply-winner', [exact]);

    expect(report.outcomes[0]?.kind).toBe('applied');
  });

  // The bound is bytes, not characters.
  test('the plan counts bytes and not characters', () => {
    const plan = planMemberApply(diffOf('n1', [{ path: 'a.ts', base: null, after: '€' }]));
    expect(plan.blobBytes).toBe(3);
  });

  test('a deletion costs no bytes but still costs a row', () => {
    const plan = planMemberApply(diffOf('n1', [{ path: 'a.ts', base: 'gone\n', after: null }]));
    expect(plan.blobBytes).toBe(0);
    expect(plan.logicalRows).toBe(1);
  });
});

describe('an absent atomic write refuses rather than tearing', () => {
  test('no MemberApply is a named refusal, not a per-file loop', async () => {
    const h = harness({});
    const member = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }]);

    const report = await h.run('apply-winner', [member], { applyMember: undefined });

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('apply-unwired');
    expect(outcome.refusal.reason).toBe('unavailable');
    expect(h.origin.at.has('a.ts')).toBe(false);
  });

  test('the unwired refusal has its own event name', async () => {
    const h = harness({});
    const member = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }]);

    await h.run('apply-winner', [member], { applyMember: undefined });

    expect(named(h.log, 'swarm.merge_unwired')).toHaveLength(1);
  });

  test('a substrate failure is reported as its own cause and failure event', async () => {
    const h = harness({});
    const member = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }]);

    const report = await h.run('apply-winner', [member], {
      applyMember: async () => { throw new Error('E2BIG'); },
    });

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('apply-failed');
    const [failed] = named(h.log, 'swarm.merge_apply_failed');
    expect(failed?.code).toBe('io');
    expect(failed?.cause).toContain('E2BIG');
  });
});

describe('the settle gate', () => {
  // A shared-plane diff is unattributable and already landed in the origin.
  test('a diff observed on the shared plane has nothing attributable to merge', async () => {
    const h = harness({});

    const member = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }], {
      provenance: 'shared-plane',
    });

    const report = await h.run('apply-winner', [member]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('no-boundary');
    expect(outcome.refusal.error).toContain('already in the origin');
    expect(h.origin.at.has('a.ts')).toBe(false);
  });

  // Gate on the diff's provenance, not the node's storage.
  test('a reported diff merges even though the node had no private home', async () => {
    const h = harness({ 'candidate/answer.js': 'old\n' });

    const member = await memberOf(h.origin, 'n1', [
      { path: 'candidate/answer.js', base: 'old\n', after: 'reported\n' },
    ], { provenance: 'reported' });

    const report = await h.run('apply-winner', [member]);

    expect(report.outcomes[0]?.kind).toBe('applied');
    expect(h.origin.at.get('candidate/answer.js')).toBe('reported\n');
  });

  test('a member whose dependency has not merged is refused', async () => {
    const h = harness({});

    const dependent = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: null, after: 'B\n' }], {
      deps: ['n1'],
    });

    const report = await h.run('sequential-rebase', [dependent]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('dependency-unsettled');
    expect(outcome.refusal.error).toContain('n1');
  });

  test('a dependency that merged first satisfies the edge', async () => {
    const h = harness({});
    const first = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }]);

    const second = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: null, after: 'B\n' }], {
      deps: ['n1'],
    });

    const report = await h.run('sequential-rebase', [first, second]);

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
  });

  test('no verdict and an unclean verdict are different refusals', async () => {
    const h = harness({});

    const unchecked = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }], {
      verdict: null,
    });

    const failed = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: null, after: 'B\n' }]);

    const first = await h.run('apply-winner', [unchecked]);

    const second = await h.run('apply-winner', [{
      ...failed, verdict: { ...present(failed.verdict, "failed's verdict"), clean: false },
    }]);

    const one = first.outcomes[0];
    const two = second.outcomes[0];

    if (one?.kind !== 'refused' || two?.kind !== 'refused') throw new Error('expected refusals');
    expect(one.refusal.cause).toBe('no-verdict');
    expect(two.refusal.cause).toBe('verdict-unclean');
  });

  test('a member that wrote outside its declared scope is refused', async () => {
    const h = harness({});

    const member = await memberOf(h.origin, 'n1', [
      { path: 'src/a.ts', base: null, after: 'A\n' },
      { path: 'secrets/key', base: null, after: 'leaked\n' },
    ], { scope: ['src'] });

    const report = await h.run('apply-winner', [member]);

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('scope-escape');
    expect(outcome.refusal.error).toContain('secrets/key');
    expect(h.origin.at.has('src/a.ts')).toBe(false);
  });

  test('a declared scope admits the paths inside it', async () => {
    const h = harness({});

    const member = await memberOf(h.origin, 'n1', [
      { path: 'src/a.ts', base: null, after: 'A\n' },
    ], { scope: ['src'] });

    const report = await h.run('apply-winner', [member]);

    expect(report.outcomes[0]?.kind).toBe('applied');
  });

  // An undeclared scope means nobody said, not an empty allow-list.
  test('an undeclared scope cannot be escaped', async () => {
    const h = harness({});

    const member = await memberOf(h.origin, 'n1', [
      { path: 'anywhere.ts', base: null, after: 'A\n' },
    ], { scope: null });

    const report = await h.run('apply-winner', [member]);

    expect(report.outcomes[0]?.kind).toBe('applied');
  });

  // Applying over a foreign writer would discard its change.
  test('drift from outside the settle refuses', async () => {
    const h = harness({ 'a.ts': 'A0\n' });
    const member = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);

    h.origin.at.set('a.ts', 'someone-else\n');

    const report = await h.run('apply-winner', [member], {
      reverify: async ({ member: m, baseDigest }) => ({
        memberDigest: memberDigestOf(m.diff), baseDigest, clean: true,
      }),
    });

    const [outcome] = report.outcomes;

    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('base-drift');
    expect(outcome.refusal.error).toContain('a.ts');
    expect(h.origin.at.get('a.ts')).toBe('someone-else\n');
  });

  test('drift at a path this settle rebased is not reported as foreign drift', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      reverify: async ({ member, baseDigest }) => ({
        memberDigest: memberDigestOf(member.diff), baseDigest, clean: true,
      }),
    });

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
  });
});

const OPEN: PublicationState = { kind: 'open' };

describe('carry admission', () => {
  test('artifacts below the threshold are not carried', () => {
    const carry: SwarmCarrySetting = { kind: 'artifacts', threshold: 0.8 };
    expect(admitCarry({ carry, score: 0.5, publication: OPEN })).toEqual({
      kind: 'refused', cause: 'below-threshold',
    });
    expect(admitCarry({ carry, score: 0.9, publication: OPEN })).toEqual({ kind: 'admitted' });
  });

  test('a score exactly at the threshold is admitted', () => {
    const carry: SwarmCarrySetting = { kind: 'artifacts', threshold: 0.8 };
    expect(admitCarry({ carry, score: 0.8, publication: OPEN })).toEqual({ kind: 'admitted' });
  });

  // `elites` needs a measurement: unmeasured is not a zero-scoring elite.
  test('an unmeasurable candidate is not carried', () => {
    expect(admitCarry({ carry: { kind: 'elites' }, score: null, publication: OPEN })).toEqual({
      kind: 'refused', cause: 'unmeasurable',
    });
    expect(admitCarry({ carry: { kind: 'elites' }, score: 0, publication: OPEN })).toEqual({
      kind: 'admitted',
    });
  });

  test('carries that write nothing a later run reads are not this gate\'s business', () => {
    expect(admitCarry({ carry: { kind: 'none' }, score: null, publication: OPEN })).toEqual({
      kind: 'admitted',
    });
    expect(admitCarry({
      carry: { kind: 'reflections', threshold: 0.9 }, score: null, publication: OPEN,
    })).toEqual({ kind: 'admitted' });
  });

  // *The publication seal* is checked before the threshold (see `admitCarry`).
  test('a sealed store refuses the carry before the threshold is even consulted', () => {
    const sealed: PublicationState = {
      kind: 'sealed',
      breach: {
        floor: {
          value: 100, kind: 'certificate', bestKnownHonest: 120,
          proof: 'every correct answer must compare each pair at least once on this instance',
        },
        measured: { kind: 'measured', value: 40, detail: 'comparisons counted by the meter' },
        margin: 0.2,
        hypotheses: ['floor_wrong', 'verifier_gameable'],
      },
      clearedBy: null,
    };

    expect(admitCarry({
      carry: { kind: 'artifacts', threshold: 0.1 }, score: 1, publication: sealed,
    })).toEqual({ kind: 'refused', cause: 'sealed' });
    expect(admitCarry({
      carry: { kind: 'elites' }, score: 1, publication: sealed,
    })).toEqual({ kind: 'refused', cause: 'sealed' });
  });

  test('a recorded re-derivation reopens publication for the carry', () => {
    const cleared: PublicationState = {
      kind: 'sealed',
      breach: {
        floor: {
          value: 100, kind: 'certificate', bestKnownHonest: 120,
          proof: 'every correct answer must compare each pair at least once on this instance',
        },
        measured: { kind: 'measured', value: 40, detail: 'comparisons counted by the meter' },
        margin: 0.2,
        hypotheses: ['floor_wrong', 'verifier_gameable'],
      },
      clearedBy: {
        floor: {
          value: 40, kind: 'adversary', bestKnownHonest: 41,
          proof: 'an adversary holding one duplicate halves every comparison bound',
        },
        adjudication: 'floor_wrong — the original proof ignored duplicated keys',
        at: Date.now(),
      },
    };

    expect(admitCarry({
      carry: { kind: 'artifacts', threshold: 0.5 }, score: 0.9, publication: cleared,
    })).toEqual({ kind: 'admitted' });
  });

  test('settleCarry emits one named event per member with its score and threshold', () => {
    const log = createRecordingLogger();

    const verdicts = settleCarry({
      carry: { kind: 'artifacts', threshold: 0.8 },
      publication: OPEN,
      members: [
        { nodeId: 'n1', score: 0.9 },
        { nodeId: 'n2', score: 0.2 },
      ],
    }, { log, preset: 'test' });

    expect(verdicts.map((v) => v.verdict.kind)).toEqual(['admitted', 'refused']);

    const [admitted] = named(log, 'swarm.carry_admitted');
    expect(admitted?.fields).toMatchObject({
      preset: 'test', carry: 'artifacts', node: 'n1', score: 0.9, threshold: 0.8, cause: '',
    });
    const [refused] = named(log, 'swarm.carry_refused');
    expect(refused?.fields).toMatchObject({
      carry: 'artifacts', node: 'n2', score: 0.2, threshold: 0.8, cause: 'below-threshold',
    });
  });

  test('every member gets its own decision event', () => {
    const log = createRecordingLogger();

    settleCarry({
      carry: { kind: 'elites' },
      publication: OPEN,
      members: [
        { nodeId: 'n1', score: 1 },
        { nodeId: 'n2', score: null },
        { nodeId: 'n3', score: 2 },
      ],
    }, { log, preset: 'test' });

    expect(log.emitted).toHaveLength(3);
    expect(named(log, 'swarm.carry_refused').map((l) => l.fields.node)).toEqual(['n2']);
  });
});
