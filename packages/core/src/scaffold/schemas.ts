import type { RawSqlExec } from '../types/primitives';

export function initScaffoldTables(execRaw: RawSqlExec): void {
  // status: 'current' | 'pending' | 'rolled_back' | 'historical'.
  // pathology: the `<complaint>/<shape>` cell this version targets, or NULL.
  // actor_id is in the key: `status = 'current'` is a per-actor pointer.
  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_versions (
      actor_id       TEXT NOT NULL,
      version        INTEGER NOT NULL,
      written_at     INTEGER NOT NULL,
      rationale      TEXT NOT NULL,
      canary_score   REAL,
      baseline_score REAL,
      status         TEXT NOT NULL DEFAULT 'current',
      parent_version INTEGER,
      pathology      TEXT,
      PRIMARY KEY (actor_id, version)
    )
  `);

  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_regression_fixtures (
      actor_id          TEXT NOT NULL,
      id                TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
      task              TEXT NOT NULL,
      expected_keywords TEXT NOT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (actor_id, id)
    )
  `);

  // Defaults match identity/schema.ts so CLI and CF backends agree regardless of init order.
  execRaw(`
    CREATE TABLE IF NOT EXISTS task_history (
      actor_id         TEXT NOT NULL,
      id               TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
      task             TEXT NOT NULL,
      scaffold_version INTEGER NOT NULL DEFAULT 0,
      outcome          TEXT NOT NULL DEFAULT 'success'
                       CHECK(outcome IN ('success','error','timeout')),
      score            REAL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (actor_id, id)
    )
  `);
}
