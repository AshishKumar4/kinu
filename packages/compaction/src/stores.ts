/**
 * The real engine ports over Proteus's shared storage primitives.
 *
 * Both backends expose the SAME two primitives — a CompositeVFS whose /local
 * mount is the durable SqliteFS (DO storage on cf, agent.db on cli) and a
 * SqlExecutor over that same database — so the transcript store and the
 * durable compaction state are built ONCE here and injected as ports.
 * Backends supply only what genuinely differs: the summarizer transport
 * (their model call), the logger sink, and the onOutcome ledger reset.
 *
 * Transcripts live at `/local/.proteus/compaction/<sessionKey>/<rangeHash>.md`
 * — inside the agent's own file plane, so the reference message's citation is
 * directly readable back through the agent's normal file tools
 * (workspace.readFile / the shell). That read-back IS the lossless-recall
 * guarantee.
 */

import type { RawSqlExec, SqlExecutor, VFS } from '@proteus/core';
import type { PlanSnapshot, PlanStore, TranscriptStore } from './engine/index.js';

const COMPACTION_DIR = '/local/.proteus/compaction';

/** Path components come from session keys (agent names, `affinity:sessionId`
 *  pairs) and hex range hashes — collapse anything path-hostile. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The citable transcript path for one compacted range. Pure — the engine
 *  passes it around unbound, and the reference message embeds it verbatim. */
export function compactionTranscriptPath(sessionKey: string, rangeHash: string): string {
  return `${COMPACTION_DIR}/${safeSegment(sessionKey)}/${safeSegment(rangeHash)}.md`;
}

/** Transcript store over the workspace VFS. `getVfs` is a thunk because the
 *  cf runtime is built lazily — the VFS is dereferenced per write, never at
 *  registration time. */
export function createVfsTranscriptStore(getVfs: () => VFS): TranscriptStore {
  return {
    citablePath: compactionTranscriptPath,
    write: async (relativePath, content) => {
      const vfs = getVfs();
      const dir = relativePath.slice(0, relativePath.lastIndexOf('/'));
      try {
        await vfs.mkdir(dir, { recursive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        if (!msg.includes('exist')) throw err;
      }
      await vfs.writeFile(relativePath, content);
      return { absolutePath: relativePath };
    },
  };
}

export function initCompactionStateTable(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS compaction_state (
      session_key        TEXT PRIMARY KEY,
      plan_json          TEXT,
      last_prompt_tokens INTEGER,
      measured_at_length INTEGER
    )
  `);
}

/**
 * Durable per-session compaction state: the replayable plan snapshot AND the
 * provider-reported prompt-token signal of the last completed turn — the
 * measured trigger the next turn's transform runs on. One row per session;
 * clearing a stale plan keeps the token signal and vice versa.
 *
 * The token signal is only meaningful for the history it measured, so it is
 * bound to the durable-history length at measurement time: history is
 * append-only, so a SHORTER history at read time means a rewrite (undo,
 * restore truncation) happened and the measurement describes a request this
 * history can no longer produce — it reads as absent rather than poisoning
 * the trigger with a huge phantom overhead.
 */
export interface CompactionStateStore {
  plans: PlanStore;
  /** Provider-reported prompt tokens of the session's last completed turn,
   *  or null when no turn has reported yet — or when `historyLength` is
   *  shorter than the length the measurement was taken against. */
  loadPromptTokens(sessionKey: string, historyLength: number): number | null;
  savePromptTokens(sessionKey: string, tokens: number, historyLength: number): void;
}

export function createCompactionStateStore(sql: SqlExecutor): CompactionStateStore {
  return {
    plans: {
      load: (sessionKey) => {
        const rows = sql<{ plan_json: string | null }>`
          SELECT plan_json FROM compaction_state WHERE session_key = ${sessionKey} LIMIT 1`;
        const json = rows[0]?.plan_json;
        if (!json) return null;
        try {
          return JSON.parse(json) as PlanSnapshot;
        } catch {
          return null;
        }
      },
      save: (sessionKey, snapshot) => {
        const json = snapshot === null ? null : JSON.stringify(snapshot);
        sql`INSERT INTO compaction_state (session_key, plan_json) VALUES (${sessionKey}, ${json})
            ON CONFLICT(session_key) DO UPDATE SET plan_json = excluded.plan_json`;
      },
    },
    loadPromptTokens(sessionKey, historyLength) {
      const rows = sql<{ last_prompt_tokens: number | null; measured_at_length: number | null }>`
        SELECT last_prompt_tokens, measured_at_length FROM compaction_state
        WHERE session_key = ${sessionKey} LIMIT 1`;
      const row = rows[0];
      const tokens = row?.last_prompt_tokens;
      if (typeof tokens !== 'number' || tokens <= 0) return null;
      const measuredAt = row?.measured_at_length;
      if (typeof measuredAt === 'number' && historyLength < measuredAt) return null;
      return tokens;
    },
    savePromptTokens(sessionKey, tokens, historyLength) {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const value = Math.floor(tokens);
      const length = Number.isFinite(historyLength) && historyLength > 0 ? Math.floor(historyLength) : 0;
      sql`INSERT INTO compaction_state (session_key, last_prompt_tokens, measured_at_length)
          VALUES (${sessionKey}, ${value}, ${length})
          ON CONFLICT(session_key) DO UPDATE SET
            last_prompt_tokens = excluded.last_prompt_tokens,
            measured_at_length = excluded.measured_at_length`;
    },
  };
}
