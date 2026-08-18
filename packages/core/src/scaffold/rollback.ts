/**
 * Scaffold rollback — restore a prior version.
 *
 * Formal spec: Evolution/Scaffold.lean — rollback_nonexistent_is_none
 */

import * as v from 'valibot';
import type { AgentRuntime } from '../types/agent-runtime';

export async function rollbackScaffold(
  rt: AgentRuntime,
  version: number,
): Promise<{ ok: boolean; error?: string }> {
  const versionPath = `${rt.identity.scaffold.path}.v${version}`;
  const exists = await rt.storage.vfs.exists(versionPath);
  if (!exists) {
    return { ok: false, error: `Version ${version} not found in scaffold history` };
  }

  const backup = v.parse(v.string(), await rt.storage.vfs.readFile(
    versionPath,
    { encoding: 'utf8' },
  ));

  await rt.identity.scaffold.write(backup);
  return { ok: true };
}
