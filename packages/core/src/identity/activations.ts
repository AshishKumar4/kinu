/**
 * How often a workspace object started: one row per `onStart`, each with the ordinal that numbers it. The ordinal is
 * the one count of activations. Every `actor.startup` log line and analytics row carries it, and every reader counts
 * activations as ordinal deltas, never as rows: telemetry dropped startup rows (staging 2026-10-08: 17 of 257 objects
 * served by one version logged none, and analytics missed 4 of one workspace's 6), and a lost row hides nothing a
 * later ordinal does not count.
 */

import type { RawSqlExec, SqlExecutor } from '../types/primitives';

/** The rows kept: the newest activation overwrites the slot its ordinal names, so the table never grows past this. */
const ACTIVATION_SLOTS = 256;

export interface Activation {
  readonly ordinal: number;
  readonly startedAt: number;
  /** The script version that started, when the runtime names one. */
  readonly version: string | null;
}

export function initActivationTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS workspace_activations (
    slot       INTEGER PRIMARY KEY,
    ordinal    INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    version    TEXT
  )`);
}

/** Numbers this activation and keeps it, in one statement over at most {@link ACTIVATION_SLOTS} rows. */
export function recordActivation(sql: SqlExecutor, startedAt: number, version: string | null): number {
  const [row] = sql<{ ordinal: number }>`INSERT OR REPLACE INTO workspace_activations (slot, ordinal, started_at, version)
    SELECT next % ${ACTIVATION_SLOTS}, next, ${startedAt}, ${version}
    FROM (SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM workspace_activations)
    RETURNING ordinal`;

  return row?.ordinal ?? 0;
}

/** The kept activations, oldest first. */
export function listActivations(sql: SqlExecutor): Activation[] {
  return sql<{ ordinal: number; started_at: number; version: string | null }>`
    SELECT ordinal, started_at, version FROM workspace_activations ORDER BY ordinal`
    .map((row) => ({ ordinal: row.ordinal, startedAt: row.started_at, version: row.version }));
}
