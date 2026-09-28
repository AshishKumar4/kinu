/** The one writer of a `search_nodes` row. */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

export interface RecordNodeOpts {
  nodeId: string;
  parentNodeId: string | null;
  rootId: string;
  task: string;
  action: string;
  observation: string;
  depth: number;
}

/** The one `INSERT INTO search_nodes`. */
export function insertSearchNode(sql: SqlExecutor, actor: ActorHandle, node: RecordNodeOpts): void {
  actor.assertCurrent();
  void sql`
 INSERT INTO search_nodes
      (actor_id, id, parent_id, root_id, task, action, observation, depth)
    VALUES
      (${actor.actorId}, ${node.nodeId}, ${node.parentNodeId ?? null}, ${node.rootId},
       ${node.task}, ${node.action}, ${node.observation}, ${node.depth})
  `;
}
