/** MCTS SessionWriter over the durable transcript, so a resumed search can rebuild branch ancestry. */

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
