/**
 * Merge-back — how a settled swarm's work reaches the origin (EXPLORATION-SPEC §8.5).
 *
 * WITHOUT THIS, ISOLATION STRANDS RESULTS RATHER THAN PROTECTING THEM. §8.6 gives a
 * node its own home so it can be graded on what it changed; a node that is graded and
 * wins and whose work then sits in a home nobody reads again has been confined, not
 * used. §8.5 is specified BEFORE the substrate for exactly that reason: *"a boundary
 * you cannot cross is not a boundary, it is a leak of work."*
 *
 * THE POLICY IS DERIVED FROM `settle`, NEVER CHOSEN — the same move, for the same
 * reason, as {@link settleOf} deriving `settle` from the axes. §8.5's table already
 * maps each policy onto a `settleOf` value, so a caller who could name the policy
 * independently could ask for one settled winner out of a run that ranks nothing.
 * {@link mergePolicyOf} is that table, written as a total function so a new
 * {@link SwarmSettle} value cannot silently fall through to `apply-winner`.
 *
 * THE FOURTH POLICY IS NOT SETTLE-DERIVED, AND THAT ASYMMETRY IS THE SOURCE'S. §8.5
 * gives three rows a `settleOf` mapping and gives `conflict-spawns-a-merge-node` a
 * situational condition instead — *"where both parents earned their keep and neither
 * can be dropped"*. A conflict is a run-time fact about two diffs, not an axis, so it
 * is reached through {@link MergeOutcome} rather than through the derivation. It is
 * still a named policy and not an error path: §8.5 calls it *"the one that matters"*,
 * because a merge node is how a model is used on a conflict WITHOUT violating §9.3's
 * finding — the model does not edit in place and get trusted, it produces a candidate
 * that is graded like every other candidate.
 *
 * WHAT MAKES ALL-OR-NOTHING PER MEMBER AVAILABLE, AND WHY ITS ABSENCE REFUSES.
 * Applying a member is a copy out of its home inside ONE filesystem, so a member's
 * file set can ride one host transaction — Nimbus's `writeBatch`, which is exactly one
 * `transactionSync` and which REFUSES rather than splitting: *"Splitting a strict
 * batch would publish a prefix if a later half failed"*
 * (`@nimbus-sh/core/src/vfs/sqlite-vfs.ts:4030-4032`). That refusal is the property
 * this module is built on, and it is bounded — see {@link memberApplyBound}. A
 * per-file loop over `vfs.writeFile` would tear a large member into a committed
 * prefix, which is the failure the bound exists to prevent, so {@link MemberApply}
 * being absent REFUSES instead of falling back to one. Absent is reported, never
 * assumed, exactly as `nodeWorkspace`'s provisioner is.
 *
 * WHAT THIS DOES NOT DECIDE, because §8.5 does not. *"Across members — whether a
 * sequential rebase that fails at member three leaves members one and two applied —
 * remains a policy this document does not set."* The transaction shape §8.5 DID
 * specify answers it mechanically: atomicity is per member by construction, so there
 * is no cross-member transaction to roll back into and members already applied stay
 * applied. This module therefore stops at the first refusal and reports the boundary
 * as DATA ({@link MergeBackReport.stoppedAt}, `swarm.merge_settled`) rather than
 * choosing silently. The unspecified half is the ORDERING GUARANTEE, not the
 * mechanism, and a reader of the report can see exactly where it stopped.
 */

import {
  BATCH_SIZE, CHUNK_SIZE, MAX_TX_BLOB_BYTES, MAX_TX_LOGICAL_ROWS, MAX_TX_SQL_EXECS,
} from '@nimbus-sh/core/constants.js';
import { argumentDigest } from '../safety/argument-digest';
import { ProteusError, refusalOf, type Refusal } from '../obs/error';
import type { Logger } from '../obs/log';
import type { SwarmCarrySetting, SwarmSettle } from './swarm';
import { admitsPublication, type PublicationState } from './objective';
import type { NodeIsolation } from './node-workspace';
import { textPayload, type WriteEvent, type WriteObserver } from '../vfs/observe';
import type { VFS } from '../types/primitives';
import { isVfsError } from '../vfs/errno';

/* ── The policies (§8.5's table) ──────────────────────────────────────────── */

/**
 * §8.5's four named merge policies.
 *
 * Named so a caller reads which one ran rather than discovering which one was
 * implemented — the same reason the axes are named.
 */
export const MERGE_POLICIES = [
  'apply-winner', 'sequential-rebase', 'conflict-spawns-a-merge-node', 'synthesis',
] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

/**
 * §8.5's table, as a total function over {@link SwarmSettle}.
 *
 * Total by construction so exhaustiveness is a compile-time fact: a fifth `settle`
 * value cannot fall through to `apply-winner`, which would silently apply one
 * member of a run that wanted all of them.
 *
 * `conflict-spawns-a-merge-node` is deliberately unreachable from here — a conflict
 * is a fact about two diffs discovered during the apply, not a property of the axes.
 * See the module header.
 */
export function mergePolicyOf(settle: SwarmSettle): MergePolicy {
  switch (settle) {
    // A scalar objective with one incumbent (§6.2).
    case 'best': return 'apply-winner';
    // Several members are wanted and the tree order is a dependency order (§9.1).
    case 'archive': case 'front': return 'sequential-rebase';
    // N reports combined, nothing ranked. The shape that had to survive `fork`'s
    // removal (§0.1) — which is why it is asserted to exist rather than assumed.
    case 'merge': return 'synthesis';
  }
}

/** Whether a policy applies MORE than one member, and therefore rebases: the base
 *  changes for every diff after the first, which is what makes §9.3 rule 4 the whole
 *  of this policy's correctness rather than a nicety. */
export function rebases(policy: MergePolicy): boolean {
  return policy === 'sequential-rebase';
}

/* ── §8.5's diff artifact ─────────────────────────────────────────────────── */

/**
 * One path's NET change, with content.
 *
 * Content and not a line diff, because this shape is applied and not displayed:
 * `vfs/diff.ts`'s {@link FileDiff} bounds its body at `MAX_LINES_PER_FILE` so a
 * review surface cannot be made to render a megabyte, and applying a bounded body
 * would drop the tail of every large file silently. The review shape is derived FROM
 * this one where a reader needs it; the reverse is not recoverable.
 *
 * Net rather than per-write, for the reason `HeadFileChanges` is: a node that wrote a
 * file five times contributes the one change a reviewer would see, and a node that
 * wrote a file back to its original contents contributes nothing for it.
 */
export interface MemberFileChange {
  readonly path: string;
  /** Content when this member FIRST touched the path; null when it did not exist.
   *  The base half of *"a patch against the base state it started from"*. */
  readonly base: string | null;
  /** Content now; null when the member deleted the path. */
  readonly after: string | null;
}

/** §8.5's diff artifact: what one node changed, against the base it started from.
 *  Self-contained, which is the property that makes it portable where a candidate
 *  reference into a home released at settle is not (§8.6 obligation 6). */
export interface MemberDiff {
  readonly nodeId: string;
  /** Sorted by path, so the digest over a diff is stable across capture order. */
  readonly files: readonly MemberFileChange[];
}

/**
 * A node's diff, accumulated where its writes land.
 *
 * Wraps the node's own file view through `observeWrites`, which is the diff-capture
 * seam this repository already has — attribution has to happen AT the write because
 * siblings run concurrently over one plane and an end-of-run diff smears every node's
 * work into one pile. This retains CONTENT where `HeadFileChanges` retains counts,
 * because a merge-back applies its result and a head report renders its result.
 */
export class NodeDiffCapture implements WriteObserver {
  private readonly touched = new Map<string, { base: string | null; after: string | null }>();

  constructor(private readonly nodeId: string) {}

  needsBaseline(path: string): boolean {
    return !this.touched.has(path);
  }

  record(event: WriteEvent): void {
    // A non-text payload is never decoded into a patch side: applying a lossy decode of
    // an image would corrupt it, so it enters as null and the member is refused for
    // drift rather than written as a guess.
    const written = textPayload(event.after);
    const after = written.kind === 'text' ? written.text : null;
    const existing = this.touched.get(event.path);
    if (existing) {
      existing.after = after;
      return;
    }
    const baseline = textPayload(event.before);
    this.touched.set(event.path, {
      base: baseline.kind === 'text' ? baseline.text : null,
      after,
    });
  }

  /** The diff, sorted by path. A path whose content came back to where it started is
   *  omitted: nothing changed there, and carrying it would make two runs that did
   *  the same work produce different digests. */
  diff(): MemberDiff {
    const files: MemberFileChange[] = [];
    for (const [path, t] of this.touched) {
      if (t.base === t.after) continue;
      files.push({ path, base: t.base, after: t.after });
    }
    return {
      nodeId: this.nodeId,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
}

/* ── The (memberDigest, baseDigest) binding (§9.3 rule 4) ──────────────────── */

/**
 * A verdict, bound to the PAIR it was issued over.
 *
 * The member digest alone is near-vacuous: a diff is immutable, so its digest never
 * changes and a check against it can never fail. What moves is the BASE — §8.5: *"a
 * diff is bound to the base it was taken against, and a sequential rebase changes
 * that base for every diff after the first."* So the binding is the pair, and rule 4
 * compares the half that can actually differ.
 */
export interface MemberVerdict {
  /** Digest of the member's own diff — WHAT was checked. */
  readonly memberDigest: string;
  /** Digest of the origin state it was checked AGAINST — the half that moves. */
  readonly baseDigest: string;
  /** §9.3 rule 3. False is a verdict, not a missing one: a member checked and found
   *  wanting is a different fact from a member nobody checked. */
  readonly clean: boolean;
}

/** SHA-256 over a member's diff through the repo's one hashing utility. Reused
 *  rather than re-derived: a second digest helper is a second thing to keep
 *  collision-resistant. */
export function memberDigestOf(diff: MemberDiff): string {
  return argumentDigest({
    nodeId: diff.nodeId,
    files: diff.files.map((f) => ({ path: f.path, base: f.base, after: f.after })),
  });
}

/**
 * SHA-256 over the ORIGIN's content at the paths a member touches.
 *
 * Over the member's OWN paths and not the whole workspace, which is what keeps rule 4
 * from firing on every unrelated write: a sibling member that touched no path this
 * member touches does not invalidate this member's verdict, and a rule that said
 * otherwise would refuse every multi-member settle for no correctness gain.
 */
export async function baseDigestOf(
  diff: MemberDiff, readOrigin: (path: string) => Promise<string | null>,
): Promise<string> {
  const at: { path: string; content: string | null }[] = [];
  for (const file of diff.files) at.push({ path: file.path, content: await readOrigin(file.path) });
  return argumentDigest(at);
}

/** Re-verification through the verifier registry, for a member whose base moved.
 *  §8.5: *"a base change forces re-verification before apply; a stale verdict NEVER
 *  applies."* ABSENT means a stale verdict can only refuse, which is the fail-closed
 *  direction and the one this module takes by default. */
export type Reverifier = (input: {
  readonly member: MergeMember;
  /** The base the member would now be applied onto, already recomputed. */
  readonly baseDigest: string;
}) => Promise<MemberVerdict | Refusal>;

/* ── The bound, and why it is three numbers ───────────────────────────────── */

/** Which of Nimbus's three transaction bounds a member's apply would exceed. The
 *  substrate checks them in this order (`exceededTransactionLimit`,
 *  `sqlite-vfs.ts:562-567`) and so does this pre-flight, so the bound this module
 *  names is the bound the substrate would have named. */
export type TransactionBound = 'blobBytes' | 'logicalRows' | 'sqlExecs';

/** What one member's apply would cost the transaction it must ride inside. */
export interface MemberApplyPlan {
  readonly blobBytes: number;
  readonly logicalRows: number;
  readonly sqlExecs: number;
}

/** The three ceilings, from the substrate's own constants rather than a second copy.
 *  A literal here would be a number that drifts the first time Nimbus retunes its
 *  transaction envelope, and the whole point of a pre-flight check is that it agrees
 *  with the thing it is protecting. */
export const TRANSACTION_BOUNDS = {
  blobBytes: MAX_TX_BLOB_BYTES,
  logicalRows: MAX_TX_LOGICAL_ROWS,
  sqlExecs: MAX_TX_SQL_EXECS,
} satisfies Record<TransactionBound, number>;

/**
 * What a member's apply would cost, computed the way the substrate accounts for it:
 * one inode row per path, one chunk row per {@link CHUNK_SIZE} of content, and grouped
 * inserts of {@link BATCH_SIZE} rows per statement.
 *
 * A PRE-FLIGHT ESTIMATE, and deliberately conservative: its only job is to refuse
 * before `writeBatch` throws `E2BIG` mid-settle, and Nimbus's own
 * `assertTransactionFits` remains the authority. Erring large is the safe direction —
 * refusing a member that would have fitted costs one named refusal, while admitting
 * one that does not fit costs the tear.
 */
export function planMemberApply(diff: MemberDiff): MemberApplyPlan {
  const encoder = new TextEncoder();
  let blobBytes = 0;
  let chunks = 0;
  for (const file of diff.files) {
    if (file.after === null) continue;
    const bytes = encoder.encode(file.after).length;
    blobBytes += bytes;
    chunks += Math.ceil(bytes / CHUNK_SIZE);
  }
  const inodes = diff.files.length;
  // Rows reach the transaction as grouped inserts of BATCH_SIZE, so the statement
  // count is per group and not per row — the difference between fitting and not.
  return {
    blobBytes,
    logicalRows: inodes + chunks,
    sqlExecs: Math.ceil(inodes / BATCH_SIZE) + Math.ceil(chunks / BATCH_SIZE),
  };
}

/**
 * The bound a member would exceed, or null when it fits one transaction.
 *
 * CHECKED BEFORE APPLY, which is the whole of its value: a member checked after the
 * first write has already torn. Returns WHICH bound and by how much, because a
 * refusal that says only "too large" leaves a caller unable to tell a
 * thousand-tiny-files member from a one-huge-file member, and the two have opposite
 * fixes.
 */
export function memberApplyBound(
  plan: MemberApplyPlan,
): { readonly bound: TransactionBound; readonly actual: number; readonly maximum: number } | null {
  for (const bound of ['blobBytes', 'logicalRows', 'sqlExecs'] as const) {
    const maximum = TRANSACTION_BOUNDS[bound];
    if (plan[bound] > maximum) return { bound, actual: plan[bound], maximum };
  }
  return null;
}

/* ── What a merge refuses on ──────────────────────────────────────────────── */

/**
 * §9.3's six ordered settle refusals, as reason codes.
 *
 * The spec's list, in the spec's order, and no more: this array is §9.3 and nothing
 * else, so a reader comparing the two is comparing two things that are meant to be
 * equal. The substrate's own preconditions live in {@link APPLY_PRECONDITIONS}
 * precisely so they cannot be mistaken for members of this one.
 */
export const SETTLE_RULES = [
  'dependency-unsettled', 'no-verdict', 'verdict-unclean',
  'verdict-stale', 'scope-escape', 'base-drift',
] as const;
export type SettleRule = (typeof SETTLE_RULES)[number];

/**
 * The mechanical preconditions of an APPLY, and the substrate's own failure, as
 * distinct from §9.3's gate.
 *
 * Separate because §9.3's list is the specification's and this one is the substrate's.
 * Folding a missing atomic primitive into the spec's six would misrepresent the spec
 * as having asked for it.
 */
export const APPLY_PRECONDITIONS = [
  'no-boundary', 'oversized', 'apply-unwired', 'apply-failed',
] as const;
export type ApplyPrecondition = (typeof APPLY_PRECONDITIONS)[number];

export type MergeRefusalCause = SettleRule | ApplyPrecondition;

/* ── A member, and what becomes of it ─────────────────────────────────────── */

/** One node's work, offered to merge-back. */
export interface MergeMember {
  readonly nodeId: string;
  readonly diff: MemberDiff;
  /** §9.3 rule 2 — null is "nobody checked this", which refuses. */
  readonly verdict: MemberVerdict | null;
  /** Whether this node actually had a boundary. `shared-origin-plane` has no home to
   *  copy out of and its writes are unattributed, so there is nothing to merge that
   *  could be said to be THIS node's. */
  readonly isolation: NodeIsolation;
  /** §9.3 rule 5: the paths this member declared it would touch, checked against
   *  what it ACTUALLY wrote. Null is an undeclared scope, which cannot escape one. */
  readonly scope: readonly string[] | null;
  /** §9.3 rule 1: node ids whose merges must land before this one's (§9.1 orders
   *  SETTLE). Empty is the ordinary case and is not the same as unordered. */
  readonly deps: readonly string[];
  /** What the search measured, for {@link admitCarry}. Null when unmeasurable. */
  readonly score: number | null;
}

/** A refusal, with the rule that produced it. `{reason, error}` reason-first through
 *  `refusalOf`, so the classification travels as the field the read models already
 *  read rather than as prose. */
export interface MergeRefusal extends Refusal {
  readonly cause: MergeRefusalCause;
}

/** §8.5's conflict policy: what a conflict BECOMES. Not resolved in place by a model
 *  — §9.3 is explicit that the evidence is one-sided — but handed back as a node
 *  whose task is the merge, graded like any other. */
export interface MergeNodeRequest {
  /** The two members whose diffs disagree, in apply order. */
  readonly parents: readonly [string, string];
  /** The paths they disagree about. */
  readonly paths: readonly string[];
  /** The merge node's task, written to be the next instruction. */
  readonly task: string;
}

/** What became of one member. */
export type MergeOutcome =
  | {
      readonly kind: 'applied';
      readonly nodeId: string;
      readonly files: number;
      readonly bytes: number;
    }
  | { readonly kind: 'refused'; readonly nodeId: string; readonly refusal: MergeRefusal }
  | {
      readonly kind: 'merge-node';
      readonly nodeId: string;
      readonly request: MergeNodeRequest;
      /** The spawned node's id, when a spawner was wired. Null records that the
       *  conflict was detected and named but nothing was there to grade it. */
      readonly spawned: string | null;
    };

/** What a whole merge-back did. */
export interface MergeBackReport {
  readonly policy: MergePolicy;
  readonly outcomes: readonly MergeOutcome[];
  /** The node id merge-back stopped at, or null when every member was reached. The
   *  cross-member ordering guarantee §8.5 leaves open, stated as data: members
   *  before this one are applied and stay applied, because atomicity is per member
   *  and there is no cross-member transaction to roll back into. */
  readonly stoppedAt: string | null;
}

/* ── The engine ───────────────────────────────────────────────────────────── */

/** The one-transaction multi-file write a member's apply rides.
 *
 *  ABSENT REFUSES. A per-file loop over `vfs.writeFile` is not a degraded version of
 *  this — it is the torn apply the bound exists to prevent, and taking it silently
 *  would make the size check theatre. `apply-unwired` says so with a reason. */
export type MemberApply = (files: readonly MemberFileChange[]) => Promise<void>;

export interface MergeBackDeps {
  readonly log: Logger;
  /** For event parity with the rest of the run's `swarm.*` names. */
  readonly preset: string;
  /** The origin's content at a path, or null when absent. Reads only: merge-back
   *  never mutates through this, so a drift check cannot itself cause drift. */
  readonly readOrigin: (path: string) => Promise<string | null>;
  readonly applyMember?: MemberApply;
  readonly reverify?: Reverifier;
  readonly spawnMergeNode?: (request: MergeNodeRequest) => Promise<string>;
}

export interface MergeBackInput {
  readonly policy: MergePolicy;
  /** In apply order. For `sequential-rebase` that is §9.1's settle order; for
   *  `apply-winner` it is the one winner. */
  readonly members: readonly MergeMember[];
}

/**
 * Apply a settled swarm's work to the origin under `policy`.
 *
 * Stops at the first refusal and says where (see {@link MergeBackReport.stoppedAt}).
 * Never throws: a merge that could not proceed is a reported refusal, because the
 * caller's next move is to disclose it and a thrown gate is indistinguishable from a
 * filesystem that broke.
 */
export async function mergeBack(
  input: MergeBackInput, deps: MergeBackDeps,
): Promise<MergeBackReport> {
  const { policy, members } = input;
  const outcomes: MergeOutcome[] = [];
  const applied = new Set<string>();
  /** What an earlier member in THIS settle left at a path, and which member left it —
   *  the conflict detector's whole state. The content is held because a conflict is a
   *  DISAGREEMENT and not an overlap; see {@link conflictWith}. */
  const writtenBy = new Map<string, { nodeId: string; after: string | null }>();
  let stoppedAt: string | null = null;

  // `synthesis` ranks nothing and applies nothing: §8.5's row is *"N reports are
  // combined and the combination is kept"*. The combination is the settle report the
  // caller already receives, so there is no diff to land and no winner to pick — and
  // saying that with a named policy is what keeps the list complete rather than
  // quietly covering only the judged settlement.
  if (policy === 'synthesis') {
    deps.log.event('swarm.merge_settled', {
      preset: deps.preset, policy, members: members.length,
      applied: 0, refused: 0, merge_nodes: 0, stopped_at: '',
    });
    return { policy, outcomes, stoppedAt: null };
  }

  for (const member of members) {
    // CONFLICT IS CHECKED BEFORE THE GATE, and the order is load-bearing. Two members
    // that changed the same path DISAGREE, and §8.5 is explicit that a conflict *"does
    // not fail"*. Gating first would report the disagreement as a stale verdict and the
    // merge-node policy would be unreachable.
    const conflict = conflictWith(member, writtenBy);
    if (conflict) {
      const outcome = await spawnMerge(member, conflict, deps, policy);
      outcomes.push(outcome);
      stoppedAt = member.nodeId;
      break;
    }

    const refusal = await gate(member, { applied, rebasedAt: writtenBy, deps });
    if (refusal) {
      outcomes.push({ kind: 'refused', nodeId: member.nodeId, refusal });
      deps.log.event('swarm.merge_refused', {
        preset: deps.preset, policy, node: member.nodeId,
        cause: refusal.cause, reason: refusal.reason, error: refusal.error,
      });
      stoppedAt = member.nodeId;
      break;
    }

    const outcome = await applyOne(member, deps, policy);
    outcomes.push(outcome);
    if (outcome.kind !== 'applied') {
      stoppedAt = member.nodeId;
      break;
    }
    applied.add(member.nodeId);
    for (const file of member.diff.files) {
      writtenBy.set(file.path, { nodeId: member.nodeId, after: file.after });
    }

    // `apply-winner` applies ONE member and discards every other node's diff (§8.5).
    // Enforced here rather than trusted to the caller's array: a policy that silently
    // applied a second member would be `sequential-rebase` under another name.
    if (policy === 'apply-winner') break;
  }

  deps.log.event('swarm.merge_settled', {
    preset: deps.preset, policy, members: members.length,
    applied: outcomes.filter((o) => o.kind === 'applied').length,
    refused: outcomes.filter((o) => o.kind === 'refused').length,
    merge_nodes: outcomes.filter((o) => o.kind === 'merge-node').length,
    stopped_at: stoppedAt ?? '',
  });
  return { policy, outcomes, stoppedAt };
}

/**
 * §9.3's gate, in §9.3's order, plus the substrate's own preconditions.
 *
 * Ordered because the order is the specification's and because an earlier rule
 * produces the more actionable message: a member with no verdict should be told that,
 * not told its base drifted.
 */
async function gate(
  member: MergeMember,
  ctx: {
    applied: ReadonlySet<string>;
    /** THE REBASE FRONTIER: what an earlier member of this settle already landed, by
     *  path. Rule 6 reads it to tell a rebase apart from a foreign writer. */
    rebasedAt: ReadonlyMap<string, { nodeId: string; after: string | null }>;
    deps: MergeBackDeps;
  },
): Promise<MergeRefusal | null> {
  // A precondition of the mechanism, checked before the spec's gate: §8.5 applies a
  // member by copying out of its HOME, and a node that never had one wrote straight
  // into the origin where a sibling may have overwritten it. Merging that would
  // attribute a sibling's bytes to this node.
  if (member.isolation === 'shared-origin-plane') {
    return refuse('no-boundary', 'unsupported',
      `node ${member.nodeId} ran on the shared origin plane, so it has no home to copy out of and `
      + 'its writes are not attributable to it. Merge-back needs the §8.6 substrate: wire a '
      + 'NodeWorkspaceProvisioner so the node gets a private home, and its diff becomes its own.');
  }

  // Rule 1 — a dependency has not settled yet. §9.1 orders SETTLE, so this is the
  // only place a dependency edge is enforced, and a dropped edge refuses rather than
  // degrading toward runnable (§9.2).
  const waiting = member.deps.filter((dep) => !ctx.applied.has(dep));
  if (waiting.length > 0) {
    return refuse('dependency-unsettled', 'bad_input',
      `node ${member.nodeId} merges after ${waiting.join(', ')}, and ${
        waiting.length === 1 ? 'that member has' : 'those members have'
      } not merged. Order the members so a dependency precedes what depends on it.`);
  }

  // Rule 2 — the candidate has no verdict.
  if (member.verdict === null) {
    return refuse('no-verdict', 'missing',
      `node ${member.nodeId} has no verdict, so nothing has checked what it produced. A member `
      + 'is graded before it is applied — call the report tool\'s verifier on it first.');
  }

  // Rule 3 — the verdict is not clean.
  if (!member.verdict.clean) {
    return refuse('verdict-unclean', 'denied',
      `node ${member.nodeId} was checked and did not pass, so its work is a graded failure rather `
      + 'than a candidate to land. An accepted-with-failure report is a legitimate worst-direction '
      + 'score (§8.7) and is not a merge.');
  }

  // Rule 5 before rule 4, and NOT because §9.3 orders it that way — it does not. A
  // scope escape is a property of the diff alone and cannot be cured by
  // re-verification, so checking it first spends no model call to learn something
  // already knowable. Rule 4 is the expensive one.
  const escaped = scopeEscapes(member);
  if (escaped.length > 0) {
    return refuse('scope-escape', 'denied',
      `node ${member.nodeId} wrote ${escaped.join(', ')}, outside the scope it declared (${
        (member.scope ?? []).join(', ')
      }). §9.3 rule 5 reads what was ACTUALLY written, so widen the declared scope or keep the `
      + 'writes inside it.');
  }

  // Rule 4 — THE VERDICT IS STALE, and it is checked BEFORE rule 6 because §9.3 orders
  // it that way and because the alternative makes it dead code. A rebased member's
  // origin no longer holds the base its diff recorded, so rule 6 fires at exactly the
  // paths a rebase moved; checking rule 6 first would refuse every rebased member as
  // drift and this comparison — the whole of `sequential-rebase`'s correctness — would
  // never run.
  //
  // The pair is the binding: the member digest never changes for an immutable diff, so
  // the base digest is the half that can differ, and under a rebase it differs for
  // every member after the first. A difference forces re-verification through the
  // registry, and a stale verdict never applies.
  const baseDigest = await baseDigestOf(member.diff, ctx.deps.readOrigin);
  if (member.verdict.baseDigest !== baseDigest) {
    const fresh = await reverified(member, baseDigest, ctx.deps);
    if ('reason' in fresh) {
      return { ...fresh, cause: 'verdict-stale' };
    }
    if (!fresh.clean) {
      return refuse('verdict-stale', 'denied',
        `node ${member.nodeId}'s verdict was re-checked against the base it would now be applied `
        + 'onto and did not pass. The earlier verdict described a base that no longer holds.');
    }
  }

  // Rule 6 — the environment is not in the recorded base state, at a path THIS settle
  // did not itself move. Drift at a path an earlier member landed is the rebase, not a
  // foreign write, and rule 4 above has already forced it through re-verification;
  // refusing it here as well would mean `sequential-rebase` could never apply a second
  // member. Drift anywhere else is a writer outside this settle, and applying over it
  // would silently discard whatever it did.
  const drifted = await baseDrift(member, ctx.deps.readOrigin, ctx.rebasedAt);
  if (drifted.length > 0) {
    return refuse('base-drift', 'denied',
      `node ${member.nodeId}'s diff was taken against different content than the origin now holds `
      + `at ${drifted.join(', ')}, and no member of this settle wrote ${
        drifted.length === 1 ? 'that path' : 'those paths'
      }. Re-take the diff against the current state; applying this one would overwrite whatever `
      + 'changed outside this run.');
  }

  return null;
}

/** Re-verification, or the fail-closed refusal when none is wired. */
async function reverified(
  member: MergeMember, baseDigest: string, deps: MergeBackDeps,
): Promise<MemberVerdict | Refusal> {
  if (!deps.reverify) {
    return refusalOf(new ProteusError('unavailable',
      `node ${member.nodeId}'s verdict was issued against a base this settle has since changed, and `
      + 'no re-verification is wired, so the verdict cannot be revalidated. A stale verdict never '
      + 'applies: wire a Reverifier over the verifier registry, or merge this member first so its '
      + 'base is the one it was checked against.'));
  }
  const fresh = await deps.reverify({ member, baseDigest });
  if ('reason' in fresh) return fresh;
  // A re-verification that came back bound to a DIFFERENT base has not answered the
  // question that was asked. Accepting it would reintroduce the staleness the
  // re-check exists to remove, one level down.
  if (fresh.baseDigest !== baseDigest) {
    return refusalOf(new ProteusError('unavailable',
      `node ${member.nodeId}'s re-verification returned a verdict bound to a different base than `
      + 'the one it was asked about, so it does not revalidate this apply.'));
  }
  return fresh;
}

/** The paths a member wrote outside its declared scope. An undeclared scope cannot
 *  escape one — absent is not an empty allow-list. */
function scopeEscapes(member: MergeMember): string[] {
  const scope = member.scope;
  if (scope === null) return [];
  return member.diff.files
    .map((f) => f.path)
    .filter((path) => !scope.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)));
}

/** The paths where the origin no longer holds what the member recorded as its base,
 *  EXCLUDING the paths this settle itself rebased. A path an earlier member landed is
 *  expected to differ — that difference is the rebase, and rule 4 governs it. */
async function baseDrift(
  member: MergeMember,
  readOrigin: (path: string) => Promise<string | null>,
  rebasedAt: ReadonlyMap<string, { nodeId: string; after: string | null }>,
): Promise<string[]> {
  const drifted: string[] = [];
  for (const file of member.diff.files) {
    if (rebasedAt.has(file.path)) continue;
    if ((await readOrigin(file.path)) !== file.base) drifted.push(file.path);
  }
  return drifted;
}

/**
 * Apply one member, all-or-nothing, after checking the bound.
 *
 * The order is the point: the bound is checked BEFORE the first write, so an oversized
 * member is refused whole rather than committed as a prefix.
 */
async function applyOne(
  member: MergeMember, deps: MergeBackDeps, policy: MergePolicy,
): Promise<MergeOutcome> {
  const plan = planMemberApply(member.diff);
  const exceeded = memberApplyBound(plan);
  if (exceeded) {
    const refusal = refuse('oversized', 'unsupported',
      `node ${member.nodeId}'s apply needs ${exceeded.actual} ${exceeded.bound} and one host `
      + `transaction holds ${exceeded.maximum}. A member rides ONE transaction so it is `
      + 'all-or-nothing; splitting it would publish a committed prefix if a later part failed, '
      + 'which is a torn workspace rather than a failed merge. Reduce what this node changes, or '
      + 'split the work across nodes so each member fits.');
    // ITS OWN EVENT NAME, and the bound is a FIELD. A name shared with the other
    // refusals could not answer "did anything tear, or nearly?" — which is the one
    // question this refusal exists to make answerable.
    deps.log.event('swarm.merge_oversized', {
      preset: deps.preset, policy, node: member.nodeId, cause: refusal.cause,
      reason: refusal.reason, error: refusal.error,
      bound: exceeded.bound, actual: exceeded.actual, maximum: exceeded.maximum,
    });
    return { kind: 'refused', nodeId: member.nodeId, refusal };
  }

  if (!deps.applyMember) {
    const refusal = refuse('apply-unwired', 'unavailable',
      `node ${member.nodeId} fits one transaction but no atomic multi-file write is wired, and a `
      + 'per-file loop would tear this member into a committed prefix. Wire MemberApply to the '
      + "substrate's one-transaction batch write.");
    deps.log.event('swarm.merge_unwired', {
      preset: deps.preset, policy, node: member.nodeId,
      cause: refusal.cause, reason: refusal.reason, error: refusal.error,
    });
    return { kind: 'refused', nodeId: member.nodeId, refusal };
  }

  try {
    await deps.applyMember(member.diff.files);
  } catch (err) {
    const refusal = refuse('apply-failed', 'io',
      `node ${member.nodeId}'s apply failed at the substrate: ${
        err instanceof Error ? err.message : String(err)
      }. The transaction is all-or-nothing, so nothing of this member landed.`);
    deps.log.failure('swarm.merge_apply_failed',
      new ProteusError('io', refusal.error, { cause: err instanceof Error ? err : undefined }),
      { preset: deps.preset, policy, node: member.nodeId, cause: refusal.cause });
    return { kind: 'refused', nodeId: member.nodeId, refusal };
  }

  deps.log.event('swarm.merge_applied', {
    preset: deps.preset, policy, node: member.nodeId,
    files: member.diff.files.length, bytes: plan.blobBytes,
  });
  return {
    kind: 'applied', nodeId: member.nodeId,
    files: member.diff.files.length, bytes: plan.blobBytes,
  };
}

/**
 * The earlier member this one DISAGREES with, and where — or null when its paths are
 * free or it agrees.
 *
 * Disagreement and not mere overlap. Two members that wrote the SAME bytes to a path
 * have not conflicted: the origin already holds what this member would write, so
 * spawning a merge node would burn a graded node to decide nothing. Compared against
 * the earlier member's `after` rather than by re-reading the origin, because that
 * value is what the origin holds by construction and a read could not tell a
 * sibling's write apart from it.
 */
function conflictWith(
  member: MergeMember, writtenBy: ReadonlyMap<string, { nodeId: string; after: string | null }>,
): { readonly with: string; readonly paths: readonly string[] } | null {
  const paths: string[] = [];
  let other: string | null = null;
  for (const file of member.diff.files) {
    const earlier = writtenBy.get(file.path);
    if (earlier === undefined || earlier.after === file.after) continue;
    paths.push(file.path);
    other ??= earlier.nodeId;
  }
  return other === null ? null : { with: other, paths };
}

/** §8.5's conflict policy. The model is never put next to the conflict: this produces
 *  a NODE whose task is the merge, and that node is graded like any other. */
async function spawnMerge(
  member: MergeMember,
  conflict: { readonly with: string; readonly paths: readonly string[] },
  deps: MergeBackDeps,
  policy: MergePolicy,
): Promise<MergeOutcome> {
  const request: MergeNodeRequest = {
    parents: [conflict.with, member.nodeId],
    paths: conflict.paths,
    task:
      `Merge two settled members that both changed ${conflict.paths.join(', ')}. Member ${
        conflict.with
      } is already applied and is what the workspace now holds; member ${member.nodeId} changed `
      + 'the same paths from the same base. Produce one version that keeps what each member '
      + 'earned, then report it. Your result is graded like any other candidate — it is not '
      + 'trusted because it resolved a conflict.',
  };
  const spawned = deps.spawnMergeNode ? await deps.spawnMergeNode(request) : null;
  deps.log.event('swarm.merge_node_spawned', {
    preset: deps.preset, policy: 'conflict-spawns-a-merge-node',
    derived_from: policy, node: member.nodeId, conflicts_with: conflict.with,
    paths: conflict.paths.length, spawned: spawned ?? '',
  });
  return { kind: 'merge-node', nodeId: member.nodeId, request, spawned };
}

function refuse(
  cause: MergeRefusalCause,
  reason: 'bad_input' | 'denied' | 'unsupported' | 'unavailable' | 'missing' | 'io',
  message: string,
): MergeRefusal {
  return { ...refusalOf(new ProteusError(reason, message)), cause };
}

/* ── `carry` admission at settle (§4.4, §5.3) ─────────────────────────────── */

/** Whether a member's result is carried out of this run, and why not when it is not. */
export type CarryVerdict =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'refused'; readonly cause: 'below-threshold' | 'unmeasurable' | 'sealed' };

/**
 * The admission `carry` performs at settle.
 *
 * TWO GATES, and both are load-bearing. The THRESHOLD is the axis's own — tagged onto
 * `artifacts` because that value carries one and `elites` does not, which is not an
 * omission: an archive's CELL is an elite's admission (`advance:'archive'` bins by a
 * descriptor and keeps the best per cell), so the quantity `elites` would threshold is
 * one the archive already decided. What it still requires is a MEASUREMENT — an
 * unmeasurable candidate is not a zero-scoring elite, and carrying one would seed the
 * next run from a candidate nobody scored.
 *
 * The SEAL is §4.4's, through `admitsPublication` over the one enumerated surface each
 * carry writes. Checked here rather than trusted to the writer, because §4.4's hole
 * was exactly a publication path that called itself separate and unchanged.
 */
export function admitCarry(input: {
  readonly carry: SwarmCarrySetting;
  readonly score: number | null;
  readonly publication: PublicationState;
}): CarryVerdict {
  const { carry, score, publication } = input;
  // `none` and `reflections` write nothing a later run reads, so neither reaches a
  // publication surface and neither is this function's business.
  if (carry.kind !== 'elites' && carry.kind !== 'artifacts') return { kind: 'admitted' };

  const surface = carry.kind === 'artifacts' ? 'experience_library' : 'records';
  if (admitsPublication(publication, surface).kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }
  if (score === null) return { kind: 'refused', cause: 'unmeasurable' };
  if (carry.kind === 'artifacts' && score < carry.threshold) {
    return { kind: 'refused', cause: 'below-threshold' };
  }
  return { kind: 'admitted' };
}

/**
 * Admit every member's carry and say what happened to each, with an event per
 * decision.
 *
 * One event per member and not one per run: the question a reader has is *"why is
 * yesterday's elite not in the archive"*, and a per-run count cannot answer it.
 */
export function settleCarry(
  input: {
    readonly carry: SwarmCarrySetting;
    readonly publication: PublicationState;
    readonly members: readonly { readonly nodeId: string; readonly score: number | null }[];
  },
  deps: { readonly log: Logger; readonly preset: string },
): readonly { readonly nodeId: string; readonly verdict: CarryVerdict }[] {
  return input.members.map((member) => {
    const verdict = admitCarry({
      carry: input.carry, score: member.score, publication: input.publication,
    });
    // Two constant names rather than one chosen name. An event name assembled at the
    // call site produces one name per branch and none a query can be written against,
    // so the branch lives here and each outcome keeps a greppable name.
    const fields = {
      preset: deps.preset, carry: input.carry.kind, node: member.nodeId,
      score: member.score ?? -1,
      threshold: input.carry.kind === 'artifacts' ? input.carry.threshold : -1,
    };
    if (verdict.kind === 'admitted') {
      deps.log.event('swarm.carry_admitted', { ...fields, cause: '' });
    } else {
      deps.log.event('swarm.carry_refused', { ...fields, cause: verdict.cause });
    }
    return { nodeId: member.nodeId, verdict };
  });
}

/* ── Wiring helpers ───────────────────────────────────────────────────────── */

/** A {@link MergeBackDeps.readOrigin} over a VFS. Missing is null and every other
 *  read failure propagates: an unreadable path is not an absent one, and treating it
 *  as absent would report drift as a clean base. */
export function originReader(vfs: VFS): (path: string) => Promise<string | null> {
  return async (path) => {
    try {
      const payload = textPayload(await vfs.readFile(path, { encoding: 'utf8' }));
      // A binary path reads as absent, so the member's recorded base cannot match it and
      // rule 6 refuses. Decoding it would invent a base that was never there.
      return payload.kind === 'text' ? payload.text : null;
    } catch (err) {
      if (isVfsError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  };
}
