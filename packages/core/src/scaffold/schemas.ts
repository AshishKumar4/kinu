/**
 * Scaffold SQL schemas — the one DDL for scaffold versioning and task history,
 * plus the in-place migration that brings older workspaces up to it.
 *
 * The unified workspace initializer (identity/schema.ts) calls this rather than
 * carrying its own copy: a second definition drifted, and workspaces created
 * through it were missing `status` and `parent_version`.
 */

import { reconcileColumns } from '../identity/columns.js';
import type { RawSqlExec } from '../types/primitives.js';

export function initScaffoldTables(execRaw: RawSqlExec): void {
  // status: 'current' | 'pending' | 'rolled_back' | 'historical'
  // Drives shadow-mode rollout in scaffold/shadow.ts. Existing rows
  // (created before this column landed) default to 'current'.
  // parent_version: DGM-style lineage — the version this one branched from
  // (NULL for the v0 bootstrap and pre-lineage rows). Drives the variant
  // archive in scaffold/archive.ts.
  // pathology: the failure cell this version was written to fix
  // (evolution/pathology.ts, `<complaint>/<shape>`; NULL when the proposal
  // named none). Gives the archive a second axis to be read and branched on.
  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_versions (
      version        INTEGER PRIMARY KEY,
      written_at     INTEGER NOT NULL,
      rationale      TEXT NOT NULL,
      canary_score   REAL,
      baseline_score REAL,
      status         TEXT NOT NULL DEFAULT 'current',
      parent_version INTEGER,
      pathology      TEXT
    )
  `);
  // Columns added after this table's first release; see identity/columns.ts.
  reconcileColumns(execRaw, 'scaffold_versions', [
    `status TEXT NOT NULL DEFAULT 'current'`,
    'parent_version INTEGER',
    'pathology TEXT',
  ]);

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
