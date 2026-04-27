/**
 * Scaffold cold-start bootstrap.
 *
 * Architecture reference: final-architecture.md §4 (Cold start)
 *
 * On first run, scaffold/agent.js does not exist in the VFS.
 * This module provides the initial scaffold source as a string constant
 * and the bootstrap function that writes it.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { initScaffoldTables } from './schemas.js';
import { nowMs } from '../utils/date.js';

export const INITIAL_SCAFFOLD_SOURCE = `\
// scaffold/agent.js — v0 (initial bootstrap)
// This is the agent's mutable agentic loop.
// It runs inside rt.executor.execute() and receives rt via Proxy globals.

async function* run(rt, task) {
  const knowledge = (await codemode.readMemory({ path: "memory/MEMORY.md" })) ?? "";
  const messages = [{ role: "user", content: task }];

  for await (const chunk of rt.llm.stream({
    system: "You are a helpful agent.\\n\\n" + knowledge,
    messages,
    tools: {},
    maxSteps: 500,
  })) {
    yield { type: "chunk", data: chunk };
  }

  await codemode.appendMemory({
    path: "memory/logs/" + new Date().toISOString().slice(0, 10) + ".md",
    content: "\\nTask: " + task.slice(0, 80) + "\\n",
  });
}
`;

export async function bootstrapScaffold(rt: AgentRuntime): Promise<void> {
  initScaffoldTables(rt.storage.execRaw);

  if (await rt.identity.scaffold.exists()) return;

  await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);
  rt.storage.sql`
    INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale)
    VALUES (0, ${nowMs()}, ${'initial bootstrap'})
  `;
}
