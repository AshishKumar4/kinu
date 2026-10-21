/** The artifact store's table (docs/EVOLUTION-REDESIGN.md §3), apart from its logic so a workspace's schema reaches no tool module. */
import { sqlCheckList } from '../utils/sql';
import type { RawSqlExec } from '../types/primitives';

/** `staged` waits for a turn whose prompt cache is cold (`turnArtifacts`); `current` is what turns assemble from. */
export const ARTIFACT_STATUSES = ['current', 'staged', 'rolled_back', 'historical'] as const;

export function initArtifactTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS artifact_versions (
    actor_id    TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version     INTEGER NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN (${sqlCheckList(ARTIFACT_STATUSES)})),
    parent      INTEGER,
    rationale   TEXT NOT NULL,
    evidence    TEXT,
    written_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    PRIMARY KEY (actor_id, artifact_id, version)
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS idx_artifact_versions_status ON artifact_versions(actor_id, status, artifact_id)');
}
