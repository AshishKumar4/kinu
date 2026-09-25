/** One `bun:sqlite` database, one production `ActorHost`, every actor acquired from it (open-38); `databasesOpened()` is the witness. */

import { Database } from 'bun:sqlite';
import {
  BUILTIN_PROFILE_CATALOG, DEFAULT_WORKERS_AI_MODEL_SPEC,
  initWorkspaceSchema, profileCatalogDigest, resolveTurnProfile,
  WorkspaceActorDirectory, actorReferenceOf,
  type ActorHost, type ActorReference, type AgentRuntime, type HostedActor, type LoopOrigin,
  type ProfileAuthorityInputs, type SqlExec, type SqlExecutor,
  type WorkspaceActor,
} from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { makeExecRaw, makeSqlExec } from '../../../core/tests/helpers';
import { makeCtx, makeEnv } from './actor-harness';
import { createWorkspaceActorHost, type WorkspaceHostSeams } from '../../src/actor-hosting';
import { createHostedWorkspace } from '../../src/workspace-host';

/** Every `Database` opened, in order; its length turns "one database" into a measurement. */
const opened: Database[] = [];

export function databasesOpened(): readonly Database[] {
  return opened;
}

export function resetDatabases(): void {
  for (const db of opened) db.close();
  opened.length = 0;
}


export interface HostedWorkspaceFixture {
  readonly db: Database;
  readonly sql: SqlExecutor;
  /** Positional executor for the archive reader, which composes its own statements. */
  readonly exec: SqlExec;
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorReference;
  hire(parent: ActorReference, name: string, kind: WorkspaceActor['kind'], loop?: LoopOrigin): Promise<HostedActor>;
  tables(): readonly string[];
}

/** Fixed authority inputs, so digest assertions never depend on a model choice. */
const FIXTURE_AUTHORITY: ProfileAuthorityInputs = {
  envelope: {
    authority: { kind: 'local' },
    version: 0,
    digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
    catalog: BUILTIN_PROFILE_CATALOG,
  },
  provider: { revision: 'hosted-workspace-fixture', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
};

/** Resolved by the production authority: a claim against a profile it never produced witnesses nothing. */
export function fixtureProfile() {
  return {
    profile: resolveTurnProfile({
      ...FIXTURE_AUTHORITY,
      roleId: 'task',
      workMode: 'build',
      availableTools: [],
      activeSkills: [],
    }),
    inputs: FIXTURE_AUTHORITY,
  };
}

/** Seams reaching real infrastructure come from the caller; everything actor-shaped is genuine. */
export async function hostedWorkspace(
  overrides: Partial<WorkspaceHostSeams> = {},
): Promise<HostedWorkspaceFixture> {
  const db = new Database(':memory:');
  opened.push(db);
  const sql = sqlOver(db);
  const workspaceId = 'harness-workspace';
  const exec = makeSqlExec(db);
  initWorkspaceSchema({ execRaw: makeExecRaw(db), sql, exec, transactionSync: (write) => db.transaction(write)() });
  db.exec(`INSERT INTO workspace_identity (id, name, created_at, owner_user_id)
    VALUES ('${workspaceId}', 'harness', ${String(Date.now())}, 'harness-owner')`);
  /** Loop origins a caller named for a child, read by the host at first acquire. */
  const chosen = new Map<string, LoopOrigin>();
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: 'harness-owner' });
  const mainHandle = directory.createMain({ name: 'harness' });
  const main = actorReferenceOf(mainHandle);

  // Real workspace host; `ctx` comes from `actor-harness.ts` so there is one answer to which platform members an actor reaches.
  const ctx = makeCtx(db, workspaceId);
  // Shared with `actor-harness.ts`: one source of truth for which bindings an actor may reach.
  const env = makeEnv();

  // Both optional deps are answered, not cast: a workspace with no signing key has no preview URL.
  const workspace = createHostedWorkspace({
    ctx, env,
    previewUrl: (port) => Promise.resolve({ unavailable: `port ${String(port)} has no preview host in this fixture` }),
    onFilesChanged: () => undefined,
    ensureSlate: () => Promise.resolve(null),
  });

  // Main is acquired up front; its runtime answers `rootRuntime`, as production answers with the root's own runtime.
  let rootRuntime: AgentRuntime | null = null;

  const seams: WorkspaceHostSeams = {
    env,
    ctx,
    agent: {
      name: 'harness',
      // The SDK's `Agent.sql` protocol: a tagged template bound positionally, as the DO SQL API implements.
      sql: <Row = Record<string, string | number | boolean | null>>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ): Row[] => db.prepare<Row, (string | number | boolean | null)[]>(strings.join('?')).all(...values),
      // Runs inline, handing the body a real context so `stash` is callable.
      runFiber: (name, body) => body({
        id: `fiber:${name}`,
        signal: new AbortController().signal,
        stash: () => undefined,
        snapshot: null,
      }),
    },
    workspaceBox: (shellId) => workspace.box(shellId),
    homeHost: () => workspace.bundle.privileged()
      .then((privileged) => ({ ...privileged, sql: ctx.storage.sql })),
    sql,
    exec,
    directory,
    // The registered workspace name, never a child's: a self-named child derives a second empty filesystem.
    workspaceName: 'harness',
    rootRuntime: () => {
      if (rootRuntime === null) throw new Error('the harness root runtime is not ready');

      return rootRuntime;
    },
    installedBuild: () => 'harness-build',
    ownerUserId: () => 'harness-owner',
    capabilityToken: () => 'harness-token',
    resolveProfile: () => Promise.resolve(fixtureProfile()),
    reportModelCall: () => undefined,
    modelOperations: () => undefined,
    pricing: () => null,
    broadcast: () => undefined,
    turnClaimChanged: () => undefined,
    enqueueTurn: () => Promise.resolve({ status: 'queued' }),
    turnInFlight: () => false,
    setTimer: () => undefined,
    reconcileDurableWake: () => undefined,
    logActivity: () => undefined,
    slate: () => Promise.resolve({ ok: false, reason: 'unavailable', error: 'no slate host in this fixture' }),
    deferrals: () => undefined,
    refinementLane: () => () => Promise.resolve(),
    chosenLoopOrigin: (record) => chosen.get(record.actorId) ?? null,
    chosenWriteObserver: () => null,
    ...overrides,
  };

  const host = createWorkspaceActorHost(seams);
  rootRuntime = (await host.acquire(main)).runtime;

  return {
    db, sql, exec, host, directory, main,
    hire: async (parent, name, kind, loop) => {
      const parentHandle = directory.open(parent.actorId);

      const handle = directory.create({
        parent: parentHandle, name, creationId: name,
        kind: kind === 'main' ? 'subordinate' : kind,
        lifetime: kind === 'subordinate' ? 'durable' : 'task',
      });

      if (loop) chosen.set(handle.actorId, loop);

      return await host.acquire(actorReferenceOf(handle));
    },
    tables: () => db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).all().map((row) => row.name),
  };
}
