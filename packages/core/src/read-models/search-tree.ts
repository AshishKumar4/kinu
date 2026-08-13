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
    SELECT id, parent_id, root_id, task, action, observation, code_used,
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
    SELECT id, parent_id, root_id, task, action, observation, code_used,
           visits, value, depth, status, msg_id, branch_agent_key, created_at
    FROM search_nodes WHERE root_id = ${rootId}
    ORDER BY depth, created_at`;
}
