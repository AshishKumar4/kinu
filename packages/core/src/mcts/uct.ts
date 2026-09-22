/**
 * UCT selection. Reference: docs/MCTS.md "UCT Formula"; LATS arXiv:2310.04406 §3.2 Eq. (1).
 * SQLite log() is log10, so ln(x) = log(x) / log(exp(1.0)).
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { SearchNode } from '../types/mcts';
import { DEFAULT_CONFIG } from '../config';

export interface UctKnobs {
  readonly explorationWeight?: number;
  readonly maxDepth?: number;
}

/**
 * Select the best open node by UCT(s) = V(s) + W · √(ln(N(parent)) / N(s)).
 * The root uses its own visit count (floored at 2) as parent visits so it stays re-selectable.
 * Nodes at or past `maxDepth` are excluded, not aborted on; `rootId` scopes the argmax to this tree.
 */
export function selectNode(
  sql: SqlExecutor,
  actor: ActorHandle,
  rootId: string,
  knobs: UctKnobs = {},
): SearchNode | null {
  const W = knobs.explorationWeight ?? DEFAULT_CONFIG.mcts.explorationWeight;
  const maxDepth = knobs.maxDepth ?? DEFAULT_CONFIG.mcts.maxDepth;

  // parent_visits: the parent's visits for children; the root's own visits (floored) for the root.
  const rows = sql<SearchNode & { parent_visits: number }>`
    SELECT
      s.*,
      COALESCE(p.visits, max(2, s.visits)) AS parent_visits
    FROM search_nodes s
    LEFT JOIN search_nodes p ON p.actor_id = s.actor_id AND s.parent_id = p.id
    WHERE s.actor_id = ${actor.actorId} AND s.root_id = ${rootId}
      AND s.status = 'open' AND s.depth < ${maxDepth}
    ORDER BY (
      s.value + ${W} * sqrt(
        (log(max(2.0, COALESCE(p.visits, max(2, s.visits)))) / log(exp(1.0))) /
        max(1.0, s.visits)
      )
    ) DESC
    LIMIT 1
  `;

  return rows[0] ?? null;
}
