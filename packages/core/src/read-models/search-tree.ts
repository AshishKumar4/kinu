/** The swarm search tree a surface shows, scoped to one search root: `search_nodes` keeps every search's
 * settled tree. "Latest" is the tree with the newest node insert. */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { NodeStatus, SearchNode } from '../types/mcts';

export type SearchTreeRow = SearchNode & { readonly own_score: number | null };

export function readLatestSearchTree(sql: SqlExecutor, actor: ActorHandle): SearchTreeRow[] {
  actor.assertCurrent();

  return sql<SearchTreeRow>`
    SELECT id, parent_id, root_id, task, action, observation,
           visits, value, own_score, depth, status, created_at
    FROM search_node_scores
    WHERE actor_id = ${actor.actorId} AND root_id = (
      SELECT root_id FROM search_nodes WHERE actor_id = ${actor.actorId}
      GROUP BY root_id ORDER BY MAX(created_at) DESC, root_id DESC LIMIT 1
    )
    ORDER BY depth, created_at`;
}

/** One named search's tree. Canvases compose this per root from the caller's page; choosing roots by
 * recency here would disagree with the run list. */
export function readSearchTree(sql: SqlExecutor, actor: ActorHandle, rootId: string): SearchTreeRow[] {
  actor.assertCurrent();

  return sql<SearchTreeRow>`
    SELECT id, parent_id, root_id, task, action, observation,
           visits, value, own_score, depth, status, created_at
    FROM search_node_scores WHERE actor_id = ${actor.actorId} AND root_id = ${rootId}
    ORDER BY depth, created_at`;
}

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

export interface SearchNodeDetail extends SearchNodeSummary {
  task: string;
  observation: string;
  /** Root first, this node last. */
  path: SearchNodeSummary[];
  /** Best first: value, then visits, then insertion order. */
  children: SearchNodeSummary[];
}

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

/** One node, its ancestry and children (`kinu swarm <name> <id>` and the tree view's node pane).
 * The ancestry walk guards against cycles: `parent_id` is a plain column. */
export function readSearchNodeDetail(
  sql: SqlExecutor, actor: ActorHandle, nodeId: string,
): SearchNodeDetail | null {
  actor.assertCurrent();

  const readNode = (id: string): DetailRow | undefined => sql<DetailRow>`
    SELECT id, parent_id, depth, visits, value, status, action,
           task, observation, created_at
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
           task, observation, created_at
    FROM search_nodes WHERE actor_id = ${actor.actorId} AND parent_id = ${nodeId}
    ORDER BY value DESC, visits DESC, created_at`;

  return {
    ...summarize(node),
    task: node.task,
    observation: node.observation,
    path,
    children: children.map(summarize),
  };
}
