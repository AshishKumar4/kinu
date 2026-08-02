/**
 * Open an existing workspace for CLI — uses the proper cli-backend runtime
 * (FTS5 memory, sandboxed executor, real MCTS branches) instead of the
 * degraded inline implementations in core/identity/open.ts.
 *
 * Provides the same WorkspaceInfo structure as core's openWorkspace for
 * display compatibility with CLI commands.
 */

import type { AgentRuntime } from '@proteus/core';
import type { LLMProviderConfig } from '@proteus/core';
import type { OAuthCredential } from '@proteus/core';
import { initAllTables, migrateWorkspaceStorage, readSoul, summarizeSoul, getCurrentScaffoldVersion } from '@proteus/core';
import { createCLIRuntime, makeSql, makeExecRaw } from './runtime.js';
import type { LocalProviderCredentials } from './model-resolver.js';
import type { LocalCodexAuthStore } from './codex-auth-store.js';

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
  /** Shadow-git checkpoints kept per working directory. */
  checkpointKeep?: number;
}

type AgentDb = {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void };
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
};

/**
 * Open an existing workspace using the full CLI backend runtime.
 *
 * Unlike core's openWorkspace (which uses degraded inline VFS/Memory/Executor),
 * this uses:
 * - SqliteFS from agent-utils (chunked, with parent tracking)
 * - MemoryStore with FTS5 (BM25 ranking, markdown chunking)
 * - Sandboxed executor (Bun subprocess with timeout)
 * - Real MCTS branch spawner (child processes with LLM calls)
 * - Proper CraftStore with FTS5 search
 */
export function openWorkspaceCLI(
  db: AgentDb,
  dbPath: string,
  config: CLIOpenConfig,
): { rt: AgentRuntime; info: WorkspaceInfo } {
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  // Ensure all tables exist (idempotent)
  initAllTables(execRaw);
  migrateWorkspaceStorage(sql);

  // Read identity
  const identity = sql<{ id: string; name: string; created_at: number }>`
    SELECT id, name, created_at FROM workspace_identity LIMIT 1
  `[0];
  if (!identity) throw new Error('No workspace identity found. Use createWorkspace() to create one.');

  // Read SOUL.md
  const soul = readSoul(sql);
  if (!soul) throw new Error('No SOUL.md found. Database may be corrupted.');

  // Gather stats for WorkspaceInfo display
  // The LIVE version — the one that actually drives a turn. MAX(version)
  // reported an unresolved pending proposal as though it were already running.
  const scaffoldVersion = getCurrentScaffoldVersion(sql) ?? 0;
  const craftedToolCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;
  const searchNodeCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`[0]?.c ?? 0;
  const taskCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM task_history`[0]?.c ?? 0;

  // Memory size — use SUM of text lengths (works for both old flat and new chunked schema)
  let memorySize = 0;
  try {
    memorySize = sql<{ total: number }>`
      SELECT COALESCE(SUM(size), 0) as total FROM vfs_files WHERE path LIKE 'memory/%'
    `[0]?.total ?? 0;
  } catch {
    // vfs_files schema may differ (chunked vs flat) — try LENGTH(data) fallback
    try {
      memorySize = sql<{ total: number }>`
        SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM vfs_files WHERE path LIKE 'memory/%'
      `[0]?.total ?? 0;
    } catch { /* table may not exist yet */ }
  }

  // Build the full CLI runtime with proper implementations
  const rt = createCLIRuntime(db, {
    dbPath,
    llm: config.llm,
    judge: config.judge,
    providerCredentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore,
    codexConfigPath: config.codexConfigPath,
    onCodexRefresh: config.onCodexRefresh,
    checkpointKeep: config.checkpointKeep,
    agentName: identity.name,
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
