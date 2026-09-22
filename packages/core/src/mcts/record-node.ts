/**
 * Record a new MCTS node in both the search_nodes table and the session message tree.
 * Reference: docs/MCTS.md "search_nodes Table". SessionMessage uses `parts`, not `content`.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { EvaluationGrounding } from '../types/evaluation';
import { nanoid } from '../utils/nanoid';

export interface SessionMessagePart {
  type: 'text';
  text: string;
}

export interface SessionMessage {
  id: string;
  role: 'assistant' | 'user';
  parts: SessionMessagePart[];
}

export interface SessionWriter {
  appendMessage(message: SessionMessage, parentId?: string | null): Promise<void>;
  getHistory(leafId: string): Promise<Array<{ role: string; content: string }>>;
}

/** Fixed-size evaluator facts persisted with a branch node; excludes proposal and error text. */
export interface NodeEvaluationDiagnostics {
  grounding: EvaluationGrounding;
  score: number;
  /** Judge samples requested, after the per-evaluation budget clamp. */
  judgeSamplesAttempted: number;
  /** Samples that parsed; zero used of some attempted differs from never asked. */
  judgeSamplesUsed: number;
  execution?: {
    passed: boolean;
    passedChecks?: number;
    totalChecks?: number;
    assertionsGenerated: boolean;
  };
  unrunnableLanguage?: string;
}

export interface RecordNodeOpts {
  nodeId: string;
  parentNodeId: string | null;
  parentMsgId: string | null;
  rootId: string;
  task: string;
  action: string;
  observation: string;
  /**
   * The environment's execution verdict on this node's proposal, recorded on the session message
   * only; `search_nodes.observation` stays the proposal text (mcts/takes.ts compares it).
   */
  feedback?: string | null;
  codeUsed: string | null;
  codeLanguage?: string | null;
  depth: number;
  /** Null/absent when the node was never evaluated (the root; a swarm node). */
  evaluation?: NodeEvaluationDiagnostics | null;
}

/**
 * The one `INSERT INTO search_nodes`. `msgId` is null for a writer with no session message tree
 * (`strategy/swarm-run.ts`); readers already branch on the column being absent.
 */
export function insertSearchNode(
  sql: SqlExecutor,
  actor: ActorHandle,
  node: RecordNodeOpts & { readonly msgId: string | null },
): void {
  actor.assertCurrent();
  void sql`
 INSERT INTO search_nodes
      (actor_id, id, parent_id, root_id, task, action, observation, code_used, code_language, depth, msg_id, evaluation_json)
    VALUES
      (${actor.actorId}, ${node.nodeId}, ${node.parentNodeId ?? null}, ${node.rootId},
       ${node.task}, ${node.action}, ${node.observation},
       ${node.codeUsed ?? null}, ${node.codeLanguage ?? null}, ${node.depth}, ${node.msgId},
       ${node.evaluation ? JSON.stringify(node.evaluation) : null})
  `;
}

export async function recordNode(
  session: SessionWriter,
  sql: SqlExecutor,
  actor: ActorHandle,
  opts: RecordNodeOpts,
): Promise<string> {
  const msgId = nanoid();

  await session.appendMessage(
    {
      id: msgId,
      role: 'assistant',
      // Action and observation are the same string here, so the message carries the proposal once.
      parts: [{
        type: 'text',
        text: `[Node ${opts.nodeId}] ${opts.observation}`
          + (opts.feedback ? `\n\nObservation: ${opts.feedback}` : ''),
      }],
    },
    opts.parentMsgId,
  );

  insertSearchNode(sql, actor, { ...opts, msgId });

  return msgId;
}
