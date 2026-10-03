/** Scaffold lineage: a read model over `scaffold_versions`, newest first. No second table. */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { ScaffoldArchiveEntry, ScaffoldStatus } from '../types/scaffold';

export type { ScaffoldArchiveEntry, ScaffoldStatus } from '../types/scaffold';

export function listScaffoldArchive(sql: SqlExecutor, actor: ActorHandle, limit = 50): ScaffoldArchiveEntry[] {
  actor.assertCurrent();

  return sql<{
    version: number; parent_version: number | null; status: ScaffoldStatus; rationale: string; pathology: string | null; written_at: number;
  }>`SELECT version, parent_version, status, rationale, pathology, written_at FROM scaffold_versions
    WHERE actor_id = ${actor.actorId} ORDER BY version DESC LIMIT ${limit}`
    .map((row) => ({
      version: row.version,
      parentVersion: row.parent_version,
      status: row.status,
      rationale: row.rationale,
      pathology: row.pathology,
      writtenAt: row.written_at,
    }));
}
