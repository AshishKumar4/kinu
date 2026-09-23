/**
 * Merge-back: how a settled swarm's work reaches the origin.
 * Spec: docs/EXPLORATION.md "Merge-back", "Isolation", "Settle is derived", "The publication seal".
 * The policy is derived from `settle`, never chosen; conflicts reach `conflict-spawns-a-merge-node` at run time.
 * Atomicity is per member (one host transaction); a refused member is skipped and earlier members stay applied.
 */

import {
  BATCH_SIZE, CHUNK_SIZE, MAX_TX_BLOB_BYTES, MAX_TX_LOGICAL_ROWS, MAX_TX_SQL_EXECS,
} from '@nimbus-sh/core/constants.js';
import { argumentDigest } from '../safety/argument-digest';
import { KinuError, refusalOf, type Refusal } from '../obs/error';
import type { Logger } from '../obs/log';
import type { SwarmCarrySetting, SwarmSettle } from './swarm';
import { admitsPublication, type PublicationState } from './objective';
import { textPayload } from '../vfs/observe';
import type { VFS } from '../types/primitives';
import { isVfsError } from '../vfs/errno';
import { renderThrownChain } from '../obs/index';

export const MERGE_POLICIES = [
  'apply-winner', 'sequential-rebase', 'conflict-spawns-a-merge-node', 'synthesis',
] as const;

export type MergePolicy = (typeof MERGE_POLICIES)[number];

/** Total over {@link SwarmSettle} so a new value cannot fall through to `apply-winner`. */
export function mergePolicyOf(settle: SwarmSettle): MergePolicy {
  switch (settle) {
    case 'best': return 'apply-winner';
    case 'archive': case 'front': return 'sequential-rebase';
    case 'merge': return 'synthesis';
  }
}

/** One path's net change, with full content: this shape is applied, so a bounded line diff would drop tails. */
export interface MemberFileChange {
  readonly path: string;
  /** Content when this member first touched the path; null when it did not exist. */
  readonly base: string | null;
  readonly after: string | null;
}

/**
 * Where a member's diff came from. `reported` and `private-home` are mergeable;
 * `shared-plane` is refused: siblings share that tree, so the writes are unattributable and already landed.
 */
export type DiffProvenance = 'reported' | 'private-home' | 'shared-plane';

/** What one node changed, against the base it started from. */
export interface MemberDiff {
  readonly nodeId: string;
  /** Sorted by path, so the digest is stable across capture order. */
  readonly files: readonly MemberFileChange[];
  readonly provenance: DiffProvenance;
}

/** A verdict bound to the (memberDigest, baseDigest) pair; the base is the half a rebase moves. */
export interface MemberVerdict {
  readonly memberDigest: string;
  readonly baseDigest: string;
  /** The gate's rule 3. False is a verdict, distinct from a missing one. */
  readonly clean: boolean;
}

export function memberDigestOf(diff: MemberDiff): string {
  return argumentDigest({
    nodeId: diff.nodeId,
    files: diff.files.map((f) => ({ path: f.path, base: f.base, after: f.after })),
  });
}

/** Over the member's own paths only, so unrelated sibling writes do not trip rule 4. */
export async function baseDigestOf(
  diff: MemberDiff, readOrigin: (path: string) => Promise<string | null>,
): Promise<string> {
  const at: { path: string; content: string | null }[] = [];

  for (const file of diff.files) at.push({ path: file.path, content: await readOrigin(file.path) });

  return argumentDigest(at);
}

/** Re-verification for a member whose base moved. Absent means a stale verdict refuses (fail-closed). */
export type Reverifier = (input: {
  readonly member: MergeMember;
  readonly baseDigest: string;
}) => Promise<MemberVerdict | Refusal>;

/** Checked in the substrate's order (`exceededTransactionLimit`, `sqlite-vfs.ts:562-567`). */
export type TransactionBound = 'blobBytes' | 'logicalRows' | 'sqlExecs';

export interface MemberApplyPlan {
  readonly blobBytes: number;
  readonly logicalRows: number;
  readonly sqlExecs: number;
}

/** From the substrate's own constants so the pre-flight agrees with the substrate. */
export const TRANSACTION_BOUNDS = {
  blobBytes: MAX_TX_BLOB_BYTES,
  logicalRows: MAX_TX_LOGICAL_ROWS,
  sqlExecs: MAX_TX_SQL_EXECS,
} satisfies Record<TransactionBound, number>;

/**
 * Conservative pre-flight estimate of the transaction cost; Nimbus's `assertTransactionFits`
 * stays the authority. Erring large is the safe direction.
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

  // Rows are inserted in groups of BATCH_SIZE, so statement count is per group.
  return {
    blobBytes,
    logicalRows: inodes + chunks,
    sqlExecs: Math.ceil(inodes / BATCH_SIZE) + Math.ceil(chunks / BATCH_SIZE),
  };
}

/** Must be checked before the first write; a member checked after it has already torn. */
export function memberApplyBound(
  plan: MemberApplyPlan,
): { readonly bound: TransactionBound; readonly actual: number; readonly maximum: number } | null {
  for (const bound of ['blobBytes', 'logicalRows', 'sqlExecs'] as const) {
    const maximum = TRANSACTION_BOUNDS[bound];

    if (plan[bound] > maximum) return { bound, actual: plan[bound], maximum };
  }

  return null;
}

/** The specification's six ordered settle refusals, and nothing else. */
export const SETTLE_RULES = [
  'dependency-unsettled', 'no-verdict', 'verdict-unclean',
  'verdict-stale', 'scope-escape', 'base-drift',
] as const;

export type SettleRule = (typeof SETTLE_RULES)[number];

/** Substrate preconditions of an apply, kept apart from {@link SETTLE_RULES}. */
export const APPLY_PRECONDITIONS = [
  'no-boundary', 'oversized', 'apply-unwired', 'apply-failed',
] as const;

export type ApplyPrecondition = (typeof APPLY_PRECONDITIONS)[number];

/** A refusal about the member set, not one member; neither in the spec's gate nor the substrate's list. */
const ORDER_RULES = ['dependency-cycle'] as const;

export type OrderRule = (typeof ORDER_RULES)[number];

export type MergeRefusalCause = SettleRule | ApplyPrecondition | OrderRule;

export interface MergeMember {
  readonly nodeId: string;
  readonly diff: MemberDiff;
  /** The gate's rule 2; null refuses. */
  readonly verdict: MemberVerdict | null;
  /** The gate's rule 5, checked against what was actually written. Null is undeclared and cannot escape. */
  readonly scope: readonly string[] | null;
  /** The gate's rule 1: node ids whose merges must land before this one's. */
  readonly deps: readonly string[];
  readonly score: number | null;
}

export interface MergeRefusal extends Refusal {
  readonly cause: MergeRefusalCause;
}

/** A conflict becomes a merge node, graded like any other; never resolved in place by a model. */
export interface MergeNodeRequest {
  readonly parents: readonly [string, string];
  readonly paths: readonly string[];
  readonly task: string;
}

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
      /** Null when no spawner was wired. */
      readonly spawned: string | null;
    };

export interface MergeBackReport {
  readonly policy: MergePolicy;
  readonly outcomes: readonly MergeOutcome[];
  /** Dependency order for `sequential-rebase`, the caller's order otherwise. */
  readonly order: readonly string[];
  /** Node id merge-back stopped at, or null when every member was reached (refused ones skipped). */
  readonly stoppedAt: string | null;
}

/** One-transaction multi-file write. Absent refuses (`apply-unwired`): a per-file loop would tear. */
export type MemberApply = (files: readonly MemberFileChange[]) => Promise<void>;

export interface MergeBackDeps {
  readonly log: Logger;
  readonly preset: string;
  /** Read-only: a drift check must not cause drift. */
  readonly readOrigin: (path: string) => Promise<string | null>;
  readonly applyMember?: MemberApply;
  readonly reverify?: Reverifier;
  readonly spawnMergeNode?: (request: MergeNodeRequest) => Promise<string>;
}

export interface MergeBackInput {
  readonly policy: MergePolicy;
  /** `sequential-rebase` applies in declared dependency order; other policies take the first member. */
  readonly members: readonly MergeMember[];
  /** Node ids already merged at an earlier barrier of this run; rule 1 treats them as settled. */
  readonly settled?: readonly string[];
}

export type MergeOrder =
  | { readonly kind: 'ordered'; readonly members: readonly MergeMember[] }
  | { readonly kind: 'cycle'; readonly nodeId: string; readonly refusal: MergeRefusal };

/**
 * Members ordered after their declared dependencies, derived from edges, never tree position.
 * Stable for an edge-free set; non-member deps are left to rule 1; a cycle refuses the whole set.
 * `FanIn.lean — derived_order_satisfies_rule_one`, `FanIn.lean — every_member_is_ordered`,
 * `FanIn.lean — an_orderable_member_does_not_land_beside_a_cycle`, `FanIn.lean — the_sweep_bound_is_tight`.
 */
function dependencyOrder(
  members: readonly MergeMember[],
  settled: ReadonlySet<string> = new Set(),
): MergeOrder {
  const offered = new Set(members.map((member) => member.nodeId));

  const edges = new Map(members.map((member) => [
    member.nodeId,
    member.deps.filter((dep) => offered.has(dep) && !settled.has(dep)),
  ]));

  const ordered: MergeMember[] = [];
  const placed = new Set<string>();

  // Sweeps in offered order keep the result stable; the member count bounds the sweeps.
  for (let progressed = true; progressed;) {
    progressed = false;

    for (const member of members) {
      if (placed.has(member.nodeId)) continue;

      if ((edges.get(member.nodeId) ?? []).some((dep) => !placed.has(dep))) continue;
      ordered.push(member);
      placed.add(member.nodeId);
      progressed = true;
    }
  }

  // Anything unplaced is on a cycle; name the first in offered order for a deterministic refusal.
  for (const member of members) {
    if (placed.has(member.nodeId)) continue;

    const stuck = new Map(
      [...edges]
        .filter(([nodeId]) => !placed.has(nodeId))
        .map(([nodeId, deps]) => [nodeId, deps.filter((dep) => !placed.has(dep))] as const),
    );

    return {
      kind: 'cycle',
      nodeId: member.nodeId,
      refusal: refuse('dependency-cycle', 'bad_input',
        `node ${member.nodeId} cannot be ordered after the members it depends on: ${
          cycleFrom(member.nodeId, stuck).join(' -> ')
        }. Settle is ordered by dependency and a member that must land after itself has no `
        + "such order. Break the cycle: a fan-in's parents settle before the child that "
        + 'consumes them, so a parent that depends on its own dependent is not a fan-in.'),
    };
  }

  return { kind: 'ordered', members: ordered };
}

/** The cycle from `start`, e.g. `a -> b -> a`. Every stuck node has an unplaced dep, so the walk cannot dead-end. */
function cycleFrom(
  start: string, stuck: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const path: string[] = [];
  let at: string | undefined = start;

  while (at !== undefined && !path.includes(at)) {
    path.push(at);
    at = (stuck.get(at) ?? [])[0];
  }

  return at === undefined ? path : [...path.slice(path.indexOf(at)), at];
}

/** Apply a settled swarm's work under `policy`. Never throws: failures are reported refusals. */
export async function mergeBack(
  input: MergeBackInput, deps: MergeBackDeps,
): Promise<MergeBackReport> {
  const { policy, members } = input;
  const outcomes: MergeOutcome[] = [];
  /** Seeded with dependencies already merged at earlier barriers of this run. */
  const settled = new Set(input.settled ?? []);
  const applied = new Set<string>(settled);
  /** Conflict detector state: which member last wrote a path, and what. */
  const writtenBy = new Map<string, { nodeId: string; after: string | null }>();
  let stoppedAt: string | null = null;

  /** The single emit site for `swarm.merge_settled`. */
  const settle = (stopped: string | null, ordered: readonly string[]): MergeBackReport => {
    deps.log.event('swarm.merge_settled', {
      preset: deps.preset, policy, members: members.length,
      applied: outcomes.filter((outcome) => outcome.kind === 'applied').length,
      refused: outcomes.filter((outcome) => outcome.kind === 'refused').length,
      merge_nodes: outcomes.filter((outcome) => outcome.kind === 'merge-node').length,
      stopped_at: stopped ?? '',
      order: ordered.join(','),
    });

    return { policy, outcomes, stoppedAt: stopped, order: ordered };
  };

  // `synthesis` applies nothing: the combination is the settle report itself.
  if (policy === 'synthesis') return settle(null, []);

  // Only `sequential-rebase` is reordered; the others apply the first member or none.
  const order = policy === 'sequential-rebase'
    ? dependencyOrder(members, settled)
    : ({ kind: 'ordered', members } as const);

  if (order.kind === 'cycle') {
    outcomes.push({ kind: 'refused', nodeId: order.nodeId, refusal: order.refusal });
    deps.log.event('swarm.merge_refused', {
      preset: deps.preset, policy, node: order.nodeId,
      cause: order.refusal.cause, reason: order.refusal.reason, error: order.refusal.error,
    });

    // No order means no apply: a prefix of an unorderable set is half a merge published.
    return settle(order.nodeId, []);
  }

  const ordered = order.members.map((member) => member.nodeId);

  for (const member of order.members) {
    // Conflict must be checked before the gate, or the gate reports it as a stale verdict.
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

      // Under `sequential-rebase` a refusal skips the member; later dependents are caught by their own gate.
      // Single-apply policies stop, or a loser would be applied as winner.
      if (policy === 'sequential-rebase') continue;
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

    // `apply-winner` applies exactly one member.
    if (policy === 'apply-winner') break;
  }

  return settle(stoppedAt, ordered);
}

/** The settle gate in the specification's order, plus the substrate's preconditions. */
async function gate(
  member: MergeMember,
  ctx: {
    applied: ReadonlySet<string>;
    /** Paths an earlier member of this settle landed; rule 6 excludes them as rebase, not drift. */
    rebasedAt: ReadonlyMap<string, { nodeId: string; after: string | null }>;
    deps: MergeBackDeps;
  },
): Promise<MergeRefusal | null> {
  // Shared-plane diffs are unattributable and already landed; a reported answer is fine.
  if (member.diff.provenance === 'shared-plane') {
    return refuse('no-boundary', 'unsupported',
      `node ${member.nodeId}'s diff was observed on the shared origin plane, so it is not `
      + 'attributable to that node and its writes are already in the origin. Merge-back needs '
      + 'either the reported answer or a private-home diff: wire a NodeWorkspaceProvisioner so '
      + "the node gets a private home, and its diff becomes its own.");
  }

  // Rule 1: a dependency has not settled. The only place a dependency edge is enforced.
  const waiting = member.deps.filter((dep) => !ctx.applied.has(dep));

  if (waiting.length > 0) {
    return refuse('dependency-unsettled', 'bad_input',
      `node ${member.nodeId} merges after ${waiting.join(', ')}, and ${
        waiting.length === 1 ? 'that member has' : 'those members have'
      } not merged. Order the members so a dependency precedes what depends on it.`);
  }

  // Rule 2: no verdict.
  if (member.verdict === null) {
    return refuse('no-verdict', 'missing',
      `node ${member.nodeId} has no verdict, so nothing has checked what it produced. A member `
      + 'is graded before it is applied — call the report tool\'s verifier on it first.');
  }

  // Rule 3: verdict not clean.
  if (!member.verdict.clean) {
    return refuse('verdict-unclean', 'denied',
      `node ${member.nodeId} was checked and did not pass, so its work is a graded failure rather `
      + 'than a candidate to land. An accepted-with-failure report is a legitimate worst-direction '
      + 'score and is not a merge.');
  }

  // Rule 5 before rule 4: scope escape is knowable without the costly re-verification.
  const escaped = scopeEscapes(member);

  if (escaped.length > 0) {
    return refuse('scope-escape', 'denied',
      `node ${member.nodeId} wrote ${escaped.join(', ')}, outside the scope it declared (${
        (member.scope ?? []).join(', ')
      }). The scope check reads what was ACTUALLY written, so widen the declared scope or keep the `
      + 'writes inside it.');
  }

  // Rule 4: stale verdict. Must precede rule 6, or every rebased member refuses as drift.
  // `Rebase.lean — member_only_binding_cannot_see_the_origin`,
  // `Rebase.lean — the_base_key_moves_when_a_touched_path_moves`,
  // `Rebase.lean — applied_is_bound_to_the_base_it_lands_on`,
  // `Rebase.lean — rebase_applies_only_bound_verdicts`.
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

  // Rule 6: drift at a path this settle did not move (rebased paths are rule 4's).
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

/** Re-verification, or a fail-closed refusal when none is wired. */
async function reverified(
  member: MergeMember, baseDigest: string, deps: MergeBackDeps,
): Promise<MemberVerdict | Refusal> {
  if (!deps.reverify) {
    return refusalOf(new KinuError('unavailable',
      `node ${member.nodeId}'s verdict was issued against a base this settle has since changed, and `
      + 'no re-verification is wired, so the verdict cannot be revalidated. A stale verdict never '
      + 'applies: wire a Reverifier over the verifier registry, or merge this member first so its '
      + 'base is the one it was checked against.'));
  }

  const fresh = await deps.reverify({ member, baseDigest });

  if ('reason' in fresh) return fresh;

  // A re-verification bound to a different base does not answer the question asked.
  if (fresh.baseDigest !== baseDigest) {
    return refusalOf(new KinuError('unavailable',
      `node ${member.nodeId}'s re-verification returned a verdict bound to a different base than `
      + 'the one it was asked about, so it does not revalidate this apply.'));
  }

  return fresh;
}

/** Paths written outside the declared scope. A null scope is not an empty allow-list. */
function scopeEscapes(member: MergeMember): string[] {
  const scope = member.scope;

  if (scope === null) return [];

  return member.diff.files
    .map((f) => f.path)
    .filter((path) => !scope.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)));
}

/** Paths whose origin content differs from the recorded base, excluding paths this settle rebased. */
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

/** Apply one member all-or-nothing; the bound is checked before the first write. */
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

    // Own event name so torn-or-nearly applies are queryable.
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
        renderThrownChain({ cause: err })
      }. The transaction is all-or-nothing, so nothing of this member landed.`);

    deps.log.failure('swarm.merge_apply_failed',
      new KinuError('io', refusal.error, { cause: err instanceof Error ? err : undefined }),
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

/** The earlier member this one disagrees with (different bytes, not mere overlap), or null. */
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

/** Spawns a merge node graded like any other; no model edits the conflict in place. */
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
  return { ...refusalOf(new KinuError(reason, message)), cause };
}

export type CarryVerdict =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'refused'; readonly cause: 'below-threshold' | 'unmeasurable' | 'sealed' };

/**
 * Carry admission at settle: `records` seal via `admitsPublication`, then a measured score,
 * then the `artifacts` threshold.
 */
export function admitCarry(input: {
  readonly carry: SwarmCarrySetting;
  readonly score: number | null;
  readonly publication: PublicationState;
}): CarryVerdict {
  const { carry, score, publication } = input;

  // `none` and `reflections` publish nothing.
  if (carry.kind !== 'elites' && carry.kind !== 'artifacts') return { kind: 'admitted' };

  if (admitsPublication(publication, 'records').kind === 'refused') {
    return { kind: 'refused', cause: 'sealed' };
  }

  if (score === null) return { kind: 'refused', cause: 'unmeasurable' };

  if (carry.kind === 'artifacts' && score < carry.threshold) {
    return { kind: 'refused', cause: 'below-threshold' };
  }

  return { kind: 'admitted' };
}

/** One event per member so a reader can see why a given elite was not carried. */
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

    // Branch here so each outcome keeps a constant, greppable event name.
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

/** Missing is null; other read failures propagate, since unreadable is not absent. */
export function originReader(vfs: VFS): (path: string) => Promise<string | null> {
  return async (path) => {
    try {
      const payload = textPayload(await vfs.readFile(path, { encoding: 'utf8' }));

      // A binary path reads as absent, so rule 6 refuses rather than inventing a base.
      return payload.kind === 'text' ? payload.text : null;
    } catch (err) {
      if (isVfsError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  };
}
