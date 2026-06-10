/**
 * Create a new agent — initializes the database and returns an AgentRuntime.
 *
 * This is the "birth" of an agent. It creates:
 * - All tables (idempotent)
 * - SOUL.md
 * - The initial scaffold
 * - The agent identity (stable UUID)
 */

import { writeVfsFileSync } from '@proteus/agent-utils/vfs';
import type { AgentRuntime, BranchHandle } from '../types/agent-runtime.js';
import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';
import type { LLMProviderConfig } from '../llm.js';
import { initAllTables } from './schema.js';
import { seedSoul } from './soul.js';
import {
  createInlineCraftStore, createInlineExecutor, createInlineMemory,
  createInlineSchedule, createInlineVFS, wrapDatabase, type AgentDatabase,
} from './inline-primitives.js';
import { INITIAL_SCAFFOLD_SOURCE } from '../scaffold/bootstrap.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';
import { createVercelAILLM } from '../llm.js';
import { buildRuntime } from '../runtime-builder.js';

export { wrapDatabase, type AgentDatabase } from './inline-primitives.js';

export interface AgentBirthConfig {
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
  config: { llm: LLMProviderConfig; judge?: LLMProviderConfig; agentId: string; agentName: string },
) {
  const vfs = createInlineVFS(sql);
  const memory = createInlineMemory(db, vfs);
  const craftStore = createInlineCraftStore(db);
  const executor = createInlineExecutor();
  const llm = createVercelAILLM(config.llm);
  const judgeModel = config.judge ? createVercelAILLM(config.judge) : llm;
  const schedule = createInlineSchedule(sql);

  const mockBranch: BranchHandle = {
    explore: async () => ({ text: 'exploration result', codeUsed: null }),
    evaluate: async () => 0.5,
    generateReflection: async () => 'no reflection available',
  };

  return buildRuntime({
    sql, execRaw, vfs, llm, executor, schedule,
    agentId: config.agentId, agentName: config.agentName,
    memory, craftStore, judgeModel,
    spawnBranch: async () => mockBranch,
    abortBranch: async () => {},
  });
}

/** Create a new agent identity from scratch */
export function createAgent(db: AgentDatabase, config: AgentBirthConfig): AgentRuntime {
  const { sql, execRaw } = wrapDatabase(db);

  // Initialize all tables
  initAllTables(execRaw);

  // Write the agent identity
  const agentId = nanoid();
  sql`INSERT INTO agent_identity (id, name, created_at) VALUES (${agentId}, ${config.name}, ${nowMs()})`;

  // Seed SOUL.md from the initial mission. It is the canonical agent identity.
  seedSoul(sql, { name: config.name, mission: config.purpose });

  // Bootstrap scaffold into VFS
  const scaffoldCode = config.scaffold ?? INITIAL_SCAFFOLD_SOURCE;
  writeVfsFileSync(sql, 'scaffold/agent.js', scaffoldCode);
  sql`INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale) VALUES (0, ${nowMs()}, ${'initial bootstrap'})`;

  // Initialize MEMORY.md
  writeVfsFileSync(sql, 'memory/MEMORY.md', `# ${config.name}\n\nCreated: ${new Date().toISOString()}\n`);

  return buildComponents(db, sql, execRaw, {
    llm: config.llm, judge: config.judge, agentId, agentName: config.name,
  });
}
