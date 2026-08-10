/**
 * UCT (Upper Confidence bounds for Trees) selection.
 *
 * Architecture reference: docs/MCTS.md — "UCT Formula"
 * Paper: LATS arXiv:2310.04406 §3.2 Equation (1)
 *
 * CRITICAL: SQLite log() is log₁₀, NOT natural log (ln).
 * The UCT formula requires ln. We use: ln(x) = log(x) / log(exp(1.0))
 * Confirmed: sqlite3 "SELECT log(exp(1.0))" → 0.434 (log₁₀(e)), not 1.0.
 */

import type { SqlExecutor } from '../types/primitives.js';
import type { SearchNode } from '../types/mcts.js';
import { DEFAULT_CONFIG } from '../config.js';

/**
 * Select the best open node using UCT with CORRECT natural log.
 *
 * UCT(s) = V(s) + W · √( ln(N(parent)) / N(s) )
 *
 * In SQLite: ln(x) = log(x) / log(exp(1.0))
 * - max(1.0, ...) guards against log(0) and division by zero
 *
 * ROOT RE-WIDENING (#5): the root has no parent, so a literal ln(N(parent))
 * would be ln(1)=0 — the root's exploration term collapses to zero and it is
 * never re-selected after the first expansion, permanently freezing breadth at
 * N=branches and discarding the proposer's own ranking. We instead use the
 * root's OWN visit count as its synthetic parent-visit (the total simulations
 * that flowed through it — the correct N for "re-widen the root vs descend").
 * Floored at 2 so ln(2)>0 keeps the root selectable across iterations; it still
 * decays as the root accrues visits, so the tree deepens over time.
 *
 * DEPTH CAP (WP-A4): nodes at or beyond `maxDepth` are excluded in the WHERE
 * clause, not by aborting the whole search when the argmax happens to be deep.
 * A node at depth d expands children at d+1, so only nodes with depth < maxDepth
 * can still produce in-bounds children — selection skips the depth-capped ones
 * and keeps spending the budget on the shallower frontier instead of dying.
 *
 * TREE SCOPE: `rootId` confines the argmax to this search's own tree. Without
 * it selection was a global argmax over every open node in the workspace, so a
 * tree left open by an interrupted or failed search silently captured the next
 * task's budget. Scoping is compatible with resume — a resumed run re-enters
 * with the persisted rootId and sees exactly its own frontier.
 */
export function selectNode(
  sql: SqlExecutor,
  rootId: string,
  W: number = DEFAULT_CONFIG.mcts.explorationWeight,
  maxDepth: number = DEFAULT_CONFIG.mcts.maxDepth,
): SearchNode | null {
  // ln(x) in SQLite = log10(x) / log10(e) = log(x) / log(exp(1.0)).
  // parent_visits: real parent's visits for children; the node's own visits
  // (floored) for the root, so the root keeps a non-zero exploration term.
  const rows = sql<SearchNode & { parent_visits: number }>`
    SELECT
      s.*,
      COALESCE(p.visits, max(2, s.visits)) AS parent_visits
    FROM search_nodes s
    LEFT JOIN search_nodes p ON s.parent_id = p.id
    WHERE s.root_id = ${rootId} AND s.status = 'open' AND s.depth < ${maxDepth}
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
