/** Tree mechanics shared by expansion, fan-in and scoring; orchestration lives in `swarm-run.ts`. */
import * as v from 'valibot';
import type { ModelMessage } from 'ai';
import type { Usage } from '../usage';
import { toKinuError, type KinuError } from '../obs/error';
import type { Logger } from '../obs/index';
import type { FrontierPolicy } from '../mcts/frontier';
import type { HeadReport } from '../heads/types';
import type { BranchDecision, BranchGrant, SwarmBudget } from './swarm-budget';
import type {
  BranchProposal, BranchRefusalPolicy, BranchVerdict, ResolvedSwarm, SwarmAdvance,
  SwarmPreset,
} from './swarm';
import {
  dominatesPareto, type Measurement, type MeasurementContext, type ParetoAxis,
  type ParetoEvidence,
} from './objective';

/** Node content; selection state (visits, mean, depth, status) lives in the `search_nodes` row. */
export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
  /** Engine-written as parent depth plus one; never supplied by a node. */
  readonly depth: number;
  /** The root's is the workspace as found, null when empty. */
  readonly artifact: string | null;
  /** Null means no usable answer, not a measurement of zero. */
  readonly measurement: Measurement | null;
  /** Normalised [0,1] reward its ancestors received; null when never scored. */
  readonly score: number | null;
  /** Pareto selection uses these vectors directly, never a synthetic scalar. */
  readonly pareto: ParetoEvidence | null;
  /** Unanswered request; cleared when arbitration answers it. */
  proposal: BranchProposal | null;
  /** Unparseable proposal; never reached the arbiter, so reported under its own event. */
  readonly proposalError: string | null;
  /**
   * An agent node's paid grant, still unexpanded. Cleared on expansion so a
   * re-selected node cannot spend one debit twice.
   */
  granted: BranchGrant | null;
  /** Seed for a `fresh` child (*Inherited context*). Null for the root and thought nodes. */
  readonly conclusion: string | null;
  /**
   * Inherited plus produced messages for a `fork` child. Append-only so siblings share
   * one byte-identical cacheable prefix.
   */
  readonly transcript: readonly ModelMessage[];
  /**
   * Compacted {@link transcript}, held on the parent so siblings share one view
   * (*Inherited context*: once per branch point).
   */
  compacted: readonly ModelMessage[] | null;
  /**
   * Fan-in dependency edges under `expand:'aggregate'`. Distinct from the {@link parentId}
   * selection edge, so one measurement never feeds two ancestor means.
   */
  readonly aggregated: readonly string[];
}

/** How a node stopped short; `completed` is excluded by type. */
export interface NodeStop {
  readonly status: Exclude<HeadReport['status'], 'completed'>;
  readonly detail: string;
}

export interface Expansion {
  readonly id: string;
  /** Carried per expansion: a fan-in vertex has a different parent and depth from the level it consumed. */
  readonly parentId: string;
  readonly depth: number;
  /** Fan-in dependency edges; empty for a wave sibling. */
  readonly aggregated: readonly string[];
  readonly artifact: string;
  /**
   * Non-null means do not measure: an unfinished node's summary is still a string
   * the instrument would score. The status is kept apart from the detail so the barrier
   * can tell an all-broken level (refuse) from a deadline-cut one.
   */
  readonly incomplete: NodeStop | null;
  /** Output as written, fences intact, for judges; {@link artifact} is the extracted program. */
  readonly answer: string;
  /** A thought node's marker-line request; always null for an agent node. */
  readonly proposal: BranchProposal | null;
  readonly proposalError: string | null;
  readonly granted: BranchGrant | null;
  readonly conclusion: string | null;
  readonly transcript: readonly ModelMessage[];
  readonly usage: Usage;
  /** Null where the model call was already reported elsewhere. */
  readonly modelId: string | null;
}

/**
 * No elapsed-time arm, by design: a node waiting on background work is healthy,
 * and a wall-clock bound cannot tell it from a stalled one.
 */
export type NodeAnswer =
  | { readonly kind: 'expanded'; readonly expansion: Expansion }
  | { readonly kind: 'failed'; readonly error: KinuError };

export interface LevelMember {
  readonly id: string;
  readonly node: Promise<Expansion>;
}

export interface LevelAnswer {
  readonly id: string;
  readonly answer: NodeAnswer;
}

/** Every member answers or fails; nothing here bounds a member's time. */
export async function awaitLevel(members: readonly LevelMember[]): Promise<readonly LevelAnswer[]> {
  return Promise.all(members.map(async (member): Promise<LevelAnswer> => {
    try {
      return { id: member.id, answer: { kind: 'expanded', expansion: await member.node } };
    } catch (cause) {
      return {
        id: member.id,
        answer: {
          kind: 'failed',
          error: toKinuError({
            doing: `expand node ${member.id} of this level`, cause, otherwise: 'unavailable',
          }),
        },
      };
    }
  }));
}

export function frontierPolicyOf(advance: SwarmAdvance): FrontierPolicy | 'pareto' | null {
  switch (advance) {
    case 'uct':
    case 'best-first':
    case 'none':
      return advance;
    case 'archive':
      return 'none';
    case 'pareto':
      return 'pareto';
  }
}

/** Stable node-id order. Only leaves with complete evidence participate. */
export function selectParetoFrontierNode(
  nodes: ReadonlyMap<string, TreeNode>,
  maxDepth: number,
  axes: readonly ParetoAxis[],
): TreeNode | null {
  const root = [...nodes.values()].find((node) => node.parentId === null);

  if (root && ![...nodes.values()].some((node) => node.parentId === root.id)) return root;

  const leaves = [...nodes.values()]
    .filter((node) => node.depth < maxDepth
      && node.pareto !== null
      && ![...nodes.values()].some((child) => child.parentId === node.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  const candidates = leaves.flatMap((node) =>
    node.pareto === null ? [] : [{ node, evidence: node.pareto }]);

  const front = candidates.filter((candidate, index) => !candidates.some((other, otherIndex) =>
    otherIndex !== index && dominatesPareto(axes, other.evidence, candidate.evidence)));

  return front[0]?.node ?? null;
}

/** Absence is checked, not caught: other read failures are a broken instrument. */
export async function readArtifact(ctx: MeasurementContext, path: string): Promise<string | null> {
  if (!await ctx.vfs.exists(path)) return null;
  const text = v.safeParse(v.string(), await ctx.vfs.readFile(path, { encoding: 'utf8' }));

  return text.success ? text.output : null;
}

/** Root-first, inclusive. Cycle-guarded. */
export function pathTo(nodes: ReadonlyMap<string, TreeNode>, node: TreeNode): TreeNode[] {
  const path: TreeNode[] = [];
  const seen = new Set<string>();
  let current: TreeNode | undefined = node;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId === null ? undefined : nodes.get(current.parentId);
  }

  return path;
}

/** Where a thought node's verdict lands (*Arbitration*): it has no channel back. */
export function reportVerdict(log: Logger, input: {
  readonly verdict: BranchVerdict;
  readonly preset: SwarmPreset;
  readonly nodeId: string;
  readonly atDepth: number;
  readonly policy: BranchRefusalPolicy | null;
}): void {
  if (input.verdict.kind === 'accepted') {
    log.event('swarm.branch_accepted', {
      preset: input.preset, node: input.nodeId, depth: input.atDepth,
      children: input.verdict.nodeIds.length,
    });

    return;
  }

  log.event('swarm.branch_refused', {
    preset: input.preset, node: input.nodeId, depth: input.atDepth,
    // The token makes "none of the five is unreachable" checkable.
    policy: input.policy ?? '',
    reason: input.verdict.reason,
    error: input.verdict.error,
  });
}

/**
 * Supplies depth and remaining budget, which a node may not supply, and debits via the
 * budget (*Budget conservation*).
 */
export function answerProposal(input: {
  readonly log: Logger;
  readonly node: TreeNode;
  readonly resolved: ResolvedSwarm;
  readonly budget: SwarmBudget;
}): BranchDecision | null {
  const { node, resolved } = input;
  const proposal = node.proposal;

  if (!proposal) return null;

  const decision = input.budget.arbitrate({
    config: resolved.config,
    caps: resolved.caps,
    atDepth: node.depth,
    proposal,
  });

  if (decision.kind === 'refused') {
    reportVerdict(input.log, {
      verdict: { kind: 'refused', reason: 'denied', error: decision.error },
      preset: resolved.preset, nodeId: node.id, atDepth: node.depth,
      policy: decision.policy,
    });
  }

  return decision;
}
