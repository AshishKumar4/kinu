// Another workspace's experience staged here, retired with its producers; the table stays declared until its rows are
// retired (owner decision, the tables plan).

import type { RawSqlExec } from '../types/primitives';
import { sqlCheckList } from '../utils/sql';
import { EXPERIENCE_KINDS } from './types';

export function initImportedExperienceTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS imported_experience (
    actor_id         TEXT NOT NULL,
    id               TEXT NOT NULL,
    library_id       TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN (${sqlCheckList(EXPERIENCE_KINDS)})),
    key              TEXT NOT NULL,
    title            TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    evidence         TEXT NOT NULL,
    source_workspace TEXT NOT NULL,
    turn_ids         TEXT NOT NULL,
    imported_at      INTEGER NOT NULL,
    -- Null while provisional.
    corroborated_at  INTEGER,
    PRIMARY KEY (actor_id, id)
  )`);
  // Unique per actor: two actors of one workspace may each adopt the same entry.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_experience_library
    ON imported_experience(actor_id, library_id)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_imported_experience_recent
    ON imported_experience(actor_id, imported_at DESC)`);
}
