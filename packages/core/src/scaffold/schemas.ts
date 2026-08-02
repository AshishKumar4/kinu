/**
 * Scaffold SQL schemas — the one DDL for scaffold versioning and task history,
 * plus the in-place migration that brings older workspaces up to it.
 *
 * The unified workspace initializer (identity/schema.ts) calls this rather than
 * carrying its own copy: a second definition drifted, and workspaces created
 * through it were missing `status` and `parent_version`.
 */

import type { RawSqlExec } from '../types/primitives.js';

export function initScaffoldTables(execRaw: RawSqlExec): void {
  // status: 'current' | 'pending' | 'rolled_back' | 'historical'
  // Drives shadow-mode rollout in scaffold/shadow.ts. Existing rows
  // (created before this column landed) default to 'current'.
  // parent_version: DGM-style lineage — the version this one branched from
  // (NULL for the v0 bootstrap and pre-lineage rows). Drives the variant
  // archive in scaffold/archive.ts.
  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_versions (
      version        INTEGER PRIMARY KEY,
      written_at     INTEGER NOT NULL,
      rationale      TEXT NOT NULL,
      canary_score   REAL,
      baseline_score REAL,
      status         TEXT NOT NULL DEFAULT 'current',
      parent_version INTEGER
    )
  `);
  // Existing databases: backfill columns via ALTER if missing. Try/catch
  // because ALTER fails if the column already exists.
  try {
    execRaw(`ALTER TABLE scaffold_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'current'`);
  } catch { /* column exists — fine */ }
  try {
    execRaw(`ALTER TABLE scaffold_versions ADD COLUMN parent_version INTEGER`);
  } catch { /* column exists — fine */ }

  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_regression_fixtures (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
      task              TEXT NOT NULL,
      expected_keywords TEXT NOT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Aligned with identity/schema.ts: scaffold_version has DEFAULT 0,
  // outcome has DEFAULT 'success'. Ensures CLI and CF backends produce
  // the same schema regardless of init order.
  execRaw(`
    CREATE TABLE IF NOT EXISTS task_history (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
      task             TEXT NOT NULL,
      scaffold_version INTEGER NOT NULL DEFAULT 0,
      outcome          TEXT NOT NULL DEFAULT 'success'
                       CHECK(outcome IN ('success','error','timeout')),
      score            REAL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}
