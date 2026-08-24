/**
 * Record a new MCTS node in both search_nodes SQL table and Session message tree.
 *
 * Architecture reference: docs/MCTS.md — "search_nodes Table"
 *
 * CRITICAL: SessionMessage uses `parts: SessionMessagePart[]`, NOT `content: string`.
 * The architecture doc's v1 used `content: "..."` which is a TYPE ERROR.
 */

import type { SqlExecutor } from '../types/primitives';
import type { EvaluationGrounding } from '../types/evaluation';
import { nanoid } from '../utils/nanoid';

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
/**
 * Fixed-size evaluator facts persisted with a branch node. This deliberately
 * excludes proposal text (`observation`) and execution error text (the bounded
 * session feedback). Nonconverged trees therefore remain diagnosable without
 * copying their trajectories.
 */
export interface NodeEvaluationDiagnostics {
  /** How the score was grounded: ran, judged prose-only, or unrunnable code. */
  grounding: EvaluationGrounding;
  /** This branch's own evaluation score in [0,1] — what backpropagation
   *  averaged into `value`. */
  score: number;
  /** Judge samples the ensemble ASKED for (after the per-evaluation budget
   *  clamped it). */
  judgeSamplesAttempted: number;
  /** Of those attempted, how many parsed. Attempted with zero used is an
   *  ensemble that answered nothing usable — distinct from never asked. */
  judgeSamplesUsed: number;
  /** Execution score components when the branch's code ran. The measured
   *  check fraction lives here as passed/total, not recomputed anywhere. */
  execution?: {
    passed: boolean;
    passedChecks?: number;
    totalChecks?: number;
    assertionsGenerated: boolean;
  };
  /** Present when the branch offered code this executor cannot run. */
  unrunnableLanguage?: string;
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
  /**
   * What the ENVIRONMENT said back about this node's proposal — the execution
   * verdict, absent when nothing was executed. Recorded on the session message
   * only: `search_nodes.observation` stays the branch's own proposal text,
   * which is what the alternate-takes ledger compares (mcts/takes.ts).
   *
   * This is the half of a LATS expansion the tree was missing. A child
   * expanded from this node reads its ancestry back through
   * `session.getHistory(msg_id)`, so without this line the child is told what
   * its parent PROPOSED and never that the proposal threw.
   */
  feedback?: string | null;
  codeUsed: string | null;
  codeLanguage?: string | null;
  depth: number;
  /** Bounded evaluation facts for this branch, or null/absent when the node
   *  was never evaluated (the root; a swarm node). */
  evaluation?: NodeEvaluationDiagnostics | null;
}

/**
 * The ONE `INSERT INTO search_nodes`, so a second tree writer cannot drift from
 * the first.
 *
 * `msgId` is null for a writer with no session message tree behind it — the
 * objective-scored swarm tree (`strategy/swarm-run.ts`), whose nodes are complete
 * answers held by the run rather than conversations reconstructed after an
 * eviction. NULL rather than a fabricated id: `msg_id` pointing at a message that
 * does not exist would make `session.getHistory` return an empty ancestry, and
 * every reader here already branches on the column being absent.
 */
export function insertSearchNode(
  sql: SqlExecutor,
  node: RecordNodeOpts & { readonly msgId: string | null },
): void {
  void sql`
 INSERT INTO search_nodes
      (id, parent_id, root_id, task, action, observation, code_used, code_language, depth, msg_id, evaluation_json)
    VALUES
      (${node.nodeId}, ${node.parentNodeId ?? null}, ${node.rootId},
       ${node.task}, ${node.action}, ${node.observation},
       ${node.codeUsed ?? null}, ${node.codeLanguage ?? null}, ${node.depth}, ${node.msgId},
       ${node.evaluation ? JSON.stringify(node.evaluation) : null})
  `;
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
      // Action and observation are the same string here (the column pair keeps
      // a 300-char summary beside the full text), so the message carries the
      // proposal once, then the environment's reply to it.
      parts: [{
        type: 'text',
        text: `[Node ${opts.nodeId}] ${opts.observation}`
          + (opts.feedback ? `\n\nObservation: ${opts.feedback}` : ''),
      }],
    },
    opts.parentMsgId,
  );

  insertSearchNode(sql, { ...opts, msgId });

  return msgId;
}
