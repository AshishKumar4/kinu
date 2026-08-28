/**
 * Effect tombstones — the durable record that a keyed piece of work ALREADY
 * HAPPENED, kept after the row that did it has been retired.
 *
 * A keyed insert with `ON CONFLICT(id) DO NOTHING` is idempotent only while its
 * row still exists, and every consumer here retires its rows on its own
 * schedule: `sweepSettled` drops a completed turn as soon as both of its
 * lifetimes are over, `dropQueuedShadowTrial` deletes the queue row the moment
 * the trial is scored, and a review's claim is a lease that activation recovery
 * re-queues. So a replayed durable effect — a terminal row still pending
 * because its owning isolate died between the work and the disposition — finds
 * no conflict, and does the work a second time. Every one of those writes is
 * append-only or cumulative (a second `turn_outcomes` verdict, a second craft
 * EMA move, a second scored trial in the promotion evidence, a second alternate
 * take set), so the duplicate is observable. The tombstone is the one thing that
 * survives the retirement: two small columns, no payload, never swept, keyed by
 * the identity the replay carries. It answers exactly one question — has this
 * scope+key been done — which is the question the retired row can no longer
 * answer.
 *
 * NOT a claim (tools/effect-claim.ts is that: written BEFORE the effect, holds
 * the result, released per turn). A tombstone is written AFTER, holds nothing,
 * and is forever.
 */

import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { nowMs } from '../utils/date';

export function initEffectTombstoneTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS effect_tombstones (
    scope       TEXT NOT NULL,
    key         TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
  )`);
}

/** True when this scope+key has been recorded. */
export function effectAlreadyDone(sql: SqlExecutor, scope: string, key: string): boolean {
  return sql<{ n: number }>`
    SELECT 1 AS n FROM effect_tombstones WHERE scope = ${scope} AND key = ${key} LIMIT 1`.length > 0;
}

/** Idempotent. Records that it happened. A second call keeps the FIRST
 *  timestamp: that is when the work actually ran. */
export function recordEffectDone(sql: SqlExecutor, scope: string, key: string, now?: number): void {
  void sql`INSERT INTO effect_tombstones (scope, key, recorded_at)
      VALUES (${scope}, ${key}, ${now ?? nowMs()})
      ON CONFLICT(scope, key) DO NOTHING`;
}
