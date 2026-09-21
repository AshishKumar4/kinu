/**
 * The MCTS SessionWriter over the canonical transcript, in its own session.
 *
 * Source of truth is the transcript, not an in-memory array: after a DO
 * eviction or a CLI process exit, a resumed search re-enters with a fresh
 * session, and getHistory(leafId) must still reconstruct a branch's ancestry
 * from the persisted entries so resumed branches keep their context. Both
 * backends share this durable writer through the one session store.
 */

import type { SessionWriter, SessionMessage } from '../mcts/record-node';
import type { SessionHistory } from '../session/history';
import { MCTS_SESSION_ID } from '../session/transcript-schema';

export function createDurableMctsSession(history: SessionHistory, sessionId: string = MCTS_SESSION_ID): SessionWriter {
  const transcript = history.transcript(sessionId);

  return {
    async appendMessage(msg: SessionMessage, parentId?: string | null): Promise<void> {
      const content = msg.parts.map((p) => p.text).join('');
      await history.record(sessionId, { id: msg.id, parentId: parentId ?? null, message: { role: msg.role, content }, origin: msg.role === 'user' ? 'input' : 'output' });
    },
    async getHistory(leafId: string): Promise<Array<{ role: string; content: string }>> {
      const result: Array<{ role: string; content: string }> = [];

      for (const entry of transcript.ancestry(leafId)) {
        const projected = await transcript.project(entry.id);

        if (projected !== null) result.push({ role: projected.role, content: projected.content });
      }

      return result;
    },
  };
}
