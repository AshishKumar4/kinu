/**
 * UCT (Upper Confidence bounds for Trees) selection.
 *
 * Architecture reference: final-architecture.md §5.6
 * Paper: LATS arXiv:2310.04406 §3.2 Equation (1)
 * Formal spec: UCT.lean — float_log_ofNat_one axiom, uct_root_is_value theorem
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
 * - log(1.0) / log(exp(1.0)) = 0, so root nodes get UCT = value only
 *
 * Formal spec: UCT.lean:uct_root_is_value proves this is correct at root.
 */
export function selectNode(
  sql: SqlExecutor,
  W: number = DEFAULT_CONFIG.mcts.explorationWeight,
): SearchNode | null {
  // ln(x) in SQLite = log10(x) / log10(e) = log(x) / log(exp(1.0))
  const rows = sql<SearchNode & { parent_visits: number }>`
    SELECT
      s.*,
      COALESCE(p.visits, 1) AS parent_visits
    FROM search_nodes s
    LEFT JOIN search_nodes p ON s.parent_id = p.id
    WHERE s.status = 'open'
    ORDER BY (
      s.value + ${W} * sqrt(
        (log(max(1.0, COALESCE(p.visits, 1))) / log(exp(1.0))) /
        max(1.0, s.visits)
      )
    ) DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
