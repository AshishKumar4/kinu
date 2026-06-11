/**
 * Open an existing agent — runs the resume protocol and returns AgentRuntime.
 *
 * Resume protocol:
 * 1. Read agent_identity → get stable UUID + name
 * 2. Read SOUL.md → get agent identity text (migrates legacy agent_soul DBs)
 * 3. Read scaffold_versions → get current version
 * 4. Read scaffold/agent.js from VFS → current agentic loop
 * 5. Read craft_scores → quality metrics
 * 6. Detect orphaned fibers → recover or clean up
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LLMProviderConfig } from '../llm.js';
import { initAllTables } from './schema.js';
import { readSoul, summarizeSoul } from './soul.js';
import {
  createInlineCraftStore, createInlineExecutor, createInlineMemory,
  createInlineSchedule, createInlineVFS, wrapDatabase, type AgentDatabase,
} from './inline-primitives.js';
import { createVercelAILLM } from '../llm.js';
import { buildRuntime } from '../runtime-builder.js';

export interface AgentResumeConfig {
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
}

export interface AgentInfo {
  id: string;
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

/** Open an existing agent database and resume it */
export function openAgent(db: AgentDatabase, config: AgentResumeConfig): {
  rt: AgentRuntime;
  info: AgentInfo;
} {
  const { sql, execRaw } = wrapDatabase(db);

  // Ensure all tables exist (handles schema upgrades gracefully)
  initAllTables(execRaw);

  // Step 1: Read identity
  const identity = sql<{ id: string; name: string; created_at: number }>`
    SELECT id, name, created_at FROM agent_identity LIMIT 1
  `[0];
  if (!identity) throw new Error('No agent identity found. Use createAgent() to create one.');

  // Step 2: Read SOUL.md (migrates pre-SOUL.md agent_soul databases)
  const soul = readSoul(sql);
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

  // Step 7: Memory size
  const memorySize = sql<{ total: number }>`
    SELECT COALESCE(SUM(size), 0) as total FROM vfs_files WHERE path LIKE 'memory/%'
  `[0]?.total ?? 0;

  // Step 8: Detect orphaned fibers
  const orphanedFibers = sql<{ id: string; name: string }>`SELECT id, name FROM fibers`;
  if (orphanedFibers.length > 0) {
    console.warn(`[agent] ${orphanedFibers.length} orphaned fiber(s) from previous run:`,
      orphanedFibers.map(f => f.name).join(', '));
    // Clean up orphaned fibers
    for (const fiber of orphanedFibers) {
      sql`DELETE FROM fibers WHERE id = ${fiber.id}`;
    }
  }

  const vfs = createInlineVFS(sql);
  const memory = createInlineMemory(db, vfs);
  const craftStore = createInlineCraftStore(db);

  const llm = createVercelAILLM(config.llm);
  // Cross-model judge only when configured — consumers document their own
  // same-model fallback (mcts/evaluation.ts: judge ?? explorer).
  const judgeModel = config.judge ? createVercelAILLM(config.judge) : undefined;

  const schedule = createInlineSchedule(sql);

  const rt = buildRuntime({
    sql, execRaw, vfs, llm, executor: createInlineExecutor(), schedule,
    agentId: identity.id, agentName: identity.name,
    memory, craftStore, judgeModel,
    spawnBranch: async () => ({
      explore: async () => ({ text: 'exploration', codeUsed: null }),
      generateReflection: async () => 'reflection',
    }),
    abortBranch: async () => {},
  });

  return {
    rt,
    info: {
      id: identity.id,
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
