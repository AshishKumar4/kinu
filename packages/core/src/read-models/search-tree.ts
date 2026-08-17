/**
 * The MCTS tree a surface shows — the LATEST search, not the pile.
 *
 * Every search leaves its settled tree in `search_nodes` (failed and converged
 * runs are retired in place, never deleted), so the table holds one tree per
 * search the workspace ever ran. The engine's own reads have been scoped by
 * `root_id` since the search-isolation fix; the UI read never was, and a
 * client that flattens the whole table renders whichever root it happens to
 * pick — in practice the workspace's FIRST search, forever. This is the one
 * scoped projection both backends serve to the MCTS views.
 *
 * "Latest" is the tree most recently written to (its newest node insert), so
 * a resumed search that is still growing outranks a newer one that died at
 * its root. Legacy pre-`root_id` rows are invisible to scoped queries by
 * design (mcts/schemas.ts).
 */

import type { SqlExecutor } from '../types/primitives.js';
import type { SearchNode } from '../types/mcts.js';

export function readLatestSearchTree(sql: SqlExecutor): SearchNode[] {
  return sql<SearchNode>`
    SELECT id, parent_id, root_id, task, action, observation, code_used, code_language,
           visits, value, depth, status, msg_id, branch_agent_key, created_at
    FROM search_nodes
    WHERE root_id = (
      SELECT root_id FROM search_nodes WHERE root_id IS NOT NULL
      GROUP BY root_id ORDER BY MAX(created_at) DESC, root_id DESC LIMIT 1
    )
    ORDER BY depth, created_at`;
}

/**
 * One named search's tree.
 *
 * The unified fork list can select a competed run that is not the latest, and
 * "latest" is then the wrong tree to show — it would render another search's
 * branches under the selected run's heading. Same projection, same ordering,
 * scoped by the root the caller asked for.
 */
export function readSearchTree(sql: SqlExecutor, rootId: string): SearchNode[] {
  return sql<SearchNode>`
    SELECT id, parent_id, root_id, task, action, observation, code_used, code_language,
           visits, value, depth, status, msg_id, branch_agent_key, created_at
    FROM search_nodes WHERE root_id = ${rootId}
    ORDER BY depth, created_at`;
}

/**
 * Every recent search's tree, in ONE projection — what a canvas showing all of
 * a workspace's trees side by side reads.
 *
 * Explicitly multi-root, and that distinction is load-bearing. The bug this
 * table's scoping exists to prevent was an UNSCOPED read whose rows the client
 * folded into whichever root it happened to pick, silently dropping every node
 * not reachable from it. Removing the scoping to get several trees would
 * reintroduce exactly that. So the roots are chosen here, by recency, and every
 * row carries the `root_id` that says which tree it belongs to — a caller folds
 * per root and cannot accidentally fold across them.
 *
 * Ordered by root (newest search first), then depth and insertion inside each,
 * so consecutive rows of one tree stay together and each tree arrives in the
 * same order {@link readSearchTree} delivers it.
 */
export function readSearchForest(sql: SqlExecutor, limit = 30): SearchNode[] {
  return sql<SearchNode>`
    WITH roots AS (
      SELECT root_id, MAX(created_at) AS last_write
      FROM search_nodes WHERE root_id IS NOT NULL
      GROUP BY root_id ORDER BY last_write DESC, root_id DESC LIMIT ${limit}
    )
    SELECT n.id, n.parent_id, n.root_id, n.task, n.action, n.observation, n.code_used,
           n.code_language, n.visits, n.value, n.depth, n.status, n.msg_id,
           n.branch_agent_key, n.created_at
    FROM search_nodes n JOIN roots r ON r.root_id = n.root_id
    ORDER BY r.last_write DESC, n.root_id DESC, n.depth, n.created_at`;
}
