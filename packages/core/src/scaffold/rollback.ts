/**
 * Scaffold rollback — restore a prior version.
 *
 * Architecture reference: final-architecture.md §4
 * Formal spec: ScaffoldSafety.lean — rollback_restores_code, rollback_nonexistent_is_none
 */

import type { AgentRuntime } from '../types/agent-runtime.js';

export async function rollbackScaffold(
  rt: AgentRuntime,
  version: number,
): Promise<{ ok: boolean; error?: string }> {
  const exists = await rt.storage.vfs.exists(`scaffold/agent.js.v${version}`);
  if (!exists) {
    return { ok: false, error: `Version ${version} not found in scaffold history` };
  }

  const backup = await rt.storage.vfs.readFile(
    `scaffold/agent.js.v${version}`,
    { encoding: 'utf8' },
  ) as string;

  await rt.identity.scaffold.write(backup);
  return { ok: true };
}
