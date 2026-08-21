/**
 * The real engine ports over Kinu's shared storage primitives.
 *
 * Both backends expose the SAME two primitives — a workspace filesystem whose
 * filesystem is Nimbus (DO storage on cf, agent.db on cli) and a
 * SqlExecutor over that same database — so the transcript store and the
 * durable compaction state are built ONCE here and injected as ports.
 * Backends supply only what genuinely differs: the summarizer transport
 * (their model call), the logger sink, and the onOutcome ledger reset.
 *
 * Transcripts live at `.kinu/compaction/<sessionKey>/<rangeHash>.md`
 * — inside the agent's own file plane, so the reference message's citation is
 * directly readable back through the agent's normal file tools
 * (workspace.readFile / the shell). That read-back IS the lossless-recall
 * guarantee; the archive index kept alongside the plan snapshot is what makes
 * it navigable (manifest.ts).
 */

import { SPILL_DIRS, type SqlExecutor, type VFS } from '@kinu.run/core';
import type { PlanSnapshot, PlanStore, TranscriptStore } from '@better-compact/core';
import type { ArchiveIndexStore, ArchiveRange } from './manifest';
import * as v from 'valibot';

const COMPACTION_DIR = SPILL_DIRS.compaction;

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
  /** The archived-range index behind the checkpoint's navigation manifest. */
  archive: ArchiveIndexStore;
  /** Provider-reported prompt tokens of the session's last completed turn,
   *  or null when no turn has reported yet — or when `historyLength` is
   *  shorter than the length the measurement was taken against. */
  loadPromptTokens(sessionKey: string, historyLength: number): number | null;
  savePromptTokens(sessionKey: string, tokens: number, historyLength: number): void;
  /** Arm force-compaction: the session's NEXT turn assembly runs the context
   *  transform with trigger:'force' (overflow recovery). */
  armForceCompaction(sessionKey: string): void;
  /** Consume the force-compaction flag — true at most once per arm, so a
   *  forced rebuild can never loop. */
  takeForceCompaction(sessionKey: string): boolean;
}

interface ArchiveRangeRow {
  range_hash: string;
  path: string;
  start_turn: number;
  end_turn: number;
  user_turns: number;
  assistant_turns: number;
  first_user_ask: string;
}

function toArchiveRange(row: ArchiveRangeRow): ArchiveRange {
  return {
    rangeHash: row.range_hash,
    path: row.path,
    startTurn: row.start_turn,
    endTurn: row.end_turn,
    userTurns: row.user_turns,
    assistantTurns: row.assistant_turns,
    firstUserAsk: row.first_user_ask,
  };
}

const RawTailBoundarySchema = v.object({
  itemKey: v.string(),
  side: v.picklist(['before', 'after']),
});
const PlanStageSchema = v.object({
  name: v.string(),
  label: v.string(),
  beforeTokens: v.number(),
  afterTokens: v.number(),
  clearedTokens: v.number(),
  changedMessages: v.number(),
  changedParts: v.number(),
  status: v.string(),
});
const PlanSnapshotSchema: v.GenericSchema<PlanSnapshot> = v.object({
  sessionId: v.string(),
  rangeHash: v.string(),
  contextLimit: v.number(),
  rawTailStartMessageId: v.string(),
  rawTailItemBoundary: v.optional(RawTailBoundarySchema),
  transcriptRelativePath: v.string(),
  beforeTokens: v.number(),
  afterPruneTokens: v.number(),
  overheadTokens: v.optional(v.number()),
  triggerTokens: v.number(),
  targetTokens: v.number(),
  requiresCustomCompaction: v.boolean(),
  preservedToolCallIds: v.optional(v.array(v.string())),
  assistantSummaryKeys: v.optional(v.array(v.string())),
  assistantSummaries: v.optional(v.record(v.string(), v.string())),
  prefixSummary: v.optional(v.string()),
  stages: v.optional(v.array(PlanStageSchema)),
  createdAt: v.number(),
});

function parsePlanSnapshot(input: { value: unknown }): PlanSnapshot | null {
  const parsed = v.safeParse(PlanSnapshotSchema, input.value);
  return parsed.success ? parsed.output : null;
}

export function createCompactionStateStore(sql: SqlExecutor): CompactionStateStore {
  return {
    plans: {
      load: (sessionKey) => {
        const rows = sql<{ plan_json: string | null }>`
          SELECT plan_json FROM compaction_state WHERE session_key = ${sessionKey} LIMIT 1`;
        const json = rows[0]?.plan_json;
        if (!json) return null;
        const parsed: unknown = JSON.parse(json);
        return parsePlanSnapshot({ value: parsed });
      },
      save: (sessionKey, snapshot) => {
        const json = snapshot === null ? null : JSON.stringify(snapshot);
        void sql`INSERT INTO compaction_state (session_key, plan_json) VALUES (${sessionKey}, ${json})
            ON CONFLICT(session_key) DO UPDATE SET plan_json = excluded.plan_json`;
      },
    },
    archive: {
      list: (sessionKey) => sql<ArchiveRangeRow>`
        SELECT range_hash, path, start_turn, end_turn, user_turns, assistant_turns, first_user_ask
        FROM compaction_archive WHERE session_key = ${sessionKey} ORDER BY start_turn ASC`
        .map(toArchiveRange),
      append: (sessionKey, range) => {
        void sql`INSERT INTO compaction_archive
              (session_key, range_hash, path, start_turn, end_turn,
               user_turns, assistant_turns, first_user_ask)
            VALUES (${sessionKey}, ${range.rangeHash}, ${range.path}, ${range.startTurn},
                    ${range.endTurn}, ${range.userTurns}, ${range.assistantTurns},
                    ${range.firstUserAsk})
            ON CONFLICT(session_key, range_hash) DO NOTHING`;
      },
      clear: (sessionKey) => {
        void sql`DELETE FROM compaction_archive WHERE session_key = ${sessionKey}`;
      },
    },
    loadPromptTokens(sessionKey, historyLength) {
      const rows = sql<{ last_prompt_tokens: number | null; measured_at_length: number | null }>`
        SELECT last_prompt_tokens, measured_at_length FROM compaction_state
        WHERE session_key = ${sessionKey} LIMIT 1`;
      const row = rows[0];
      const tokens = row?.last_prompt_tokens;
      if (tokens == null || tokens <= 0) return null;
      const measuredAt = row?.measured_at_length;
      if (measuredAt != null && historyLength < measuredAt) return null;
      return tokens;
    },
    savePromptTokens(sessionKey, tokens, historyLength) {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const value = Math.floor(tokens);
      const length = Number.isFinite(historyLength) && historyLength > 0 ? Math.floor(historyLength) : 0;
      void sql`INSERT INTO compaction_state (session_key, last_prompt_tokens, measured_at_length)
          VALUES (${sessionKey}, ${value}, ${length})
          ON CONFLICT(session_key) DO UPDATE SET
            last_prompt_tokens = excluded.last_prompt_tokens,
            measured_at_length = excluded.measured_at_length`;
    },
    armForceCompaction(sessionKey) {
      void sql`INSERT INTO compaction_state (session_key, force_compaction) VALUES (${sessionKey}, 1)
          ON CONFLICT(session_key) DO UPDATE SET force_compaction = 1`;
    },
    takeForceCompaction(sessionKey) {
      const rows = sql<{ force_compaction: number | null }>`
        SELECT force_compaction FROM compaction_state WHERE session_key = ${sessionKey} LIMIT 1`;
      if (rows[0]?.force_compaction !== 1) return false;
      void sql`UPDATE compaction_state SET force_compaction = NULL WHERE session_key = ${sessionKey}`;
      return true;
    },
  };
}
