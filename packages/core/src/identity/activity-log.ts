/**
 * Reading the activity log.
 *
 * `activity_log` is the agent's own running commentary — one row per notable
 * thing the runtime did, written by `logActivity` on every backend. It is the
 * densest trace the agent keeps, and until now nothing read it back except the
 * five-row subordinate status chip.
 *
 * Deliberately not parsed: `detail` is free text written for a human, and
 * turning it into structured telemetry here would create a second, weaker
 * source for numbers the run-event log already carries properly. It is
 * surfaced as what it is — a log.
 */

import type { SqlExecutor } from '../types/primitives.js';

export interface ActivityLogEntry {
  readonly event: string;
  readonly detail: string | null;
  readonly elapsedMs: number;
  readonly createdAt: number;
}

/** The newest entries, oldest first. `limit` is a hard bound — the table is
 *  append-only and unbounded, so every reader states how much it wants. */
export function readActivityLog(sql: SqlExecutor, limit: number): ActivityLogEntry[] {
  const rows = sql<{ event: string; detail: string | null; elapsed_ms: number; created_at: number }>`
    SELECT event, detail, elapsed_ms, created_at
    FROM activity_log
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.max(0, Math.floor(limit))}`;
  return rows.map((row) => ({
    event: row.event,
    detail: row.detail,
    elapsedMs: row.elapsed_ms,
    createdAt: row.created_at,
  })).reverse();
}
