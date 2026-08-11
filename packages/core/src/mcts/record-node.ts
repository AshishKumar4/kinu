/**
 * Record a new MCTS node in both search_nodes SQL table and Session message tree.
 *
 * Architecture reference: docs/MCTS.md — "search_nodes Table"
 *
 * CRITICAL: SessionMessage uses `parts: SessionMessagePart[]`, NOT `content: string`.
 * The architecture doc's v1 used `content: "..."` which is a TYPE ERROR.
 */

import type { SqlExecutor } from '../types/primitives.js';
import { nanoid } from '../utils/nanoid.js';

/** SessionMessage with correct `parts` field (not `content`) */
export interface SessionMessagePart {
  type: 'text';
  text: string;
}

export interface SessionMessage {
  id: string;
  role: 'assistant' | 'user';
  parts: SessionMessagePart[];
}

/** Minimal Session interface — the subset we need for MCTS node recording */
export interface SessionWriter {
  appendMessage(message: SessionMessage, parentId?: string | null): Promise<void>;
  getHistory(leafId?: string | null): Array<{ role: string; content: string }>;
}

export interface RecordNodeOpts {
  nodeId: string;
  parentNodeId: string | null;
  parentMsgId: string | null;
  /** The search run this node belongs to — the root's own id. Every scoped
   *  query (selection, pruning, convergence) filters on it. */
  rootId: string;
  task: string;
  action: string;
  observation: string;
  codeUsed: string | null;
  depth: number;
}

/**
 * Record a new MCTS node in both search_nodes and session message tree.
 * Returns the session message ID.
 */
export async function recordNode(
  session: SessionWriter,
  sql: SqlExecutor,
  opts: RecordNodeOpts,
): Promise<string> {
  const msgId = nanoid();

  // CORRECT: SessionMessage.parts, not .content
  await session.appendMessage(
    {
      id: msgId,
      role: 'assistant',
      parts: [{
        type: 'text',
        text: `[Node ${opts.nodeId}] ${opts.action}\n\nObservation: ${opts.observation}`,
      }],
    },
    opts.parentMsgId,
  );

  sql`
    INSERT INTO search_nodes
      (id, parent_id, root_id, task, action, observation, code_used, depth, msg_id)
    VALUES
      (${opts.nodeId}, ${opts.parentNodeId ?? null}, ${opts.rootId},
       ${opts.task}, ${opts.action}, ${opts.observation},
       ${opts.codeUsed ?? null}, ${opts.depth}, ${msgId})
  `;

  return msgId;
}
