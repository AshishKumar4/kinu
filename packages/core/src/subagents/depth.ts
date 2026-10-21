/**
 * Subagent-tree depth cap. A child's depth is walked off the actor directory; a child never
 * states its own depth. The runtime refusal stays because a cached toolset can be built before
 * the child is seated.
 */

import type { ErrorCode } from '../obs/error';
import type { WorkspaceActor } from '../identity/workspace-actors';

/** Global cap on subagent-tree depth; the orchestrator is depth 0. Not configurable per actor. */
export const DELEGATION_MAX_DEPTH = 4;

/** Where an actor sits in its workspace's subagent tree, and how much room
 *  is left below it. */
export interface DelegationBudget {
  /** 0 = the workspace orchestrator; 1 = a subagent it hired; and so on. */
  readonly depth: number;
  /** Levels of hiring still available below this actor. 0 refuses. */
  readonly maxDepth: number;
  /** Why the walk could not reach the root, when it could not: a hirer the directory does not describe, or a line of
   *  hirers that returns to one already walked. Its depth is then unknown, and no room is granted below it. */
  readonly ancestry?: 'missing' | 'cycle';
}

/** The orchestrator's budget: the root, with the whole cap below it. */
export const ROOT_DELEGATION_BUDGET: DelegationBudget = {
  depth: 0,
  maxDepth: DELEGATION_MAX_DEPTH,
};

/**
 * Budget from the actor's directory record, walked up to the root. A walk that cannot reach the root fails closed: a
 * hirer the directory does not describe leaves the depth unknown, and a line of hirers that returns to one already
 * walked would never end, so either grants no room.
 */
export function delegationBudgetOf(
  describe: (actorId: string) => Pick<WorkspaceActor, 'parentActorId'> | null,
  record: Pick<WorkspaceActor, 'parentActorId'>,
): DelegationBudget {
  const walked = new Set<string>();
  let depth = 0;
  let current = record;

  while (current.parentActorId !== null) {
    if (walked.has(current.parentActorId)) return { depth, maxDepth: 0, ancestry: 'cycle' };
    walked.add(current.parentActorId);
    const parent = describe(current.parentActorId);

    if (parent === null) return { depth, maxDepth: 0, ancestry: 'missing' };
    depth += 1;
    current = parent;
  }

  return { depth, maxDepth: Math.max(0, DELEGATION_MAX_DEPTH - depth) };
}

/** Whether this actor may still hire or search: a search's nodes are agents a level below it, as a hire is. */
export function delegationExhausted(budget: DelegationBudget): boolean {
  return budget.maxDepth <= 0;
}

/** The refusal at the cap: `denied`, not `bad_input` (obs/error.ts). Covers a hire of either lifetime and a search. */
export interface DelegationDepthRefusal {
  readonly reason: Extract<ErrorCode, 'denied'>;
  readonly error: string;
}

/** What the refusal says of where the actor sits: its depth, or why it is unknown. */
function whereItSits(budget: DelegationBudget): string {
  if (budget.ancestry === 'missing') return 'one of the agents that hired it is no longer recorded, so its delegation depth is unknown. ';

  if (budget.ancestry === 'cycle') return 'the agents recorded as having hired it lead back to one another, so its delegation depth is unknown. ';

  return `it is at delegation depth ${budget.depth} of the global maximum ${DELEGATION_MAX_DEPTH}, so a child of it would be depth ${budget.depth + 1}. `;
}

export function delegationDepthRefusal(budget: DelegationBudget): DelegationDepthRefusal {
  return {
    reason: 'denied',
    error:
      `Cannot create an agent below this one: ${whereItSits(budget)}`
      + 'This covers every call that starts one: a durable hire, a `lifetime:"task"` hire and a swarm, whose nodes '
      + 'are agents a level below this one. An agent at this depth has no team and runs no search: do the work yourself.',
  };
}
