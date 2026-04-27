/**
 * Scaffold SQL schemas — DDL for scaffold versioning and task history.
 *
 * NOTE: Must stay in sync with packages/core/src/identity/schema.ts
 * (the unified schema). Both are safe because of IF NOT EXISTS. The
 * duplicate exists so scaffold bootstrap can self-initialize without
 * requiring the full unified init.
 */

import type { RawSqlExec } from '../types/primitives.js';

export function initScaffoldTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_versions (
      version        INTEGER PRIMARY KEY,
      written_at     INTEGER NOT NULL,
      rationale      TEXT NOT NULL,
      canary_score   REAL,
      baseline_score REAL
    )
  `);

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
