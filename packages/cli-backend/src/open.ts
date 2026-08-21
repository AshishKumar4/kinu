/**
 * Open an existing workspace for CLI — uses the proper cli-backend runtime
 * (FTS5 memory, sandboxed executor, real MCTS branches) instead of the
 * degraded inline implementations in core/identity/open.ts.
 *
 * Provides the same WorkspaceInfo structure as core's openWorkspace for
 * display compatibility with CLI commands.
 */

import type { LLMProviderConfig } from '@kinu.run/core';
import type { OAuthCredential } from '@kinu.run/core';
import {
  initWorkspaceBaselineTable, initWorkspaceSchema, readSoul, summarizeSoul,
  getCurrentScaffoldVersion, memoryBytes,
} from '@kinu.run/core';
import { createCLIRuntime, makeSql, makeWorkspaceSchemaSql, type CLIRuntime } from './runtime';
import type { LocalProviderCredentials } from './model-resolver';
import type { LocalCodexAuthStore } from './codex-auth-store';
import type { Database } from 'bun:sqlite';

export interface WorkspaceInfo {
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

export interface CLIOpenConfig {
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  onCodexRefresh?: (credential: OAuthCredential) => void;
  /** Where the `laptop` executor is rooted, or `null` for a runtime with no
   *  host plane at all. See CLIRuntimeConfig.hostRoot — a measurement harness
   *  passes `null` so an episode cannot write into the developer's repo. */
  hostRoot?: string | null;
  /** Shadow-git checkpoints kept per working directory. */
  checkpointKeep?: number;
}

/**
 * Open an existing workspace using the full CLI backend runtime.
 *
 * Unlike core's openWorkspace (which uses degraded inline VFS/Memory/Executor),
 * this uses:
 * - the Nimbus workspace filesystem
 * - MemoryStore with FTS5 (BM25 ranking, markdown chunking)
 * - Sandboxed executor (Bun subprocess with timeout)
 * - Real MCTS branch spawner (child processes with LLM calls)
 * - Proper CraftStore with FTS5 search
 */
export async function openWorkspaceCLI(
  db: Database,
  dbPath: string,
  config: CLIOpenConfig,
): Promise<{ rt: CLIRuntime; info: WorkspaceInfo }> {
  const sql = makeSql(db);

  // Every table a workspace has, on any backend — one list, in core. Opening
  // is the only moment a workspace made by an older build (or by another
  // backend) can gain what it is missing, so the full set runs here.
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  initWorkspaceBaselineTable((ddl) => db.exec(ddl));

  // Read identity
  const identity = sql<{ id: string; name: string; created_at: number }>`
    SELECT id, name, created_at FROM workspace_identity LIMIT 1
  `[0];
  if (!identity) throw new Error('No workspace identity found. Use createWorkspace() to create one.');

  // Built before the reads below, because SOUL.md and the memory total are
  // FILES now and this is what owns the filesystem they live in.
  const rt = createCLIRuntime(db, {
    dbPath,
    llm: config.llm,
    judge: config.judge,
    providerCredentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore,
    codexConfigPath: config.codexConfigPath,
    onCodexRefresh: config.onCodexRefresh,
    checkpointKeep: config.checkpointKeep,
    hostRoot: config.hostRoot,
    agentName: identity.name,
  });

  // Read SOUL.md — a file in the workspace filesystem the runtime just built.
  const soul = await readSoul(rt.storage.vfs);
  if (!soul) throw new Error('No SOUL.md found. Database may be corrupted.');

  // Gather stats for WorkspaceInfo display
  // The LIVE version — the one that actually drives a turn. MAX(version)
  // reported an unresolved pending proposal as though it were already running.
  const scaffoldVersion = getCurrentScaffoldVersion(sql) ?? 0;
  const craftedToolCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;
  const searchNodeCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`[0]?.c ?? 0;
  const taskCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM task_history`[0]?.c ?? 0;

  // Memory size — walked through the filesystem the agent itself uses.
  const memorySize = await memoryBytes(rt.storage.vfs);

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
