/** Reads the activity log; `detail` is free text for humans and deliberately not parsed. */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import { diagnostics, toKinuError } from '../obs/index';

export interface ActivityLogEntry {
  readonly event: string;
  readonly detail: string | null;
  readonly elapsedMs: number;
  readonly createdAt: number;
}

/** A tracing failure is reported without failing the work already performed. */
export function writeActivityLog(
  source: () => { sql: SqlExecutor; actor: ActorHandle }, entry: ActivityLogEntry,
): void {
  try {
    const { sql, actor } = source();
    actor.assertCurrent();
    void sql`INSERT INTO activity_log (actor_id, event, detail, elapsed_ms, created_at)
      VALUES (${actor.actorId}, ${entry.event}, ${entry.detail}, ${entry.elapsedMs}, ${entry.createdAt})`;
  } catch (cause) {
    diagnostics.failure('activity_log.write_failed', toKinuError({
      doing: 'recording an activity-log row', cause, otherwise: 'io',
    }), { source: entry.event });
  }
}

/** The newest entries, oldest first. The table is unbounded, so `limit` is required. */
export function readActivityLog(
  sql: SqlExecutor, actor: ActorHandle, limit: number,
): ActivityLogEntry[] {
  actor.assertCurrent();

  const rows = sql<{ event: string; detail: string | null; elapsed_ms: number; created_at: number }>`
    SELECT event, detail, elapsed_ms, created_at
    FROM activity_log
    WHERE actor_id = ${actor.actorId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.max(0, Math.floor(limit))}`;

  return rows.map((row) => ({
    event: row.event,
    detail: row.detail,
    elapsedMs: row.elapsed_ms,
    createdAt: row.created_at,
  })).reverse();
}
