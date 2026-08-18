/**
 * Scaffold cold-start bootstrap.
 *
 *
 * On first run, scaffold/agent.js does not exist in the VFS.
 * This module provides the initial scaffold source as a string constant
 * and the bootstrap function that writes it.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { initScaffoldTables } from './schemas';
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

export async function bootstrapScaffold(rt: AgentRuntime): Promise<void> {
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);

  if (await rt.identity.scaffold.exists()) return;

  await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);
  void rt.storage.sql`
    INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale)
    VALUES (0, ${nowMs()}, ${'initial bootstrap'})
  `;
}
