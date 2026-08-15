/**
 * The MCTS SessionWriter over the durable `messages` table (session_id='mcts').
 *
 * Source of truth is the TABLE, not an in-memory array: after a DO eviction or
 * a CLI process exit, a resumed search re-enters with a fresh session, and
 * getHistory(leafId) must still reconstruct a branch's ancestry from the
 * persisted rows so resumed branches keep their context (B6). The CLI
 * previously walked an in-memory mirror, which lost exactly that ancestry on
 * resume-after-restart — both backends now share this durable writer.
 */

import type { SessionWriter, SessionMessage } from '../mcts/record-node.js';
import type { SqlExecutor } from '../types/primitives.js';

export function createDurableMctsSession(sql: SqlExecutor): SessionWriter {
  return {
    async appendMessage(msg: SessionMessage, parentId?: string | null): Promise<void> {
      const content = msg.parts.map((p) => p.text).join('');
      void sql`INSERT INTO messages (id, session_id, parent_id, role, content)
        VALUES (${msg.id}, ${'mcts'}, ${parentId ?? null}, ${msg.role}, ${content})`;
    },
    getHistory(leafId?: string | null): Array<{ role: string; content: string }> {
      if (!leafId) {
        return sql<{ role: string; content: string }>`
          SELECT role, content FROM messages WHERE session_id='mcts' ORDER BY created_at ASC`
          .map((r) => ({ role: r.role, content: r.content }));
      }
      // Walk ancestry by parent_id from the durable table (cycle-guarded).
      type MsgRow = { parent_id: string | null; role: string; content: string };
      const result: Array<{ role: string; content: string }> = [];
      const seen = new Set<string>();
      let currentId: string | null = leafId;
      while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        const row: MsgRow | undefined = sql<MsgRow>`
          SELECT parent_id, role, content FROM messages WHERE id=${currentId} LIMIT 1`[0];
        if (!row) break;
        result.unshift({ role: row.role, content: row.content });
        currentId = row.parent_id;
      }
      return result;
    },
  };
}
