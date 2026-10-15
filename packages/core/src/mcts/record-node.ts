/** The one writer of a `search_nodes` row. */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

interface NodeFields {
  nodeId: string;
  rootId: string;
  action: string;
  observation: string;
  depth: number;
}

/** The search's task is its root's alone; a child reads it through `search_node_scores`. */
export type RecordNodeOpts = NodeFields & ({ parentNodeId: null; task: string } | { parentNodeId: string });

/** The one `INSERT INTO search_nodes`. */
export function insertSearchNode(sql: SqlExecutor, actor: ActorHandle, node: RecordNodeOpts): void {
  actor.assertCurrent();
  void sql`
 INSERT INTO search_nodes
      (actor_id, id, parent_id, root_id, task, action, observation, depth)
    VALUES
      (${actor.actorId}, ${node.nodeId}, ${node.parentNodeId}, ${node.rootId},
       ${node.parentNodeId === null ? node.task : null}, ${node.action}, ${node.observation}, ${node.depth})
  `;
}
