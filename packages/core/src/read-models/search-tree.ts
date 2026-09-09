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
 * its root.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../state/actor-handle';
import type { NodeStatus, SearchNode } from '../types/mcts';

export function readLatestSearchTree(sql: SqlExecutor, actor: ActorHandle): SearchNode[] {
  actor.assertCurrent();
  return sql<SearchNode>`
    SELECT id, parent_id, root_id, task, action, observation, code_used, code_language,
           visits, value, depth, status, msg_id, branch_agent_key, created_at
    FROM search_nodes
    WHERE actor_id = ${actor.actorId} AND root_id = (
      SELECT root_id FROM search_nodes WHERE actor_id = ${actor.actorId}
      GROUP BY root_id ORDER BY MAX(created_at) DESC, root_id DESC LIMIT 1
    )
    ORDER BY depth, created_at`;
}

/**
 * One named search's tree — the ONE scoped projection every tree view is built
 * from, whether it shows a single search or a canvas of them.
 *
 * The unified fork list can select a competed run that is not the latest, and
 * "latest" is then the wrong tree to show — it would render another search's
 * branches under the selected run's heading. Same projection, same ordering,
 * scoped by the root the caller asked for.
 *
 * A canvas showing several searches composes this per root
 * ({@link readExplorationCanvas}) rather than flattening the table, and the
 * roots are the caller's page. A multi-root read choosing its own roots by
 * recency INDEPENDENTLY of the run list beside it — by `MAX(created_at)` where
 * the run list orders by first write — would disagree with that list about
 * which searches exist, and the canvas would draw a listed fork with no tree
 * under it. Taking the page from the caller leaves that disagreement nowhere
 * to live.
 */
export function readSearchTree(sql: SqlExecutor, actor: ActorHandle, rootId: string): SearchNode[] {
  actor.assertCurrent();
  return sql<SearchNode>`
    SELECT id, parent_id, root_id, task, action, observation, code_used, code_language,
           visits, value, depth, status, msg_id, branch_agent_key, created_at
    FROM search_nodes WHERE actor_id = ${actor.actorId} AND root_id = ${rootId}
    ORDER BY depth, created_at`;
}

/** One node as a LIST shows it — the shape a path entry and a child row share. */
export interface SearchNodeSummary {
  id: string;
  parentId: string | null;
  depth: number;
  visits: number;
  value: number;
  status: NodeStatus;
  action: string;
  createdAt: number;
}

/** One node in full, with the ancestry that reached it and the children it
 *  opened. */
export interface SearchNodeDetail extends SearchNodeSummary {
  task: string;
  observation: string;
  codeUsed: string | null;
  branchAgentKey: string | null;
  msgId: string | null;
  /** Root first, this node last. */
  path: SearchNodeSummary[];
  /** Best first: value, then visits, then insertion order. */
  children: SearchNodeSummary[];
}

/** Exactly the columns the detail view renders — a projection, not the whole
 *  `SearchNode`. */
interface DetailRow {
  id: string;
  parent_id: string | null;
  depth: number;
  visits: number;
  value: number;
  status: NodeStatus;
  action: string;
  task: string;
  observation: string;
  code_used: string | null;
  branch_agent_key: string | null;
  msg_id: string | null;
  created_at: number;
}

const summarize = (node: DetailRow): SearchNodeSummary => ({
  id: node.id,
  parentId: node.parent_id,
  depth: node.depth,
  visits: node.visits,
  value: node.value,
  status: node.status,
  action: node.action,
  createdAt: node.created_at,
});

/**
 * One node, its ancestry and its children — what `kinu inspect mcts <id>`
 * and the tree view's node pane both show.
 *
 * This existed twice, once per backend, under two names and over two SQL
 * dialects: `OrchestratorAgent.getMctsNodeDetail` (a `@callable` over DO
 * SQLite) and `getLocalMctsNode` (over bun:sqlite). Same parent walk, same
 * cycle guard, same child ordering, same field projection — and the SAME CLI
 * command formatted whichever of the two answered, so a change to either was a
 * change to one half of one command. `gate:duplication` could not see it: the
 * SQL literal text differs, and that gate keeps literal text on purpose, which
 * its own header records as the near-copy it therefore misses.
 *
 * The ancestry walk is guarded against a cycle rather than trusting the tree to
 * be one: `parent_id` is a plain column, and a walk that trusted it would hang
 * the request instead of returning a wrong answer.
 */
export function readSearchNodeDetail(
  sql: SqlExecutor, actor: ActorHandle, nodeId: string,
): SearchNodeDetail | null {
  actor.assertCurrent();
  const readNode = (id: string): DetailRow | undefined => sql<DetailRow>`
    SELECT id, parent_id, depth, visits, value, status, action,
           task, observation, code_used, branch_agent_key, msg_id, created_at
    FROM search_nodes WHERE actor_id = ${actor.actorId} AND id = ${id} LIMIT 1`[0];

  const node = readNode(nodeId);
  if (node === undefined) return null;

  const path: SearchNodeSummary[] = [];
  const seen = new Set<string>();
  for (let cursor: DetailRow | undefined = node; cursor !== undefined && !seen.has(cursor.id);) {
    seen.add(cursor.id);
    path.unshift(summarize(cursor));
    cursor = cursor.parent_id === null ? undefined : readNode(cursor.parent_id);
  }

  const children = sql<DetailRow>`
    SELECT id, parent_id, depth, visits, value, status, action,
           task, observation, code_used, branch_agent_key, msg_id, created_at
    FROM search_nodes WHERE actor_id = ${actor.actorId} AND parent_id = ${nodeId}
    ORDER BY value DESC, visits DESC, created_at`;

  return {
    ...summarize(node),
    task: node.task,
    observation: node.observation,
    codeUsed: node.code_used,
    branchAgentKey: node.branch_agent_key,
    msgId: node.msg_id,
    path,
    children: children.map(summarize),
  };
}
