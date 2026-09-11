/**
 * Open an existing workspace for the CLI with the cli-backend runtime: FTS5
 * memory, the sandboxed executor and real MCTS branches.
 *
 * Returns the WorkspaceInfo structure the CLI commands display.
 */

import type { LLMProviderConfig } from '@kinu.run/core';
import {
  initWorkspaceBaselineTable, initWorkspaceSchema, initActorStateSchema, readSoul, summarizeSoul,
  getCurrentScaffoldVersion, memoryBytes,
} from '@kinu.run/core';
import { createCLIRuntime, makeSql, makeWorkspaceSchemaSql, type CLIRuntime } from './runtime';
import type { LocalProviderCredentials } from './model-resolver';
import type { LocalCodexAuthStore } from './codex-auth-store';
import type { Database } from 'bun:sqlite';
import type { LocalActorConfig } from './actor-identity';
import { KinuError } from '@kinu.run/core/obs';

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

interface CLIOpenOptions {
  /** The default endpoint for bare ids — null when nothing derives one.
   *  Explicit specs resolve through the registry regardless. */
  llm: LLMProviderConfig | null;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  /** The canonical physical directory every agent in this virtual workspace
   *  shares as its file and shell plane. See CLIRuntimeConfig.cwd. */
  cwd?: string | null;
  /** Where the `laptop` executor is rooted, or `null` for a runtime with no
   *  host plane at all. See CLIRuntimeConfig.hostRoot — a measurement harness
   *  passes `null` so an episode cannot write into the developer's repo. */
  hostRoot?: string | null;
  /** Shadow-git checkpoints kept per working directory. */
  checkpointKeep?: number;
}

export type CLIOpenConfig = CLIOpenOptions & LocalActorConfig;

interface OpenedWorkspaceIdentity { readonly id: string; readonly name: string; readonly created_at: number }

/**
 * Open an existing workspace using the full CLI backend runtime. It uses:
 * - the workspace plane `config.cwd` names, or the Nimbus filesystem with none
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
  // A RUNNING workspace is WAL: the scheduler daemon and the CLI read the same
  // file at the same time, which is what WAL is for. It is set here rather than
  // at creation because `kinu create` publishes the file with no sidecars
  // beside it — a WAL database is unreadable without the `-shm` SQLite builds
  // next to it — and opening is the one moment a workspace gains what it is
  // missing, exactly as the schema below does.
  db.exec('PRAGMA journal_mode = WAL');

  let identity: OpenedWorkspaceIdentity;

  if (config.facet !== undefined) {
    initActorStateSchema(makeWorkspaceSchemaSql(db));
    identity = { id: config.actorBinding.reference.actorId, name: config.actorBinding.name, created_at: config.actorBinding.createdAt };
  } else {
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const stored = sql<OpenedWorkspaceIdentity>`SELECT id, name, created_at FROM workspace_identity LIMIT 1`[0];

    if (!stored) throw new KinuError('missing', 'The workspace has no durable identity.');
    identity = stored;
  }

  initWorkspaceBaselineTable((ddl) => db.exec(ddl));
  const rt = createCLIRuntime(db, { ...config, dbPath, agentName: identity.name });

  // SOUL belongs to the agent, not to the shared physical project directory.
  const soul = await readSoul(rt.agentStateVfs ?? rt.storage.vfs);

  if (!soul) throw new Error('No SOUL.md found. Database may be corrupted.');

  // Gather stats for WorkspaceInfo display
  // The LIVE version — the one that actually drives a turn. MAX(version)
  // reported an unresolved pending proposal as though it were already running.
  // Scoped to `rt.actor`, NOT the workspace main: the branch above opens a
  // facet as its OWN actor, and the scaffold pointer and task ledger are
  // per-actor — reading the main's would report the parent's program here.
  const scaffoldVersion = getCurrentScaffoldVersion(sql, rt.actor) ?? 0;
  // Unscoped ON PURPOSE, and the only stat here that is: `crafted_tools` is one
  // catalog per workspace (see identity/schema.ts) and this count reports the
  // catalog, not this actor's eligible slice of it.
  const craftedToolCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;

  const searchNodeCount = sql<{ c: number }>`
    SELECT COUNT(*) as c FROM search_nodes WHERE actor_id = ${rt.actor.actorId}`[0]?.c ?? 0;

  const taskCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM task_history
    WHERE actor_id = ${rt.actor.actorId}`[0]?.c ?? 0;

  // Memory is the agent's own, so it is measured on the agent's own plane —
  // never on a shared project directory, where `memory/` does not belong.
  const memorySize = await memoryBytes(rt.agentStateVfs ?? rt.storage.vfs);

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
