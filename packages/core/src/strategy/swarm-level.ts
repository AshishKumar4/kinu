/**
 * Decides a swarm level's slots and what each is asked: a node's grant, the caller's
 * `SwarmInput.nodes`, generated angles, or a re-entry's journalled briefs.
 * Spec: docs/EXPLORATION.md "Arbitration", "Budget conservation", "Inherited context".
 */

import type { BranchContext, ResolvedSwarm } from './swarm';
import type { BranchGrant, SwarmBudget } from './swarm-budget';
import type { PendingSwarmNode, SwarmReentry } from './swarm-resume';
import { nanoid } from '../utils/nanoid';
import { diversityAngle } from '../mcts/diversity';

/** The journal preserves the chosen text for re-entry. */
export interface BranchAssignment {
  readonly brief: string;
  readonly siblings: readonly string[];
}

/** `siblings` is the level's original width, not the count re-run here; some members may already be recorded. */
export interface ResumedWave {
  readonly parentId: string;
  readonly siblings: number;
  readonly members: readonly PendingSwarmNode[];
}

/**
 * Pending nodes grouped per parent, in spawn order. A spawned node with no tree row
 * was already paid for and is re-run under its own id, never replaced.
 */
export function resumedWaves(reentry: SwarmReentry | null): ResumedWave[] {
  const byParent = new Map<string, { parentId: string; siblings: number; members: PendingSwarmNode[] }>();

  for (const node of reentry?.pending ?? []) {
    const wave = byParent.get(node.parentId);

    if (wave) wave.members.push(node);
    else byParent.set(node.parentId, {
      parentId: node.parentId, siblings: node.siblings, members: [node],
    });
  }

  return [...byParent.values()];
}

/**
 * The caller's first level as the root's grant, so it expands through the normal grant
 * path. Debited via `take` since grants are expanded uncharged. First attempt only: a
 * re-entry's first level already exists and re-granting would duplicate it.
 */
export function assignedRootGrant(input: {
  readonly resolved: ResolvedSwarm;
  readonly reentry: SwarmReentry | null;
  readonly budget: SwarmBudget;
}): BranchGrant | null {
  const assignments = input.resolved.nodes;

  if (!assignments || input.reentry) return null;
  const width = input.budget.take(assignments.length);

  if (width === 0) return null;

  return {
    kind: 'granted',
    width,
    nodeIds: Array.from({ length: width }, () => nanoid()),
    proposal: {
      rationale: input.resolved.name ?? input.resolved.label ?? input.resolved.preset,
      branches: assignments.slice(0, width).map((node) => ({
        task: node.task,
        // `prompt` is the brief.
        rationale: node.prompt,
        // Run-level, never per node: shared `context` keeps siblings comparable.
        context: input.resolved.config.context,
      })),
    },
  };
}

export interface LevelSlot {
  readonly index: number;
  readonly id: string;
  readonly task: string;
  readonly rationale: string;
  readonly context: BranchContext;
  readonly assignment: BranchAssignment | null;
}

function levelBriefs(grant: BranchGrant | null, resumed: ResumedWave | null, width: number): readonly string[] {
  if (grant) return grant.proposal.branches.map((branch) => branch.rationale);

  if (resumed) return resumed.members[0]?.briefs ?? [];

  return Array.from({ length: width }, (_unused, index) => diversityAngle(index, width));
}

/** A re-entry reads briefs from all journalled siblings, including settled ones. */
export function planLevel(input: {
  readonly resolved: ResolvedSwarm;
  readonly resumed: ResumedWave | null;
  readonly grant: BranchGrant | null;
  readonly width: number;
}): readonly LevelSlot[] {
  const { resolved, resumed, grant, width } = input;

  const briefs = levelBriefs(grant, resumed, width);

  const filled: readonly { readonly index: number; readonly pending: PendingSwarmNode | null }[] =
    resumed
      ? resumed.members.map((node) => ({ index: node.index, pending: node }))
      : Array.from({ length: width }, (_unused, index) => ({ index, pending: null }));

  return filled.map(({ index, pending }): LevelSlot => {
    const branch = grant?.proposal.branches[index];
    const brief = briefs?.[index];

    return {
      index,
      id: pending?.id ?? grant?.nodeIds[index] ?? nanoid(),
      // A resumed node is re-asked in its recorded words.
      task: pending?.task ?? branch?.task ?? resolved.task,
      rationale: pending?.rationale ?? brief ?? '',
      context: branch?.context ?? resolved.config.context,
      assignment: brief !== undefined
        ? { brief, siblings: briefs.filter((_unused, slot) => slot !== index) }
        : null,
    };
  });
}
