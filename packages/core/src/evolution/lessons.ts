/**
 * The lesson ledger (`lessons`): what turn and session reflections, execution recoveries and imports taught. A
 * self-scored lesson stays provisional until the user's own negative on one of its turns corroborates it.
 */

import * as v from 'valibot';
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { sqlCheckList } from '../identity/schema';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { parseJsonValue } from '../utils/json';

/** Lesson sources in canonical order; the table's CHECK constraint derives from
 *  this list. `execution_recovery` is bound to no turn, so it is never corroborated;
 *  `import` is born corroborated. Corroboration lives only in the row's status. */
const LESSON_SOURCES = [
  'turn_reflection', 'session_reflection', 'execution_recovery', 'import',
] as const;

export type LessonSource = (typeof LESSON_SOURCES)[number];

export type LessonStatus = 'provisional' | 'corroborated';

const LESSONS_DDL = `(
    actor_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN (${sqlCheckList(LESSON_SOURCES)})),
    status TEXT NOT NULL CHECK (status IN ('provisional','corroborated')),
    created_at INTEGER NOT NULL,
    corroborated_at INTEGER,
    PRIMARY KEY (actor_id, id)
  )`;

export function initLessonTables(execRaw: RawSqlExec): void {
  // Self-scored lessons stay 'provisional' and out of the derived view until the user's own negative on one of
  // their turns corroborates them.
  execRaw(`CREATE TABLE IF NOT EXISTS lessons ${LESSONS_DDL}`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_lessons_actor
             ON lessons(actor_id, created_at DESC)`);
  // The generated pattern, held so a replay applies what was decided rather than
  // re-asking a model. Retired once its tombstone lands.
  execRaw(`CREATE TABLE IF NOT EXISTS pattern_extractions (
    actor_id   TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    answer     TEXT NOT NULL,
    PRIMARY KEY (actor_id, effect_key)
  )`);
}

export interface LessonRow {
  id: string;
  turnIds: string[];
  text: string;
  source: LessonSource;
  status: LessonStatus;
  createdAt: number;
  corroboratedAt: number | null;
}

export function recordLesson(sql: SqlExecutor, actor: ActorHandle, input: {
  turnIds: ReadonlyArray<string>;
  text: string;
  source: LessonSource;
  status: LessonStatus;
  now?: number;
  /**
     * Stable identity of the producing work, so a retry rewrites the same row
     * instead of appending a duplicate.
     */
  key?: string;
}): string {
  actor.assertCurrent();
  const id = input.key === undefined ? `lsn-${nanoid()}` : `lsn-${input.key}`;
  const now = input.now ?? nowMs();
  void sql`INSERT INTO lessons (actor_id, id, turn_ids, text, source, status, created_at, corroborated_at)
      VALUES (${actor.actorId}, ${id}, ${JSON.stringify(input.turnIds)}, ${input.text}, ${input.source},
              ${input.status}, ${now}, ${input.status === 'corroborated' ? now : null})
      ON CONFLICT(actor_id, id) DO NOTHING`;

  return id;
}

interface RawLessonRow {
  id: string; turn_ids: string; text: string; source: LessonSource;
  status: LessonStatus; created_at: number; corroborated_at: number | null;
}

function toLessonRow(r: RawLessonRow): LessonRow {
  // A row that does not parse is corruption, not a lesson tied to no turn.
  const turnIds = v.parse(v.array(v.string()), parseJsonValue(r.turn_ids));

  return {
    id: r.id, turnIds, text: r.text, source: r.source, status: r.status,
    createdAt: r.created_at, corroboratedAt: r.corroborated_at,
  };
}

export function listLessons(
  sql: SqlExecutor,
  actor: ActorHandle,
  opts: { status?: LessonStatus; source?: LessonSource; limit?: number } = {},
): LessonRow[] {
  actor.assertCurrent();
  const status = opts.status ?? null;
  const source = opts.source ?? null;

  const rows = sql<RawLessonRow>`SELECT * FROM lessons
    WHERE actor_id = ${actor.actorId}
      AND (${status} IS NULL OR status = ${status})
      AND (${source} IS NULL OR source = ${source})
    ORDER BY created_at DESC LIMIT ${opts.limit ?? 100}`;

  return rows.map(toLessonRow);
}

export function getLesson(sql: SqlExecutor, actor: ActorHandle, id: string): LessonRow | null {
  actor.assertCurrent();

  const rows = sql<RawLessonRow>`SELECT * FROM lessons
    WHERE actor_id = ${actor.actorId} AND id = ${id} LIMIT 1`;

  return rows[0] ? toLessonRow(rows[0]) : null;
}

/** The newest corroborated lessons as one prose block for a turn's dynamic context. */
export function renderRecentLessons(sql: SqlExecutor, actor: ActorHandle, limit = 5): string {
  return listLessons(sql, actor, { status: 'corroborated', limit })
    .map((lesson) => lesson.text)
    .join('\n');
}

/** Flip every provisional lesson tied to `turnId` to corroborated. */
export function corroborateLessonsForTurn(
  sql: SqlExecutor, actor: ActorHandle, turnId: string, now = nowMs(),
): LessonRow[] {
  const provisional = listLessons(sql, actor, { status: 'provisional', limit: 200 });
  const matched = provisional.filter((l) => l.turnIds.includes(turnId));

  for (const lesson of matched) {
    void sql`UPDATE lessons SET status = 'corroborated', corroborated_at = ${now}
      WHERE actor_id = ${actor.actorId} AND id = ${lesson.id}`;
  }

  return matched.map((l) => ({ ...l, status: 'corroborated' as const, corroboratedAt: now }));
}
