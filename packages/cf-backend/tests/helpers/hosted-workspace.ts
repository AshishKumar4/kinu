/**
 * ONE database, five actors — the fixture that makes open-38 checkable.
 *
 * Deliberately small: it opens exactly ONE `bun:sqlite` database, builds
 * exactly ONE `ActorHost` over it, and acquires every actor from that host.
 * There is no second `Database` in the file, so "one physical workspace SQLite
 * for every logical actor" is not asserted, it is the only shape the fixture
 * can express — and `databasesOpened()` is the witness that stays true only
 * while that holds.
 *
 * A fixture that stood the actors up itself would have to SIMULATE a per-actor
 * database: a `subAgent` interception that hands a spawner a real child object,
 * a `parentPath` override so the SDK's lineage matches, a second
 * `Database(':memory:')` per child, a `FacetIdentity` seed so the child could
 * read its own name back. One that fakes facet storage cannot witness one
 * database serving every actor, it can only agree with whichever side it was
 * built for.
 */

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

/** Every `Database` this module has opened, in order. The test asserts its
 *  LENGTH, which is what turns "one database" from a claim into a measurement:
 *  a helper that quietly opened a second one for a child would fail here before
 *  any per-actor assertion had a chance to pass over it. */
const opened: Database[] = [];

export function databasesOpened(): readonly Database[] {
  return opened;
}

export function resetDatabases(): void {
  for (const db of opened) db.close();
  opened.length = 0;
}

/**
 * The two executor shapes the stack takes over ONE `bun:sqlite` handle, from
 * the constructors that already own them.
 *
 * Both are needed and they are genuinely different protocols: the stores take a
 * tagged template (`SqlExecutor`), while the event log, the archive reader and
 * the restorer compose the statements they run and take the positional
 * `SqlExec`. Same database either way — which is the only property these
 * fixtures exist to hold.
 *
 * Named re-exports of core's test helpers rather than wrappers, so a caller
 * reads the same two functions the rest of the repo does. `makeSqlExec`
 * performs the Durable Object BLOB normalization (the platform answers an
 * ArrayBuffer, `bun:sqlite` a Uint8Array) and `sqlOver` is the tag every
 * actor-backed suite already binds through. A private re-derivation here would
 * be a second answer to a question core's test helpers answer, and the file's
 * single largest source of type assertions.
 */
export const harnessExec: (db: Database) => SqlExec = makeSqlExec;
export const harnessSql: (db: Database) => SqlExecutor = sqlOver;

export interface HostedWorkspaceFixture {
  readonly db: Database;
  readonly sql: SqlExecutor;
  /** The raw positional executor the archive reader takes — a different shape
   *  from the tagged-template one, because it composes the statements it runs. */
  readonly exec: SqlExec;
  readonly host: ActorHost;
  readonly directory: WorkspaceActorDirectory;
  readonly main: ActorReference;
  /** Register one child of `parent` and acquire it from the host. */
  hire(parent: ActorReference, name: string, kind: WorkspaceActor['kind'], loop?: LoopOrigin): Promise<HostedActor>;
  /** Every table name in the one database, for the `sqlite_master` witness. */
  tables(): readonly string[];
}

/**
 * THE authority inputs every hosted turn in this fixture resolves against: the
 * builtin catalog, digested by the same function the authority validates the
 * envelope with, and a one-model provider listing.
 *
 * Fixed rather than varying, because what these tests measure is which PROGRAM
 * ran and which claim recorded it, and a profile that changed per call would
 * make a digest assertion depend on a model choice nothing here is about.
 */
const FIXTURE_AUTHORITY: ProfileAuthorityInputs = {
  envelope: {
    authority: { kind: 'local' },
    version: 0,
    digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG),
    catalog: BUILTIN_PROFILE_CATALOG,
  },
  provider: { revision: 'hosted-workspace-fixture', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
};

/**
 * The profile every hosted turn in this fixture resolves under, RESOLVED by the
 * production authority rather than described.
 *
 * A claim recorded against a profile the authority never produced cannot
 * witness anything about which profile a turn ran under, so the authority
 * produces this one. An object literal asserted into `ResolvedTurnProfile`
 * instead buys nothing and hides its own field errors, because the assertion is
 * there to stop the compiler from looking: a `role` carrying a `tools` member
 * the type has no room for, a `tier` missing `source`, a `providerRevision`
 * number where the contract declares a string.
 */
export function fixtureProfile() {
  return {
    profile: resolveTurnProfile({
      ...FIXTURE_AUTHORITY,
      roleId: 'general',
      workMode: 'build',
      availableTools: [],
      activeSkills: [],
    }),
    inputs: FIXTURE_AUTHORITY,
  };
}

/**
 * Open the one database, initialise the workspace schema on it, and build the
 * one host.
 *
 * `seams` members that reach real infrastructure — the Nimbus box, the home
 * registry, the provider registry — are supplied by the caller, because a test
 * that needs a file plane needs a real one and a test that does not must not
 * pay for it. Everything actor-shaped is genuine: the directory, the host, the
 * per-actor stores and every claim they write.
 */
export async function hostedWorkspace(
  overrides: Partial<WorkspaceHostSeams> = {},
): Promise<HostedWorkspaceFixture> {
  const db = new Database(':memory:');
  opened.push(db);
  const sql = harnessSql(db);
  const workspaceId = 'harness-workspace';
  const exec = harnessExec(db);
  initWorkspaceSchema({ execRaw: makeExecRaw(db), sql, exec });
  db.exec(`INSERT INTO workspace_identity (id, name, created_at, owner_user_id)
    VALUES ('${workspaceId}', 'harness', ${String(Date.now())}, 'harness-owner')`);
  /** Loop origins a caller NAMED for a child, read back by the host at first
   *  acquire. Declared before the seams that close over it. */
  const chosen = new Map<string, LoopOrigin>();
  const directory = new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: 'harness-owner' });
  const mainHandle = directory.createMain({ name: 'harness' });
  const main = actorReferenceOf(mainHandle);

  // The REAL workspace host, over the SAME one database. Not a fake box: a
  // fixture that stubbed the file plane could not witness a hosted actor's
  // writes landing under its own uid on the shared tree, which is half of what
  // this fixture exists to hold.
  //
  // `ctx` is the one platform surface bun cannot provide — a Durable Object
  // state — and it comes from `actor-harness.ts` rather than being narrowed
  // again here. A second literal was a second answer to "which platform members
  // does a constructed actor reach", and it was already the thinner one: it
  // carried `sql` and `transactionSync` and nothing else, so the key-value
  // storage the SDK records lineage in, the alarm slots and
  // `blockConcurrencyWhile` were all absent, and any host path that reached one
  // would have failed as a missing member rather than as the behaviour under
  // test. Named for the registered workspace, which is what `ctx.id.toString()`
  // answers to everything that files a row under an agent id.
  const ctx = makeCtx(db, workspaceId);
  // THE env builder, shared with `actor-harness.ts` rather than re-declared
  // here. A second copy is a second source of truth about which bindings a
  // constructed actor may reach, and the two would drift the moment one of them
  // needed a binding the other did not have — the same reason a test helper must
  // not declare a table a production initializer owns.
  const env = makeEnv();
  // Both optional deps are ANSWERED, not cast past: `previewUrl` answers a
  // PROMISE of a preview verdict and `refreshPreview` a promise of void, and an
  // `as never` over them hides a signature mismatch nothing here would surface,
  // because nothing here exposes a port. A workspace with no signing key
  // genuinely has no preview URL, and `unavailable` is how the contract says so.
  const workspace = createHostedWorkspace({
    ctx, env,
    previewUrl: (port) => Promise.resolve({ unavailable: `port ${String(port)} has no preview host in this fixture` }),
    onFilesChanged: () => undefined,
    refreshPreview: () => Promise.resolve(),
  });

  // Main is acquired up front, and its runtime is what `rootRuntime` answers:
  // inheritance consumes the parent's DURABLE state (its handle, its store,
  // its files), and the workspace root always has all three without being
  // "hosted" through an acquire of its own — production answers the same seam
  // with the root object's own runtime. A child released test below proves an
  // unhosted main still seeds, by releasing this handle again first.
  let rootRuntime: AgentRuntime | null = null;
  const seams: WorkspaceHostSeams = {
    env,
    ctx,
    agent: {
      name: 'harness',
      // The SDK's own `Agent.sql` signature, over this one handle: a tagged
      // template bound positionally, which is the protocol the Durable Object
      // SQL API implements.
      sql: <Row = Record<string, string | number | boolean | null>>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ): Row[] => db.prepare<Row, (string | number | boolean | null)[]>(strings.join('?')).all(...values),
      // A fiber that runs inline. The row bookkeeping the SDK does around one is
      // `agents-sdk.ts`'s business and no host path here reads it back; what the
      // body IS handed is a real context, so a lane that stashed a checkpoint
      // gets a callable `stash` rather than a member access on undefined.
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
    // The REGISTERED workspace name — the `workspace_identity` row above —
    // never a child's own: a self-named child derives a second empty
    // filesystem, so defaulting this would hide exactly the bug the fork
    // suite pins.
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
    enqueueTurn: () => Promise.resolve({ status: 'queued' }),
    turnInFlight: () => false,
    setTimer: () => undefined,
    reconcileDurableWake: () => undefined,
    headRuntimeFor: () => undefined,
    logActivity: () => undefined,
    // A refusal in the shape every slate caller already reads — `ok: false`
    // with a classified reason — rather than an absence they would have to
    // special-case.
    slate: () => Promise.resolve({ ok: false, reason: 'unavailable', error: 'no slate host in this fixture' }),
    deferrals: () => undefined,
    refinementLane: () => () => Promise.resolve(),
    chosenLoopOrigin: (record) => chosen.get(record.actorId) ?? null,
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
