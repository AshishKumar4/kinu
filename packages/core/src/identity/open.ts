/**
 * Open an existing workspace — runs the resume protocol and returns the
 * default agent's AgentRuntime.
 *
 * Resume protocol:
 * 1. Read workspace_identity → get stable UUID + name
 * 2. Read SOUL.md → get the workspace identity text
 * 3. Read scaffold_versions → get current version
 * 4. Read scaffold/agent.js from VFS → current agentic loop
 * 5. Read craft_scores → quality metrics
 * 6. Detect orphaned fibers → recover or clean up
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LLMProviderConfig } from '../llm.js';
import { initAllTables, migrateWorkspaceStorage } from './schema.js';
import { readSoul, summarizeSoul } from './soul.js';
import { memoryBytes } from '../memory/note.js';
import {
  createInlineCraftStore, createInlineExecutor, createInlineMemory,
  createInlineSchedule, createInlineWorkspace, wrapDatabase, type AgentDatabase,
} from './inline-primitives.js';
import { createVercelAILLM } from '../llm.js';
import { buildRuntime } from '../runtime-builder.js';

export interface WorkspaceResumeConfig {
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
}

/** What `proteus status` and the local chat header read about an open
 *  workspace. One identifier: `name`, the permanent slug. `workspace_identity.id`
 *  stays internal — it is the runtime's `agentId` and fork provenance, and
 *  showing it beside the name showed the workspace's address twice. */
export interface WorkspaceInfo {
  name: string;
  purpose: string;
  soul: string;
  scaffoldVersion: number;
  craftedToolCount: number;
  searchNodeCount: number;
  taskCount: number;
  memorySize: number;
  createdAt: number;
}

/** Open an existing workspace database and resume it. Async because SOUL.md
 *  and the memory total are read out of the workspace filesystem. */
export async function openWorkspace(db: AgentDatabase, config: WorkspaceResumeConfig): Promise<{
  rt: AgentRuntime;
  info: WorkspaceInfo;
}> {
  const { sql, execRaw } = wrapDatabase(db);

  // Ensure all tables exist (handles schema upgrades gracefully)
  initAllTables(execRaw, sql);
  migrateWorkspaceStorage(sql, execRaw);

  // Step 1: Read identity
  const identity = sql<{ id: string; name: string; created_at: number }>`
    SELECT id, name, created_at FROM workspace_identity LIMIT 1
  `[0];
  if (!identity) throw new Error('No workspace identity found. Use createWorkspace() to create one.');

  const workspace = createInlineWorkspace(db);

  // Step 2: Read SOUL.md
  const soul = await readSoul(workspace.vfs);
  if (!soul) throw new Error('No SOUL.md found. Database may be corrupted.');

  // Step 3: Scaffold version
  const scaffoldVersion = sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions
  `[0]?.v ?? 0;

  // Step 4: CraftStore stats
  const craftedToolCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;

  // Step 5: Search tree stats
  const searchNodeCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`[0]?.c ?? 0;

  // Step 6: Task history
  const taskCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM task_history`[0]?.c ?? 0;

  // Step 8: Detect orphaned fibers
  const orphanedFibers = sql<{ id: string; name: string }>`SELECT id, name FROM fibers`;
  if (orphanedFibers.length > 0) {
    console.warn(`[workspace] ${orphanedFibers.length} orphaned fiber(s) from previous run:`,
      orphanedFibers.map(f => f.name).join(', '));
    // Clean up orphaned fibers
    for (const fiber of orphanedFibers) {
      void sql`DELETE FROM fibers WHERE id = ${fiber.id}`;
    }
  }

  const vfs = workspace.vfs;
  // Memory size — walked through the filesystem the agent itself uses.
  const memorySize = await memoryBytes(vfs);
  const memory = createInlineMemory(db, vfs);
  const craftStore = createInlineCraftStore(db);

  const llm = createVercelAILLM(config.llm);
  // Cross-model judge only when configured — consumers document their own
  // same-model fallback (mcts/evaluation.ts: judge ?? explorer).
  const judgeModel = config.judge ? createVercelAILLM(config.judge) : undefined;

  const schedule = createInlineSchedule(sql);

  const rt = buildRuntime({
    sql, execRaw, vfs, llm, executor: createInlineExecutor(), schedule, shell: workspace.shell,
    agentId: identity.id, agentName: identity.name,
    memory, craftStore, judgeModel,
    spawnBranch: async () => ({
      explore: async () => ({ text: 'exploration' }),
      generateReflection: async () => ({ text: 'reflection' }),
    }),
    abortBranch: async () => {},
  });

  return {
    rt,
    info: {
      name: identity.name,
      purpose: summarizeSoul(soul),
      soul,
      scaffoldVersion,
      craftedToolCount,
      searchNodeCount,
      taskCount,
      memorySize,
      createdAt: identity.created_at,
    },
  };
}
