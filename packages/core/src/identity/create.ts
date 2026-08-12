/**
 * Create a new workspace — initializes the database and returns the
 * AgentRuntime of its default orchestrator agent.
 *
 * This is the "birth" of a workspace. It creates:
 * - All tables (idempotent)
 * - SOUL.md
 * - The initial scaffold
 * - The workspace identity (stable UUID) — the ownership root
 */

import type { AgentRuntime, BranchHandle } from '../types/agent-runtime.js';
import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';
import type { LLMProviderConfig } from '../llm.js';
import { initAllTables } from './schema.js';
import { seedSoul } from './soul.js';
import {
  createInlineCraftStore, createInlineExecutor, createInlineMemory,
  createInlineSchedule, createInlineWorkspace, wrapDatabase, type AgentDatabase,
} from './inline-primitives.js';
import { INITIAL_SCAFFOLD_SOURCE } from '../scaffold/bootstrap.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';
import { createVercelAILLM } from '../llm.js';
import { buildRuntime } from '../runtime-builder.js';

export { wrapDatabase, type AgentDatabase } from './inline-primitives.js';

export interface WorkspaceBirthConfig {
  name: string;
  purpose: string;
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
  /** Custom initial scaffold (defaults to INITIAL_SCAFFOLD_SOURCE) */
  scaffold?: string;
}

/** Create VFS, Memory, CraftStore, Schedule from database + LLM config */
function buildComponents(
  db: AgentDatabase,
  sql: SqlExecutor,
  execRaw: RawSqlExec,
  workspace: ReturnType<typeof createInlineWorkspace>,
  config: { llm: LLMProviderConfig; judge?: LLMProviderConfig; agentId: string; agentName: string },
) {
  const vfs = workspace.vfs;
  const memory = createInlineMemory(db, vfs);
  const craftStore = createInlineCraftStore(db);
  const executor = createInlineExecutor();
  const llm = createVercelAILLM(config.llm);
  // Cross-model judge only when configured — consumers document their own
  // same-model fallback (mcts/evaluation.ts: judge ?? explorer).
  const judgeModel = config.judge ? createVercelAILLM(config.judge) : undefined;
  const schedule = createInlineSchedule(sql);

  const mockBranch: BranchHandle = {
    explore: async () => ({ text: 'exploration result', codeUsed: null }),
    generateReflection: async () => ({ text: 'no reflection available' }),
  };

  return buildRuntime({
    sql, execRaw, vfs, llm, executor, schedule, shell: workspace.shell,
    agentId: config.agentId, agentName: config.agentName,
    memory, craftStore, judgeModel,
    spawnBranch: async () => mockBranch,
    abortBranch: async () => {},
  });
}

/**
 * Create a new workspace from scratch. Returns the default agent's runtime.
 *
 * Async because the seeds are FILES in a real filesystem: SOUL.md, the initial
 * scaffold and MEMORY.md are written through the same VFS the agent will use,
 * not injected into storage behind it.
 */
export async function createWorkspace(
  db: AgentDatabase, config: WorkspaceBirthConfig,
): Promise<AgentRuntime> {
  const { sql, execRaw } = wrapDatabase(db);

  initAllTables(execRaw);
  const workspace = createInlineWorkspace(db);

  const workspaceId = nanoid();
  sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${workspaceId}, ${config.name}, ${nowMs()})`;

  // SOUL.md — the workspace's canonical identity document, embodied by its
  // default agent. seedSoul also seeds the mission a listing reads.
  await seedSoul(workspace.vfs, sql, { name: config.name, mission: config.purpose });

  await workspace.vfs.mkdir('scaffold', { recursive: true });
  await workspace.vfs.writeFile('scaffold/agent.js', config.scaffold ?? INITIAL_SCAFFOLD_SOURCE);
  sql`INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale) VALUES (0, ${nowMs()}, ${'initial bootstrap'})`;

  await workspace.vfs.mkdir('memory', { recursive: true });
  await workspace.vfs.writeFile('memory/MEMORY.md', `# ${config.name}\n\nCreated: ${new Date().toISOString()}\n`);

  return buildComponents(db, sql, execRaw, workspace, {
    llm: config.llm, judge: config.judge, agentId: workspaceId, agentName: config.name,
  });
}
