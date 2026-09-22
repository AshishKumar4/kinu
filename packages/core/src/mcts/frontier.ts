/**
 * The `advance` scheduler: every advance value resolves through this one selection function.
 * Specified by docs/EXPLORATION.md "Arbitration" and "The Lean invariants".
 * The depth cap is a where-clause exclusion in every arm, never a search abort.
 * UCT alone re-selects expanded nodes (re-widening); the other arms read the unexpanded frontier.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { SearchNode } from '../types/mcts';
import { selectNode } from './uct';

/** The `advance` values that select inside a running tree (`archive` resolves to `none`; `pareto` is refused). */
export type FrontierPolicy = 'uct' | 'best-first' | 'none';

export interface FrontierInput {
  /** This search's own tree, so an abandoned tree cannot capture the budget. */
  readonly rootId: string;
  readonly policy: FrontierPolicy;
  readonly maxDepth: number;
  /** Read only by the `uct` arm. */
  readonly explorationWeight: number;
}

/** The next node to expand, or null when nothing is selectable (a settled search, not an error). */
export function selectFrontierNode(
  sql: SqlExecutor, actor: ActorHandle, input: FrontierInput,
): SearchNode | null {
  const { rootId, maxDepth } = input;

  switch (input.policy) {
    case 'uct':
      return selectNode(sql, actor, rootId, { explorationWeight: input.explorationWeight, maxDepth });
    case 'best-first':
      return bestUnexpanded(sql, actor, rootId, maxDepth);
    case 'none':
      return unexpandedRoot(sql, actor, rootId, maxDepth);
  }
}

/**
 * Greedy best-first over the unexpanded frontier. Not `selectNode(..., 0)`: that can re-pick the
 * parent whose mean ties its best child, stalling the search.
 */
function bestUnexpanded(
  sql: SqlExecutor, actor: ActorHandle, rootId: string, maxDepth: number,
): SearchNode | null {
  return sql<SearchNode>`
    SELECT s.* FROM search_nodes s
    WHERE s.actor_id = ${actor.actorId} AND s.root_id = ${rootId}
      AND s.status = 'open' AND s.depth < ${maxDepth}
      AND NOT EXISTS (
        SELECT 1 FROM search_nodes c WHERE c.actor_id = s.actor_id AND c.parent_id = s.id)
    ORDER BY s.value DESC, s.created_at ASC, s.id ASC
    LIMIT 1
  `[0] ?? null;
}

/** `advance:'none'`: the root, only while never expanded. */
function unexpandedRoot(
  sql: SqlExecutor, actor: ActorHandle, rootId: string, maxDepth: number,
): SearchNode | null {
  return sql<SearchNode>`
    SELECT s.* FROM search_nodes s
    WHERE s.actor_id = ${actor.actorId} AND s.id = ${rootId}
      AND s.status = 'open' AND s.depth < ${maxDepth}
      AND NOT EXISTS (
        SELECT 1 FROM search_nodes c WHERE c.actor_id = s.actor_id AND c.parent_id = s.id)
    LIMIT 1
  `[0] ?? null;
}
