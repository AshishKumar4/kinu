// Merge-back — the four policies by which a settled swarm's work reaches the origin
// (EXPLORATION-SPEC §8.5), and the two refusals that carry the correctness.
//
// EACH POLICY IS ASSERTED WHERE IT CAN ACTUALLY FAIL, not at the derivation. Proving
// `mergePolicyOf('best') === 'apply-winner'` proves a lookup table; what matters is
// that `apply-winner` applies ONE member and leaves the other diffs on the floor, that
// `sequential-rebase` re-verifies a member whose base moved, that a conflict BECOMES a
// node instead of failing, and that `synthesis` lands nothing. So the derivation gets
// one small suite and the behaviour gets the rest.
//
// TWO TESTS ARE PROVEN THE HARD WAY, because both guard a silent failure rather than a
// loud one, and a test that would pass with the check deleted is not guarding anything:
//
//   1. THE SIZE REFUSAL. A member rides one host transaction; over the bound the
//      substrate would split it and publish a committed prefix — a torn workspace, not
//      a failed merge. The refusal is red-proven in `mutation-merge-back.test.ts`:
//      deleting the pre-flight lets the apply be attempted.
//   2. THE STALE-VERDICT REFUSAL. A verdict binds the PAIR `(memberDigest,
//      baseDigest)`. The member digest is near-vacuous — a diff is immutable, so its
//      digest never moves and a check against it can never fail. The base is the half
//      that moves, and a rebase moves it for every member after the first. That one
//      comparison IS `sequential-rebase`'s correctness, so deleting it must turn a test
//      red, and that is asserted rather than believed.
//
// THE FAKE ORIGIN IS ALL-OR-NOTHING ON PURPOSE. `applyMember` stages into a copy and
// commits, and it RECORDS ONE ENTRY PER CALL. "One host transaction per member" is then
// a counted assertion — a per-file loop would show up as N transactions — instead of a
// property the suite takes on trust.
import { describe, test, expect } from 'bun:test';
import { MAX_TX_BLOB_BYTES, MAX_TX_LOGICAL_ROWS } from '@nimbus-sh/core/constants.js';
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

/* ── The fake origin: one transaction per call, and it counts them ─────────── */

interface FakeOrigin {
  readonly at: Map<string, string>;
  readonly readOrigin: (path: string) => Promise<string | null>;
  readonly applyMember: MemberApply;
  /** One entry per `applyMember` CALL. The length is the transaction count. */
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
      // Staged then committed, so a throw mid-way leaves nothing behind — the
      // property `writeBatch` has and a per-file loop does not.
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

/** A member whose verdict is bound to the origin AS IT STANDS NOW — the honest case.
 *  Staleness is then produced by moving the origin, which is what a rebase does, and
 *  never by hand-writing a wrong digest. */
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
    },
  ) => Promise<MergeBackReport>;
}

function harness(initial: Record<string, string> = {}): Harness {
  const origin = fakeOrigin(initial);
  const log = createRecordingLogger();
  return {
    origin,
    log,
    run: (policy, members, over = {}) => mergeBack({ policy, members }, {
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

/* ── The derivation (§8.5's table) ────────────────────────────────────────── */

describe('the policy is derived from settle, never chosen', () => {
  test('each settle shape maps to its §8.5 policy', () => {
    expect(mergePolicyOf('best')).toBe('apply-winner');
    expect(mergePolicyOf('archive')).toBe('sequential-rebase');
    expect(mergePolicyOf('front')).toBe('sequential-rebase');
    expect(mergePolicyOf('merge')).toBe('synthesis');
  });

  // `synthesis` is the shape that had to survive `fork`'s removal, so its existence is
  // ASSERTED. A policy list covering the judged settlement and not this one would be an
  // incomplete list that still typechecked.
  test('synthesis is a named policy and not an unhandled settle', () => {
    expect(MERGE_POLICIES).toContain('synthesis');
    expect(mergePolicyOf('merge')).toBe('synthesis');
  });


  test("§9.3's six rules and the substrate's preconditions stay distinct lists", () => {
    expect(SETTLE_RULES).toHaveLength(6);
    // Widened by assignment rather than asserted: the two arrays have disjoint literal
    // types, so `toContain` would otherwise be comparing types instead of values and
    // could not fail even if a precondition were added to the spec's list.
    const rules: readonly string[] = SETTLE_RULES;
    for (const precondition of APPLY_PRECONDITIONS) {
      expect(rules).not.toContain(precondition);
    }
  });
});

/* ── Policy 1: apply-winner ───────────────────────────────────────────────── */

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

  // ONE HOST TRANSACTION PER MEMBER, counted. A per-file loop would produce two
  // transactions here and would tear on the second, which is the whole reason the
  // size bound exists.
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

  // The discard is the policy, not an accident of the caller's array length. A second
  // member landing here would be `sequential-rebase` under another name.
  test('every other diff is discarded, even when offered', async () => {
    const h = harness({});
    const winner = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'won\n' }]);
    const loser = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: null, after: 'lost\n' }]);

    const report = await h.run('apply-winner', [winner, loser]);

    expect(report.outcomes).toHaveLength(1);
    expect(h.origin.at.has('b.ts')).toBe(false);
    expect(h.origin.transactions).toHaveLength(1);
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

/* ── Policy 2: sequential-rebase ──────────────────────────────────────────── */

describe('sequential-rebase', () => {
  test('diffs land in tree order, each onto the result of the last', async () => {
    const h = harness({ 'a.ts': 'A0\n', 'b.ts': 'B0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: 'B0\n', after: 'B1\n' }]);

    const report = await h.run('sequential-rebase', [first, second]);

    expect(report.outcomes.map((o) => o.kind)).toEqual(['applied', 'applied']);
    expect(h.origin.at.get('a.ts')).toBe('A1\n');
    expect(h.origin.at.get('b.ts')).toBe('B1\n');
    // Still one transaction PER MEMBER — the rebase does not fold two members into one
    // transaction, because then a later failure would roll back an earlier success.
    expect(h.origin.transactions).toHaveLength(2);
  });

  // THE CENTRAL TEST. A rebase moves the base for every member after the first, so
  // member two's verdict describes a base the origin no longer holds. With no
  // re-verification wired, the only fail-closed answer is to refuse.
  test('a member whose base moved is refused when nothing can re-verify it', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    // Same content, so this is NOT a conflict — the two agree. What has changed is the
    // base its verdict was issued against, which is exactly rule 4's subject.
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    const report = await h.run('sequential-rebase', [first, second]);

    expect(report.stoppedAt).toBe('n2');
    const [, outcome] = report.outcomes;
    expect(outcome?.kind).toBe('refused');
    if (outcome?.kind !== 'refused') throw new Error('expected a refusal');
    expect(outcome.refusal.cause).toBe('verdict-stale');
    expect(outcome.refusal.reason).toBe('unavailable');
    expect(outcome.refusal.error).toContain('stale verdict never applies');
    // The first member stays applied: atomicity is per member and there is no
    // cross-member transaction to roll back into.
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
      reverify: async ({ member, baseDigest }) => {
        asked.push(member.nodeId);
        return { memberDigest: memberDigestOf(member.diff), baseDigest, clean: true };
      },
    });

    // Re-verified, and then applied — the rebase is licensed by the re-check, not by
    // ignoring the staleness.
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
      reverify: async ({ member, baseDigest }) => {
        asked.push(member.nodeId);
        return { memberDigest: memberDigestOf(member.diff), baseDigest, clean: true };
      },
    });

    // A sibling that touched no path this member touches does not invalidate its
    // verdict. A rule that said otherwise would refuse every multi-member settle and
    // buy no correctness for it.
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

  // A re-check bound to some OTHER base has not answered the question that was asked.
  // Accepting it would reintroduce the staleness one level down.
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

  test('the settle event reports where merge-back stopped', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'V1\n' }]);

    await h.run('sequential-rebase', [first, second]);

    const [settled] = named(h.log, 'swarm.merge_settled');
    expect(settled?.fields).toMatchObject({
      policy: 'sequential-rebase', members: 2, applied: 1, refused: 1, stopped_at: 'n2',
    });
  });
});

/* ── The (memberDigest, baseDigest) pair ──────────────────────────────────── */

describe('the verdict binds a pair, and the base is the half that moves', () => {
  // The premise of rule 4, stated as a test: the member digest cannot do this job.
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

/* ── Policy 3: a conflict becomes a node ──────────────────────────────────── */

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

  // A conflict DOES NOT FAIL. This is the assertion that separates §8.5's policy from
  // the obvious wrong implementation, where a collision is an error path.
  test('a conflict is not a refusal', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'MINE\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'THEIRS\n' }]);

    const report = await h.run('sequential-rebase', [first, second], {
      spawnMergeNode: async () => 'merge-node-1',
    });

    expect(report.outcomes.filter((o) => o.kind === 'refused')).toHaveLength(0);
  });

  // NO MODEL RESOLVES A CONFLICT IN PLACE. The origin keeps what the first member
  // landed; the second member's bytes do not appear, and nothing has been blended.
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
    // Graded like any other candidate — the merge node gets no trust for having
    // resolved a conflict.
    expect(outcome.request.task).toContain('graded like any other candidate');
  });

  // AGREEMENT IS NOT A CONFLICT. Two members that wrote the same bytes have not
  // disagreed, and spawning a node to decide nothing burns a graded node.
  test('two members that wrote identical content do not spawn a merge node', async () => {
    const h = harness({ 'shared.ts': 'V0\n' });
    const first = await memberOf(h.origin, 'n1', [{ path: 'shared.ts', base: 'V0\n', after: 'SAME\n' }]);
    const second = await memberOf(h.origin, 'n2', [{ path: 'shared.ts', base: 'V0\n', after: 'SAME\n' }]);

    let spawns = 0;
    await h.run('sequential-rebase', [first, second], {
      spawnMergeNode: async () => { spawns += 1; return 'm1'; },
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
    // Null records that the conflict was found and named but nothing was there to
    // grade it — which is a different fact from there being no conflict.
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

/* ── Policy 4: synthesis, judge-free ──────────────────────────────────────── */

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

  // NOTHING IS RANKED. Two members that would conflict under any applying policy do
  // not conflict here, because no one of them is being preferred to the other.
  test('members that would conflict are not ranked and do not spawn a merge node', async () => {
    const h = harness({ 'a.ts': 'A0\n' });
    const one = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: 'A0\n', after: 'A1\n' }]);
    const two = await memberOf(h.origin, 'n2', [{ path: 'a.ts', base: 'A0\n', after: 'A2\n' }]);

    let spawns = 0;
    const report = await h.run('synthesis', [one, two], {
      spawnMergeNode: async () => { spawns += 1; return 'm1'; },
    });

    expect(spawns).toBe(0);
    expect(report.outcomes).toEqual([]);
  });

  // No judge, so no verdict is required and no score is consulted: an unscored,
  // unverified member is still part of the combination.
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

/* ── The size bound: checked BEFORE apply, refused with the bound named ───── */

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
    // THE BOUND IS NAMED, not merely "too large" — a thousand-tiny-files member and a
    // one-huge-file member have opposite fixes.
    expect(outcome.refusal.error).toContain('blobBytes');
    expect(outcome.refusal.error).toContain(String(MAX_TX_BLOB_BYTES));
  });

  // THE ORDER IS THE POINT. A member checked after the first write has already torn,
  // so the assertion is that the substrate was never reached at all.
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
    // Its OWN name. A refusal sharing a name with the others could not answer "did
    // anything nearly tear?", which is the question it exists to make answerable.
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

  // A multi-byte character costs more than one byte, and the bound is bytes. Counting
  // characters would admit a member the substrate then refuses mid-settle.
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

/* ── The fallback is never silent ─────────────────────────────────────────── */

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

/* ── §9.3's gate ──────────────────────────────────────────────────────────── */

describe('the settle gate', () => {
  // Provenance and not the node's storage: a diff OBSERVED on the shared plane is
  // unattributable and its writes already landed in the origin, so there is nothing to
  // merge back.
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

  // THE CASE THAT MAKES MERGE-BACK REACHABLE TODAY. A node with no home of its own can
  // still have produced a perfectly attributable answer, because it REPORTED it — and a
  // report is the node's by construction, whatever plane it ran on. Gating on the node's
  // storage instead of the diff's provenance would refuse this and leave the module with
  // no production caller at all.
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

  // "Nobody checked this" is a different fact from "this was checked and failed", and
  // the two get different causes so a reader can tell them apart.
  test('no verdict and an unclean verdict are different refusals', async () => {
    const h = harness({});
    const unchecked = await memberOf(h.origin, 'n1', [{ path: 'a.ts', base: null, after: 'A\n' }], {
      verdict: null,
    });
    const failed = await memberOf(h.origin, 'n2', [{ path: 'b.ts', base: null, after: 'B\n' }]);

    const first = await h.run('apply-winner', [unchecked]);
    const second = await h.run('apply-winner', [{
      ...failed, verdict: { ...failed.verdict!, clean: false },
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

  // An undeclared scope is not an empty allow-list: absent means nobody said, and
  // treating it as "nothing permitted" would refuse every member that declared none.
  test('an undeclared scope cannot be escaped', async () => {
    const h = harness({});
    const member = await memberOf(h.origin, 'n1', [
      { path: 'anywhere.ts', base: null, after: 'A\n' },
    ], { scope: null });

    const report = await h.run('apply-winner', [member]);

    expect(report.outcomes[0]?.kind).toBe('applied');
  });

  // A writer OUTSIDE this settle moved the path. No member of this run wrote it, so it
  // is not a rebase and applying over it would silently discard whatever changed it.
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

  // The rebase frontier is what tells the two apart: the SAME divergence at a path an
  // earlier member landed is the rebase, and rule 4 governs it.
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

/* ── `carry` admission at settle ──────────────────────────────────────────── */

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

  // `elites` carries no threshold of its own — the archive's CELL is its admission —
  // but it still requires a MEASUREMENT. An unmeasurable candidate is not a
  // zero-scoring elite, and carrying one seeds the next run from a candidate nobody
  // scored.
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

  // §4.4's seal, over the real shape rather than a cast: `carry:'artifacts'` routes
  // through `experience_library`, which is the widest-blast-radius surface in the
  // governed set and exactly the hole §4.4 closed. A sealed run must not publish
  // there however well the candidate scored, so the seal is checked BEFORE the
  // threshold — a high score is not evidence about which hypothesis was true.
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

  // One event per member and not one per run: the question a reader has is "why is
  // yesterday's elite not in the archive", and a per-run count cannot answer it.
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
