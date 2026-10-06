import { Effect } from 'effect';
import type { LLMProviderConfig } from '@kinu.run/core';
import {
  initWorkspaceSchema, initActorStateSchema, summarizeSoul,
  getCurrentScaffoldVersion, memoryBytes,
} from '@kinu.run/core';
import { createCLIRuntime, makeSql, makeWorkspaceSchemaSql, soulIn, waitOnSharedWrites, type CLIRuntime } from './runtime';
import type { LocalCloudSession, LocalProviderCredentials } from './model-resolver';
import type { LocalOAuthStore } from './oauth-store';
import type { Database } from 'bun:sqlite';
import type { LocalActorConfig } from '@kinu.run/core';
import { KinuError, settle } from '@kinu.run/core/obs';
import { requireSchemaGenesis } from './schema-genesis';

export interface WorkspaceInfo {
  id: string;
  name: string;
  purpose: string;
  soul: string;
  scaffoldVersion: number;
  searchNodeCount: number;
  memorySize: number;
  createdAt: number;
}

interface CLIOpenOptions {
  /** Default endpoint for bare ids; null when nothing derives one. */
  llm: LLMProviderConfig | null;
  providerCredentials?: LocalProviderCredentials;
  oauthStore?: LocalOAuthStore;
  /** The signed-in session, whose worker rates turns. */
  cloud?: LocalCloudSession;
  /** The folder the workspace works in; see `CLIRuntimeConfig.cwd`. */
  cwd: string;
  checkpointKeep?: number;
}

export type CLIOpenConfig = CLIOpenOptions & LocalActorConfig;

interface OpenedWorkspaceIdentity { readonly id: string; readonly name: string; readonly created_at: number }

export function openWorkspaceCLI(
  db: Database,
  dbPath: string,
  config: CLIOpenConfig,
): Promise<{ rt: CLIRuntime; info: WorkspaceInfo }> {
  return settle(Effect.gen(function* () {
    waitOnSharedWrites(db);
    const sql = makeSql(db);

    let identity: OpenedWorkspaceIdentity;

    if (config.facet !== undefined) {
      initActorStateSchema(makeWorkspaceSchemaSql(db));
      identity = { id: config.actorBinding.reference.actorId, name: config.actorBinding.name, created_at: config.actorBinding.createdAt };
    } else {
      requireSchemaGenesis(db, dbPath);
      initWorkspaceSchema(makeWorkspaceSchemaSql(db));
      const stored = sql<OpenedWorkspaceIdentity>`SELECT id, name, created_at FROM workspace_identity LIMIT 1`[0];

      if (!stored) return yield* new KinuError('missing', 'The workspace has no durable identity.');
      identity = stored;
    }

    const rt = createCLIRuntime(db, { ...config, agentName: identity.name });

    // The workspace's SOUL.md, in its own space: its agents edit it, and may have emptied it.
    const soul = soulIn(rt.space) ?? '';

    // The live version, scoped to `rt.actor`: a facet opens as its own actor, and
    // the scaffold pointer is per-actor.
    const scaffoldVersion = getCurrentScaffoldVersion(sql, rt.actor) ?? 0;

    const searchNodeCount = sql<{ c: number }>`
      SELECT COUNT(*) as c FROM search_nodes WHERE actor_id = ${rt.actor.actorId}`[0]?.c ?? 0;

    const memorySize = yield* Effect.promise(async () => memoryBytes(rt.agentStateVfs ?? rt.storage.vfs));

    return {
      rt,
      info: {
        id: identity.id,
        name: identity.name,
        purpose: summarizeSoul(soul),
        soul,
        scaffoldVersion,
        searchNodeCount,
        memorySize,
        createdAt: identity.created_at,
      },
    };
  }));
}
