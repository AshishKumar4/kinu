/**
 * MCTS backpropagation: full ancestor walk via WITH RECURSIVE CTE. Reference: docs/MCTS.md "Backpropagation".
 * Formal spec: MCTS/Backpropagation.lean — backprop_preserves_ids
 * SQL SET clauses read pre-update row values, so the running mean is correct across the whole chain.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

/**
 * Backpropagate reward from leaf to root.
 * Formal spec: MCTS/Backpropagation.lean:backprop_preserves_ids proves IDs unchanged.
 */
export function backpropagate(
  sql: SqlExecutor,
  actor: ActorHandle,
  leafNodeId: string,
  reward: number,
): void {
  // Clamp reward to [0, 1] — out-of-range values break UCT and convergence
  const clamped = Math.max(0, Math.min(1, reward));

  void sql`
    WITH RECURSIVE ancestors(id, depth) AS (
      SELECT id, 0 FROM search_nodes
        WHERE actor_id = ${actor.actorId} AND id = ${leafNodeId}
      UNION ALL
      SELECT s.parent_id, a.depth + 1
      FROM search_nodes s
      JOIN ancestors a ON s.id = a.id
      WHERE s.actor_id = ${actor.actorId} AND s.parent_id IS NOT NULL
    )
    UPDATE search_nodes
    SET
      visits = visits + 1,
      value  = (value * visits + ${clamped}) / (visits + 1)
    WHERE actor_id = ${actor.actorId} AND id IN (SELECT id FROM ancestors)
  `;
}
