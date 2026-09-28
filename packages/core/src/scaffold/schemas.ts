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
      status         TEXT NOT NULL DEFAULT 'current',
      parent_version INTEGER,
      pathology      TEXT,
      PRIMARY KEY (actor_id, version)
    )
  `);
}
