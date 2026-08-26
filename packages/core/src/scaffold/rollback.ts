/**
 * Scaffold rollback — restore a prior version.
 *
 * Pointer-first: one atomic statement makes the target the current pointer
 * and retires the incumbent, then the rebuildable live view is refreshed
 * from the target's canonical `.vN` source. Execution reads the pointer's
 * version file either way.
 *
 * Formal spec: Evolution/Scaffold.lean — rollback_nonexistent_is_none
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { readScaffoldVersion } from './shadow';

export async function rollbackScaffold(
  rt: AgentRuntime,
  version: number,
): Promise<{ ok: boolean; error?: string }> {
  const sql = rt.storage.sql;
  const row = sql<{ status: string }>`
    SELECT status FROM scaffold_versions WHERE version = ${version} LIMIT 1`[0];
  if (!row) {
    return { ok: false, error: `Version ${version} not found in scaffold history` };
  }

  const target = await readScaffoldVersion(rt, version);
  if (target == null) {
    return { ok: false, error: `Version ${version} not found in scaffold history` };
  }

  void sql`UPDATE scaffold_versions
      SET status = CASE WHEN version = ${version} THEN 'current' ELSE 'rolled_back' END
      WHERE version = ${version}
         OR (status = 'current' AND version != ${version})`;
  await rt.identity.scaffold.write(target);
  return { ok: true };
}
