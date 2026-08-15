/**
 * The real engine ports over Proteus's shared storage primitives.
 *
 * Both backends expose the SAME two primitives — a workspace filesystem whose
 * filesystem is Nimbus (DO storage on cf, agent.db on cli) and a
 * SqlExecutor over that same database — so the transcript store and the
 * durable compaction state are built ONCE here and injected as ports.
 * Backends supply only what genuinely differs: the summarizer transport
 * (their model call), the logger sink, and the onOutcome ledger reset.
 *
 * Transcripts live at `.proteus/compaction/<sessionKey>/<rangeHash>.md`
 * — inside the agent's own file plane, so the reference message's citation is
 * directly readable back through the agent's normal file tools
 * (workspace.readFile / the shell). That read-back IS the lossless-recall
 * guarantee; the archive index kept alongside the plan snapshot is what makes
 * it navigable (manifest.ts).
 */

import { SPILL_DIRS, type SqlExecutor, type VFS } from '@proteus/core';
import type { PlanSnapshot, PlanStore, TranscriptStore } from '@better-compact/core';
import type { ArchiveIndexStore, ArchiveRange } from './manifest.js';

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

type PlanStage = NonNullable<PlanSnapshot['stages']>[number];
type RawTailBoundary = NonNullable<PlanSnapshot['rawTailItemBoundary']>;

function isString<Value>(value: Value): value is Value & string {
  return typeof value === 'string';
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === 'number';
}

function isBoolean<Value>(value: Value): value is Value & boolean {
  return typeof value === 'boolean';
}

function isStringArray<Value>(value: Value): value is Value & string[] {
  return Array.isArray(value) && value.every(isString);
}

function isStringDictionary<Value>(value: Value): value is Value & Record<string, string> {
  return value !== null
    && !Array.isArray(value)
    && typeof value === 'object'
    && Object.values(value).every(isString);
}

function isRawTailBoundary<Value>(value: Value): value is Value & RawTailBoundary {
  return value !== null
    && typeof value === 'object'
    && 'itemKey' in value
    && isString(value.itemKey)
    && 'side' in value
    && (value.side === 'before' || value.side === 'after');
}

function isPlanStage<Value>(value: Value): value is Value & PlanStage {
  return value !== null
    && typeof value === 'object'
    && 'name' in value && isString(value.name)
    && 'label' in value && isString(value.label)
    && 'beforeTokens' in value && isNumber(value.beforeTokens)
    && 'afterTokens' in value && isNumber(value.afterTokens)
    && 'clearedTokens' in value && isNumber(value.clearedTokens)
    && 'changedMessages' in value && isNumber(value.changedMessages)
    && 'changedParts' in value && isNumber(value.changedParts)
    && 'status' in value && isString(value.status);
}

function isPlanSnapshot<Value>(value: Value): value is Value & PlanSnapshot {
  if (value === null || typeof value !== 'object') return false;
  if (!('sessionId' in value) || !isString(value.sessionId)) return false;
  if (!('rangeHash' in value) || !isString(value.rangeHash)) return false;
  if (!('contextLimit' in value) || !isNumber(value.contextLimit)) return false;
  if (!('rawTailStartMessageId' in value) || !isString(value.rawTailStartMessageId)) return false;
  if (!('transcriptRelativePath' in value) || !isString(value.transcriptRelativePath)) return false;
  if (!('beforeTokens' in value) || !isNumber(value.beforeTokens)) return false;
  if (!('afterPruneTokens' in value) || !isNumber(value.afterPruneTokens)) return false;
  if (!('triggerTokens' in value) || !isNumber(value.triggerTokens)) return false;
  if (!('targetTokens' in value) || !isNumber(value.targetTokens)) return false;
  if (!('requiresCustomCompaction' in value) || !isBoolean(value.requiresCustomCompaction)) return false;
  if (!('createdAt' in value) || !isNumber(value.createdAt)) return false;
  if ('rawTailItemBoundary' in value && value.rawTailItemBoundary !== undefined
      && !isRawTailBoundary(value.rawTailItemBoundary)) return false;
  if ('overheadTokens' in value && value.overheadTokens !== undefined
      && !isNumber(value.overheadTokens)) return false;
  if ('preservedToolCallIds' in value && value.preservedToolCallIds !== undefined
      && !isStringArray(value.preservedToolCallIds)) return false;
  if ('assistantSummaryKeys' in value && value.assistantSummaryKeys !== undefined
      && !isStringArray(value.assistantSummaryKeys)) return false;
  if ('assistantSummaries' in value && value.assistantSummaries !== undefined
      && !isStringDictionary(value.assistantSummaries)) return false;
  if ('prefixSummary' in value && value.prefixSummary !== undefined
      && !isString(value.prefixSummary)) return false;
  if ('stages' in value && value.stages !== undefined
      && (!Array.isArray(value.stages) || !value.stages.every(isPlanStage))) return false;
  return true;
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
          const parsed: unknown = JSON.parse(json);
          return isPlanSnapshot(parsed) ? parsed : null;
        } catch {
          return null;
        }
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
      if (!isNumber(tokens) || tokens <= 0) return null;
      const measuredAt = row?.measured_at_length;
      if (isNumber(measuredAt) && historyLength < measuredAt) return null;
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
