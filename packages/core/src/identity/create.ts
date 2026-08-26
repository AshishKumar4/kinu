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

import type { AgentRuntime } from '../types/agent-runtime';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { LLMProviderConfig } from '../llm';
import { initAllTables } from './schema';
import { seedSoul } from './soul';
import {
  createInlineCraftStore, createInlineExecutor, createInlineMemory,
  createInlineSchedule, createInlineWorkspace, wrapDatabase, type AgentDatabase,
} from './inline-primitives';
import { INITIAL_SCAFFOLD_SOURCE } from '../scaffold/bootstrap';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { createVercelAILLM } from '../llm';
import { buildRuntime } from '../runtime-builder';
import { initWorkspaceBaselineTable, resetWorkspaceBaseline } from '../read-models/workspace-diff';

export { wrapDatabase, type AgentDatabase } from './inline-primitives';

export interface WorkspaceBirthConfig {
  name: string;
  purpose: string;
  llm: LLMProviderConfig;
  /** Custom initial scaffold (defaults to INITIAL_SCAFFOLD_SOURCE) */
  scaffold?: string;
}

/** Create VFS, Memory, CraftStore, Schedule from database + LLM config */
function buildComponents(
  db: AgentDatabase,
  sql: SqlExecutor,
  execRaw: RawSqlExec,
  workspace: ReturnType<typeof createInlineWorkspace>,
  config: { llm: LLMProviderConfig; agentId: string; agentName: string },
) {
  const vfs = workspace.vfs;
  const memory = createInlineMemory(db, vfs);
  const craftStore = createInlineCraftStore(db);
  const executor = createInlineExecutor();
  const llm = createVercelAILLM(config.llm);
  const schedule = createInlineSchedule(sql);

  return buildRuntime({
    sql, execRaw, vfs, llm, executor, schedule, shell: workspace.shell,
    agentId: config.agentId, agentName: config.agentName,
    memory, craftStore,
    /**
     * This runtime does not implement branch spawning, and says so instead of
     * pretending to.
     *
     * It used to return a handle whose `explore` answered the literal
     * `'exploration result'` and whose `generateReflection` answered
     * `'no reflection available'`. No consumer can tell either from a real
     * result, so every MCTS-shaped measurement taken on this runtime scored a
     * fabricated string — and two full behavioural eval runs did exactly that
     * before anyone noticed, because a plausible fake corrupts silently while an
     * absent implementation is found in seconds.
     *
     * `createWorkspace` exists to BIRTH a workspace (cli/src/agent-create.ts
     * calls it once and closes the database); every running surface opens through
     * `openWorkspaceCLI` -> `createCLIRuntime`, which registers the real branch
     * spawner. Reaching this is a misconfiguration, so it fails loudly here
     * rather than quietly downstream.
     */
    spawnBranch: () => {
      throw new Error(
        'createWorkspace\'s birth runtime does not implement spawnBranch — it is for creating a '
        + 'workspace, not for running one. Open the workspace with openWorkspaceCLI (which builds '
        + 'createCLIRuntime) to get a real branch spawner. Returning a stub result here would be '
        + 'indistinguishable from a real exploration to every consumer.',
      );
    },
    // No branch can exist on this runtime, since spawning throws. These stay
    // no-ops rather than throwing because they return nothing and so fabricate
    // nothing, and an unconditional teardown path must stay safe to call.
    abortBranch: async () => {},
    releaseBranch: async () => {},
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

  initAllTables(execRaw, sql);
  initWorkspaceBaselineTable(execRaw);
  const workspace = createInlineWorkspace(db);

  const workspaceId = nanoid();
  void sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${workspaceId}, ${config.name}, ${nowMs()})`;

  // SOUL.md — the workspace's canonical identity document, embodied by its
  // default agent. seedSoul also seeds the mission a listing reads.
  await seedSoul(workspace.vfs, sql, { name: config.name, mission: config.purpose });

  await workspace.vfs.mkdir('scaffold', { recursive: true });
  // Canonical source lands before the live view: the archive is authoritative
  // from birth, and agent.js is only its rebuildable view.
  const scaffoldSource = config.scaffold ?? INITIAL_SCAFFOLD_SOURCE;
  await workspace.vfs.writeFile('scaffold/agent.js.v0', scaffoldSource);
  void sql`INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale) VALUES (0, ${nowMs()}, ${'initial bootstrap'})`;
  await workspace.vfs.writeFile('scaffold/agent.js', scaffoldSource);

  await workspace.vfs.mkdir('memory', { recursive: true });
  await workspace.vfs.writeFile('memory/MEMORY.md', `# ${config.name}\n\nCreated: ${new Date().toISOString()}\n`);

  const runtime = buildComponents(db, sql, execRaw, workspace, {
    llm: config.llm, agentId: workspaceId, agentName: config.name,
  });
  await resetWorkspaceBaseline(runtime);
  return runtime;
}
