/**
 * MCTS backpropagation — full ancestor walk via WITH RECURSIVE CTE.
 *
 * Architecture reference: docs/MCTS.md — "Backpropagation"
 * Paper: LATS arXiv:2310.04406 §4.2 Backpropagation
 * Formal spec: MCTS/Backpropagation.lean — backprop_preserves_ids
 *
 * The running mean formula: V(sᵢ) = (V_old(sᵢ) · (N(sᵢ) - 1) + r) / N(sᵢ)
 * Implemented as: value = (value * visits + reward) / (visits + 1)
 *
 * SQL SET clauses use pre-update snapshot of rows (verified in SQLite tests):
 * when updating multiple rows in one statement, each row's `visits` and `value`
 * refer to the OLD values, not the already-updated values. This makes the
 * running mean formula correct across the entire ancestor chain.
 */

import type { SqlExecutor } from '../types/primitives.js';

/**
 * Backpropagate reward from leaf to root via WITH RECURSIVE CTE.
 *
 * Trace for leaf → child → root:
 *   Base: ('leaf', 0)
 *   Step: s.id='leaf', s.parent_id='child' → emit ('child', 1)
 *   Step: s.id='child', s.parent_id='root' → emit ('root', 2)
 *   Step: s.id='root', s.parent_id=NULL → WHERE stops recursion
 *   ancestors = {leaf, child, root} — all correct node IDs
 *
 * Formal spec: MCTS/Backpropagation.lean:backprop_preserves_ids proves IDs unchanged.
 */
export function backpropagate(
  sql: SqlExecutor,
  leafNodeId: string,
  reward: number,
): void {
  // Clamp reward to [0, 1] — out-of-range values break UCT and convergence
  reward = Math.max(0, Math.min(1, reward));
  sql`
    WITH RECURSIVE ancestors(id, depth) AS (
      SELECT id, 0 FROM search_nodes WHERE id = ${leafNodeId}
      UNION ALL
      SELECT s.parent_id, a.depth + 1
      FROM search_nodes s
      JOIN ancestors a ON s.id = a.id
      WHERE s.parent_id IS NOT NULL
    )
    UPDATE search_nodes
    SET
      visits = visits + 1,
      value  = (value * visits + ${reward}) / (visits + 1)
    WHERE id IN (SELECT id FROM ancestors)
  `;
}
