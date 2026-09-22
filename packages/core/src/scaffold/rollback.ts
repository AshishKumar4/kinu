/**
 * Scaffold rollback: repoint current to the target in one statement, then refresh the live view.
 *
 * Formal spec: Evolution/Scaffold.lean — rollback_nonexistent_is_none
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { readScaffoldVersion } from './shadow';

export async function rollbackScaffold(
  rt: AgentRuntime,
  version: number,
): Promise<{ ok: boolean; error?: string }> {
  rt.actor.assertCurrent();
  const actorId = rt.actor.actorId;
  const sql = rt.storage.sql;

  const row = sql<{ status: string }>`
    SELECT status FROM scaffold_versions
    WHERE actor_id = ${actorId} AND version = ${version} LIMIT 1`[0];

  if (!row) {
    return { ok: false, error: `Version ${version} not found in scaffold history` };
  }

  const target = await readScaffoldVersion(rt, version);

  if (target == null) {
    return { ok: false, error: `Version ${version} not found in scaffold history` };
  }

  void sql`UPDATE scaffold_versions
      SET status = CASE WHEN version = ${version} THEN 'current' ELSE 'rolled_back' END
      WHERE actor_id = ${actorId}
        AND (version = ${version}
             OR (status = 'current' AND version != ${version}))`;
  await rt.identity.scaffold.write(target);

  return { ok: true };
}
