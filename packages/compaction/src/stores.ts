/**
 * Engine ports over Kinu's shared storage primitives. Transcripts live at
 * `.kinu/compaction/<sessionKey>/<rangeHash>.md` in the agent's own file plane, readable by its file tools.
 */


import { SPILL_DIRS, type ActorHandle, type SqlExecutor, type VFS } from '@kinu.run/core';
import type { PlanSnapshot, PlanStore, TranscriptStore } from '@better-compact/core';
import type { ArchiveIndexStore, ArchiveRange } from './manifest';
import * as v from 'valibot';

const COMPACTION_DIR = SPILL_DIRS.compaction;

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Pure: the reference message embeds this path verbatim. */
export function compactionTranscriptPath(sessionKey: string, rangeHash: string): string {
  return `${COMPACTION_DIR}/${safeSegment(sessionKey)}/${safeSegment(rangeHash)}.md`;
}

/** `citablePath` is a property: the engine passes it around unbound. */
export interface VfsTranscriptStore extends TranscriptStore {
  citablePath: (sessionKey: string, rangeHash: string) => string;
}

/** `getVfs` is a thunk: the cf runtime is built lazily, so the VFS is dereferenced per write. */
export function createVfsTranscriptStore(getVfs: () => VFS): VfsTranscriptStore {
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
 * Durable per-session plan snapshot and last prompt-token measurement. A measurement taken against a
 * longer history than the current one reads as absent: history is append-only, so shorter means rewritten.
 */
export interface CompactionStateStore {
  plans: PlanStore;
  archive: ArchiveIndexStore;
  /** Null when none reported or `historyLength` is shorter than at measurement. */
  loadPromptTokens(sessionKey: string, historyLength: number): number | null;
  savePromptTokens(sessionKey: string, tokens: number, historyLength: number): void;
  /** The next turn assembly runs the transform with trigger:'force'. */
  armForceCompaction(sessionKey: string): void;
  /** True at most once per arm, so a forced rebuild cannot loop. */
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

/**
 * Bind compaction state to one actor: actors of one workspace share session keys, so sharing state would
 * compact against another actor's measurement. `assertCurrent()` runs before every statement.
 */
export function createCompactionStateStore(
  sql: SqlExecutor, actor: ActorHandle,
): CompactionStateStore {
  const actorId = actor.actorId;
  const authorize = actor.assertCurrent;

  return {
    plans: {
      load: (sessionKey) => {
        authorize();

        const rows = sql<{ plan_json: string | null }>`
          SELECT plan_json FROM compaction_state
          WHERE actor_id = ${actorId} AND session_key = ${sessionKey} LIMIT 1`;

        const json = rows[0]?.plan_json;

        if (!json) return null;
        const parsed: unknown = JSON.parse(json);

        return parsePlanSnapshot({ value: parsed });
      },
      save: (sessionKey, snapshot) => {
        authorize();
        const json = snapshot === null ? null : JSON.stringify(snapshot);
        void sql`INSERT INTO compaction_state (actor_id, session_key, plan_json)
            VALUES (${actorId}, ${sessionKey}, ${json})
            ON CONFLICT(actor_id, session_key) DO UPDATE SET plan_json = excluded.plan_json`;
      },
    },
    archive: {
      list: (sessionKey) => {
        authorize();

        return sql<ArchiveRangeRow>`
          SELECT range_hash, path, start_turn, end_turn, user_turns, assistant_turns, first_user_ask
          FROM compaction_archive
          WHERE actor_id = ${actorId} AND session_key = ${sessionKey} ORDER BY start_turn ASC`
          .map(toArchiveRange);
      },
      append: (sessionKey, range) => {
        authorize();
        void sql`INSERT INTO compaction_archive
              (actor_id, session_key, range_hash, path, start_turn, end_turn,
               user_turns, assistant_turns, first_user_ask)
            VALUES (${actorId}, ${sessionKey}, ${range.rangeHash}, ${range.path}, ${range.startTurn},
                    ${range.endTurn}, ${range.userTurns}, ${range.assistantTurns},
                    ${range.firstUserAsk})
            ON CONFLICT(actor_id, session_key, range_hash) DO NOTHING`;
      },
      clear: (sessionKey) => {
        authorize();
        void sql`DELETE FROM compaction_archive
          WHERE actor_id = ${actorId} AND session_key = ${sessionKey}`;
      },
    },
    loadPromptTokens(sessionKey, historyLength) {
      authorize();

      const rows = sql<{ last_prompt_tokens: number | null; measured_at_length: number | null }>`
        SELECT last_prompt_tokens, measured_at_length FROM compaction_state
        WHERE actor_id = ${actorId} AND session_key = ${sessionKey} LIMIT 1`;

      const row = rows[0];
      const tokens = row?.last_prompt_tokens;

      if (tokens == null || tokens <= 0) return null;
      const measuredAt = row?.measured_at_length;

      if (measuredAt != null && historyLength < measuredAt) return null;

      return tokens;
    },
    savePromptTokens(sessionKey, tokens, historyLength) {
      authorize();

      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const value = Math.floor(tokens);
      const length = Number.isFinite(historyLength) && historyLength > 0 ? Math.floor(historyLength) : 0;
      void sql`INSERT INTO compaction_state
            (actor_id, session_key, last_prompt_tokens, measured_at_length)
          VALUES (${actorId}, ${sessionKey}, ${value}, ${length})
          ON CONFLICT(actor_id, session_key) DO UPDATE SET
            last_prompt_tokens = excluded.last_prompt_tokens,
            measured_at_length = excluded.measured_at_length`;
    },
    armForceCompaction(sessionKey) {
      authorize();
      void sql`INSERT INTO compaction_state (actor_id, session_key, force_compaction)
          VALUES (${actorId}, ${sessionKey}, 1)
          ON CONFLICT(actor_id, session_key) DO UPDATE SET force_compaction = 1`;
    },
    takeForceCompaction(sessionKey) {
      authorize();

      const rows = sql<{ force_compaction: number | null }>`
        SELECT force_compaction FROM compaction_state
        WHERE actor_id = ${actorId} AND session_key = ${sessionKey} LIMIT 1`;

      if (rows[0]?.force_compaction !== 1) return false;
      void sql`UPDATE compaction_state SET force_compaction = NULL
        WHERE actor_id = ${actorId} AND session_key = ${sessionKey}`;

      return true;
    },
  };
}
