/**
 * Subordinate-tree depth cap. The parent derives a child's depth and the seeding authority
 * writes it into the child's immutable identity row; a child never states its own depth.
 * The runtime refusal stays because a cached toolset can be built before the identity is seeded.
 */

import type { ErrorCode } from '../obs/error';
import type { WorkspaceActor } from '../identity/workspace-actors';

/** Global cap on subordinate-tree depth; the orchestrator is depth 0. Not configurable per actor. */
export const DELEGATION_MAX_DEPTH = 4;

/** Where an actor sits in its workspace's subordinate tree, and how much room
 *  is left below it. */
export interface DelegationBudget {
  /** 0 = the workspace orchestrator; 1 = a subordinate it hired; and so on. */
  readonly depth: number;
  /** Levels of hiring still available below this actor. 0 refuses. */
  readonly maxDepth: number;
}

/** The orchestrator's budget: the root, with the whole cap below it. */
export const ROOT_DELEGATION_BUDGET: DelegationBudget = {
  depth: 0,
  maxDepth: DELEGATION_MAX_DEPTH,
};

/** Budget from a stored depth, clamped at 0 so an old or negative row only narrows. */
export function delegationBudgetAtDepth(depth: number): DelegationBudget {
  const safeDepth = Math.max(0, depth);

  return { depth: safeDepth, maxDepth: Math.max(0, DELEGATION_MAX_DEPTH - safeDepth) };
}

/**
 * Budget from the actor's directory record, walked up to the root. A parent the directory
 * no longer describes ends the walk; the depth counted so far is a floor.
 */
export function delegationBudgetOf(
  describe: (actorId: string) => Pick<WorkspaceActor, 'parentActorId'> | null,
  record: Pick<WorkspaceActor, 'parentActorId'>,
): DelegationBudget {
  let depth = 0;
  let current: Pick<WorkspaceActor, 'parentActorId'> | null = record;

  while (current !== null && current.parentActorId !== null) {
    depth += 1;
    current = describe(current.parentActorId);
  }

  return delegationBudgetAtDepth(depth);
}

/** The budget a hired subordinate inherits: depth up one, room down one. */
export function deriveChildDelegationBudget(parent: DelegationBudget): DelegationBudget {
  return { depth: parent.depth + 1, maxDepth: Math.max(0, parent.maxDepth - 1) };
}

/** Whether this actor may still hire. */
export function delegationExhausted(budget: DelegationBudget): boolean {
  return budget.maxDepth <= 0;
}

/**
 * The refusal at the cap: `denied`, not `bad_input` (obs/error.ts). Covers both hire and
 * role-targeted `ask`, and points to a search, which has its own `depth` cap.
 */
export interface DelegationDepthRefusal {
  readonly reason: Extract<ErrorCode, 'denied'>;
  readonly error: string;
}

export function delegationDepthRefusal(budget: DelegationBudget): DelegationDepthRefusal {
  return {
    reason: 'denied',
    error:
      `Cannot create an agent below this one: it is at delegation depth ${budget.depth} of the `
      + `global maximum ${DELEGATION_MAX_DEPTH}, so a child of it would be depth ${budget.depth + 1}. `
      + 'This covers BOTH lifetimes that birth a child — a durable hire and a `lifetime:"task"` '
      + 'hire — because they add a level through the same substrate. Hand the work to an agent '
      + 'that already exists with `hire` naming `agent` instead (that adds no depth), or run '
      + 'the work as a search: agents({action:"swarm", task, config:{context:"inherit"}}) inherits '
      + 'your conversation and adds no depth to the subordinate tree.',
  };
}
