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
  codeUsed: string | null;
  depth: number;
}

/** The one `INSERT INTO search_nodes`; readers already branch on a null `msgId`. */
export function insertSearchNode(
  sql: SqlExecutor,
  actor: ActorHandle,
  node: RecordNodeOpts & { readonly msgId: string | null },
): void {
  actor.assertCurrent();
  void sql`
 INSERT INTO search_nodes
      (actor_id, id, parent_id, root_id, task, action, observation, code_used, depth, msg_id)
    VALUES
      (${actor.actorId}, ${node.nodeId}, ${node.parentNodeId ?? null}, ${node.rootId},
       ${node.task}, ${node.action}, ${node.observation},
       ${node.codeUsed ?? null}, ${node.depth}, ${node.msgId})
  `;
}
