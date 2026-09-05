/**
 * Scaffold cold-start bootstrap and activation refresh.
 *
 * On a fresh workspace the canonical `.v0` source lands first, its metadata
 * row second, and the live `scaffold/agent.js` view last. On a preserved
 * workspace the one-shot seed copies the live source into `.v{current}` so
 * the archive becomes canonical without inventing content. Every run then
 * converges the rebuildable live view onto the current pointer's version
 * file — the heal for a crash that landed between a pointer flip and the
 * view write.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { initScaffoldTables } from './schemas';
import { getCurrentScaffoldVersion } from './shadow';
import { readScaffoldFileText } from './surface';
import { nowMs } from '../utils/date';

export const INITIAL_SCAFFOLD_SOURCE = `\
// scaffold/agent.js — v0 (initial bootstrap)
//
// This is the agent's mutable agentic loop. It runs inside the codemode
// sandbox and talks to the host ONLY through the \`host.*\` bridge (the live
// runtime object can't cross the sandbox boundary). The task is the 2nd arg.
//
// The default loop delegates to host.defaultInference(), which runs the
// agent's standard inference (full tools + multi-step) and streams the
// response to the user. An evolved scaffold can replace this delegation with
// its own strategy (MCTS, branching heads, reflection passes, …) while still
// reaching the model + tools via host.llmStream / host.callTool.

async function* run(rt, task) {
  await host.defaultInference();
}
`;

const V0_RATIONALE = 'initial bootstrap';

function insertV0Row(rt: AgentRuntime): void {
  void rt.storage.sql`
    INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale)
    VALUES (0, ${nowMs()}, ${V0_RATIONALE})
  `;
}

export async function bootstrapScaffold(rt: AgentRuntime): Promise<void> {
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  const sql = rt.storage.sql;
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  const path = rt.identity.scaffold.path;
  const versionedPath = (version: number) => `${path}.v${version}`;

  let current = getCurrentScaffoldVersion(sql);
  const liveExists = await vfs.exists(path);

  if (current === null && !liveExists) {
    // Fresh workspace: canonical source, then its row, then the view.
    await vfs.writeFile(versionedPath(0), INITIAL_SCAFFOLD_SOURCE);
    insertV0Row(rt);
    await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);
    return;
  }

  // Preserved workspace — seed the pointer's version file from the live
  // source exactly once; the view is the only source such a workspace has.
  const seededVersion = current ?? 0;
  if (!(await vfs.exists(versionedPath(seededVersion)))) {
    if (!liveExists) return; // no source anywhere — surfaces at execution read
    await vfs.writeFile(versionedPath(seededVersion), await readScaffoldFileText(vfs, path));
  }
  if (current === null) {
    insertV0Row(rt);
    current = getCurrentScaffoldVersion(sql);
  }

  // Activation refresh: converge the live view onto the current pointer.
  const activeVersion = current;
  if (activeVersion === null || !(await vfs.exists(versionedPath(activeVersion)))) return;
  const canonical = await readScaffoldFileText(vfs, versionedPath(activeVersion));
  if (!liveExists || (await readScaffoldFileText(vfs, path)) !== canonical) {
    await rt.identity.scaffold.write(canonical);
  }
}
