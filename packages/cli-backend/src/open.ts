import type { LLMProviderConfig } from '@kinu.run/core';
import {
  initWorkspaceBaselineTable, initWorkspaceSchema, initActorStateSchema, readSoul, summarizeSoul,
  getCurrentScaffoldVersion, memoryBytes,
} from '@kinu.run/core';
import { createCLIRuntime, makeSql, makeWorkspaceSchemaSql, type CLIRuntime } from './runtime';
import type { LocalProviderCredentials } from './model-resolver';
import type { LocalOAuthStore } from './oauth-store';
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
  /** Default endpoint for bare ids; null when nothing derives one. */
  llm: LLMProviderConfig | null;
  providerCredentials?: LocalProviderCredentials;
  oauthStore?: LocalOAuthStore;
  oauthConfigPath?: string;
  /** See CLIRuntimeConfig.cwd. */
  cwd?: string | null;
  checkpointKeep?: number;
}

export type CLIOpenConfig = CLIOpenOptions & LocalActorConfig;

interface OpenedWorkspaceIdentity { readonly id: string; readonly name: string; readonly created_at: number }

/** Open an existing workspace with the full CLI backend runtime. */
export async function openWorkspaceCLI(
  db: Database,
  dbPath: string,
  config: CLIOpenConfig,
): Promise<{ rt: CLIRuntime; info: WorkspaceInfo }> {
  const sql = makeSql(db);
  // Set on open, not at creation: `kinu create` publishes the file with no sidecars,
  // and a WAL database is unreadable without its `-shm`.
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

  // The live version, scoped to `rt.actor`: a facet opens as its own actor, and
  // the scaffold pointer is per-actor.
  const scaffoldVersion = getCurrentScaffoldVersion(sql, rt.actor) ?? 0;
  // Unscoped on purpose: `crafted_tools` is one catalog per workspace.
  const craftedToolCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;

  const searchNodeCount = sql<{ c: number }>`
    SELECT COUNT(*) as c FROM search_nodes WHERE actor_id = ${rt.actor.actorId}`[0]?.c ?? 0;

  const taskCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM task_history
    WHERE actor_id = ${rt.actor.actorId}`[0]?.c ?? 0;

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
