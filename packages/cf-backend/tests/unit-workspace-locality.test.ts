/**
 * WHERE THE HOSTED WORKSPACE'S BYTES LIVE.
 *
 * This is the executable form of the requirement the 2026-08-12 ask made, and
 * the only form of it CI can check: Nimbus is a LIBRARY in the Durable Object
 * that owns the workspace, over that object's own `ctx.storage.sql`, and there
 * is no second object per workspace.
 *
 * Prose cannot hold that requirement. A commit message and a module header get
 * rewritten by the very commit that breaks them, and a harness can satisfy the
 * only runtime check (`if (!env.NIMBUS_SESSION) throw`) with an in-isolate fake
 * — which leaves every suite green while hosted workspaces create no filesystem
 * tables at all. So these tests assert the two things prose cannot:
 *
 *   1. A runtime built through `createCFRuntime` — the production factory, not a
 *      shim — creates the workspace filesystem's tables in the ACTOR's SQLite,
 *      and the memory index that reads those files is in the same database.
 *   2. The hosted composition never reads a workspace binding out of `env`. The
 *      env handed to the runtime here is a Proxy that throws on any property the
 *      test did not name, so a reintroduced `env.NIMBUS_SESSION` is a failure
 *      with that word in it rather than a silent second object.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { createHostedWorkspace, type HostedWorkspace } from '../src/workspace-host';
import { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { sqlOver } from '@kinu.run/test-utils';
import type { JsonValue } from '@kinu.run/core';
import type { Refusal } from '@kinu.run/core/obs';
import type { RouteableFacetTarget, SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** The filesystem binds BLOBs as ArrayBuffer; bun:sqlite binds only TypedArrays.
 *  Identical to the binder in unit-workspace-cwd.test.ts. */
function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

interface ActorObject {
  readonly database: Database;
  readonly ctx: DurableObjectState;
  tables(): string[];
  /** Every promise the object was asked to hold open, in order — a wake's
   *  background work, so a test can await what production only retains. */
  readonly held: Promise<unknown>[];
}

/**
 * One Durable Object's storage, as the platform gives it: a real SQLite database
 * with a real `transactionSync`.
 *
 * `transactionSync` is real and not a callback passthrough for the reason the
 * workspace's own options state — every atomic write in the filesystem rests on
 * it, and a fake turns each one into a torn write that reports success.
 */
function actorObject(): ActorObject {
  const database = new Database(':memory:');
  databases.push(database);

  const storage = {
    sql: {
      exec(query: string, ...bindings: SqlValue[]) {
        const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
        const bound = bindings.map(sqlBinding);

        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
        statement.run(...bound);

        return [];
      },
    },
    transactionSync: <T,>(closure: () => T): T => database.transaction(closure)(),
    // The key-value half, over a map of its own: the facet manager's launch
    // journal is listed on every composition, so a bare `get` is not enough.
    ...kvBackedStorage(new Map<string, JsonValue>()),
    deleteAll: async () => {},
    deleteAlarm: async () => {},
  };

  const held: Promise<unknown>[] = [];

  const context = {
    storage,
    id: { toString: () => 'locality-actor', name: 'locality-actor' },
    waitUntil: (promise: Promise<unknown>) => { held.push(promise); },
    getWebSockets: () => [],
    // The bag workerd hangs on `ctx`, reduced to the composed supervisor
    // entrypoint the hosted runtime requires before it composes.
    exports: { SupervisorRPC },
  };

  const partial: Partial<DurableObjectState> = {};
  Object.assign(partial, context);
  // SAFETY: the partial above is constructed with exactly the members
  // `createHostedWorkspace` reads; any other member access throws by name.
  const ctx = partial as DurableObjectState;

  return {
    database,
    ctx,
    held,
    tables: () => database
      .prepare<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name),
  };
}

/**
 * The key-value half of the actor's storage as the platform gives it, over one
 * Map: `list` and `transaction` are what the port-reservation records are
 * claimed inside, and `readPortExposure`/`registerPort` reach this object
 * unchanged through `programmaticHost`.
 */
function kvBackedStorage(kv: Map<string, JsonValue>) {
  const listRows = async (options: { prefix: string }): Promise<Map<string, JsonValue>> => {
    const entries = new Map<string, JsonValue>();

    for (const [key, value] of kv) {
      if (key.startsWith(options.prefix)) entries.set(key, value);
    }

    return entries;
  };

  return {
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: JsonValue) => { kv.set(key, value); },
    delete: async (key: string) => { kv.delete(key); },
    list: listRows,
    transaction: async <T,>(body: (txn: {
      get(key: string): Promise<JsonValue | undefined>;
      put(key: string, value: JsonValue): Promise<void>;
      delete(key: string): Promise<boolean>;
      list(options: { prefix: string }): Promise<Map<string, JsonValue>>;
    }) => Promise<T>): Promise<T> => body({
      get: async (key) => kv.get(key),
      put: async (key, value) => { kv.set(key, value); },
      delete: async (key) => kv.delete(key),
      list: listRows,
    }),
    sync: async () => undefined,
  };
}

/**
 * An Env that answers only what it was told to, and names anything else.
 *
 * The point of the Proxy: a hosted workspace that reaches for a session binding
 * finds a throw carrying the property name, not a fake it can pass against, so
 * the failure says which binding came back.
 */
/**
 * EVERY binding a hosted workspace legitimately reads. The R2 runtime
 * catalogue, absent here, and the facet manager's: `LOADER`, which it
 * requires, and four optional knobs it reads once when composed. Each absent
 * one is an explicit `undefined` rather than missing, because "bound but
 * empty" and "not bound at all" are both states the readers handle and
 * neither is a session object.
 */
/** The facet manager reads its optional knobs off the raw env once when it
 *  is composed; Kinu binds none of them, so they are not `Env` members and
 *  this suite lists them only so the strict proxy answers the read. */
type NimbusKnob = 'NIMBUS_DEBUG' | 'NIMBUS_LAUNCH_CHUNK_BYTES' | 'NIMBUS_PROCESS_HOST';

function workspaceBindings(): Partial<Env> & Record<NimbusKnob, undefined> {
  // Unchecked and named: `WorkerLoader` is a workerd binding with no
  // constructible form; the manager reads `load` and `get`, and neither is
  // reached by a suite that spawns nothing.
  const LOADER: WorkerLoader = Object.create({
    load() { throw new Error('the hosted workspace loaded a dynamic worker'); },
    get() { throw new Error('the hosted workspace loaded a dynamic worker'); },
  });

  // The fabric's host namespace, read by the runtime at composition; no
  // facet in this suite dispatches through it.
  const OrchestratorAgent: Env['OrchestratorAgent'] = Object.create({
    get() { throw new Error('a facet dispatched through the host namespace'); },
    idFromName() { throw new Error('a facet dispatched through the host namespace'); },
    idFromString() { throw new Error('a facet dispatched through the host namespace'); },
  });

  return {
    NIMBUS_RUNTIME_CACHE: undefined,
    LOADER,
    ASSETS: undefined,
    OrchestratorAgent,
    NIMBUS_DEBUG: undefined,
    NIMBUS_LAUNCH_CHUNK_BYTES: undefined,
    NIMBUS_PROCESS_HOST: undefined,
  };
}

function strictEnv(bindings: Partial<Env> & Record<NimbusKnob, undefined>): Env {
  const held = new Map(Object.entries(bindings));

  const proxy = new Proxy({}, {
    get(_target, property: string) {
      if (held.has(property)) return held.get(property);
      throw new Error(`the hosted workspace read env.${property}, which this deployment does not bind`);
    },
    has: (_target, property: string) => held.has(property),
  });

  // SAFETY: the proxy is constructed to answer exactly the declared bindings
  // and to throw by name for every other member — the throw IS the assertion
  // this suite makes about which bindings a hosted workspace reads.
  return proxy as Env;
}

/** Where the listeners below run and what they are called: the identity the
 *  manager derives for a pid nothing journalled, from the process table. */
const SLATE_CWD = '/home/user/slates/a';

/**
 * A resident listening on `port`, the way the manager registers one: the pid
 * comes from the workspace's own process table, its facet stub is bound in
 * the registry, and the manager's `registerPort` decides against the port's
 * reservation whether the stored capability is re-adopted or retired. The
 * derived owner of `argv` under SLATE_CWD is the identity the reservation
 * must name for the capability to survive.
 */
async function listen(workspace: HostedWorkspace, port: number, argv: string[], target: RouteableFacetTarget): Promise<number> {
  const session = await workspace.bundle.session();
  const pid = session.processes.spawn('slate', argv, SLATE_CWD, { longRunning: true }).pid;
  (await workspace.ports()).bindFacetStub(pid, target);
  await (await workspace.facetManager()).manager.registerPort(pid, port);

  return pid;
}

/**
 * The owner the manager derives for `argv` under SLATE_CWD, read off the
 * manager itself: a probe process is spawned exactly as `listen` spawns a
 * listener, its identity is asked for, and it is ended. The reservation a
 * test seeds must name this identity for the capability to survive.
 */
async function derivedOwner(workspace: HostedWorkspace, argv: string[]): Promise<string> {
  const session = await workspace.bundle.session();
  const probe = session.processes.spawn('slate', argv, SLATE_CWD, { longRunning: true });
  const identity = await (await workspace.facetManager()).manager.residentIdentity(probe.pid);
  session.processes.kill(probe.pid);

  if (identity?.owner === undefined) throw new Error('the manager derived no owner for the probe process');

  return identity.owner;
}

describe('the hosted workspace lives in the actor Durable Object', () => {
  test('a first file operation creates the Nimbus filesystem in ctx.storage.sql', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    // Nothing has been asked of the workspace yet, so nothing but the generation
    // counter exists: the bundle opens on its first operation, which is what
    // keeps an activation that never touches a file from paying for one.
    expect(actor.tables()).toEqual(['kinu_workspace_generation']);

    await workspace.bundle.vfs.writeFile('memory/MEMORY.md', 'the bytes are here\n');

    const tables = actor.tables();

    // The exact namespace the library commits to owning inside a host's
    // database — the set `NimbusWorkspace.destroy()` drops, and the set the
    // conformance manifest declares for this root.
    for (const table of [
      'inodes', 'file_chunks', 'content_lifecycle', 'vfs_schema_migrations',
      'kinu_workspace_generation',
    ]) {
      expect(tables).toContain(table);
    }

    expect(await workspace.bundle.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' }))
      .toBe('the bytes are here\n');
  });

  test('the shell and the file plane are two views of the same rows', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.mkdir('proof', { recursive: true });
    await workspace.bundle.vfs.writeFile('proof/from-vfs.txt', 'same bytes');

    // The box's exec is the programmatic session over the SAME workspace, in a
    // named durable shell — the production seam, not `bundle.shell`.
    const box = workspace.box('agent:main');
    expect(await box.exec('cat proof/from-vfs.txt')).toMatchObject({
      stdout: 'same bytes',
      exitCode: 0,
    });
    expect(await box.exec('printf %s "from the shell" > proof/from-shell.txt'))
      .toMatchObject({ exitCode: 0 });
    expect(await workspace.bundle.vfs.readFile('proof/from-shell.txt', { encoding: 'utf8' }))
      .toBe('from the shell');

    // And the box's own file surface reads the same rows, in the session's
    // absolute paths — this is what `nimbusSessionFiles` binds.
    expect(await box.files.read('/home/user/proof/from-shell.txt')).toBe('from the shell');
    expect(await box.files.exists('/home/user/proof/from-vfs.txt')).toBe(true);
  });

  test('a named durable shell keeps its own cwd, and siblings do not see it', async () => {
    const actor = actorObject();
    const shellState = new Map<string, JsonValue>();
    const storage = actor.ctx.storage;
    Object.assign(storage, {
      get: async (key: string) => shellState.get(key),
      put: async (key: string, value: JsonValue) => { shellState.set(key, value); },
    });

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.mkdir('alpha', { recursive: true });
    await workspace.bundle.vfs.mkdir('beta', { recursive: true });

    const alpha = workspace.box('subordinate:alpha');
    const beta = workspace.box('head:beta');
    expect(await alpha.exec('cd /home/user/alpha')).toMatchObject({ exitCode: 0 });
    expect(await alpha.exec('pwd')).toMatchObject({ stdout: '/home/user/alpha\n' });
    expect(await beta.exec('pwd')).toMatchObject({ stdout: '/home/user\n' });
  });

  test('the workspace never reads a session binding out of env', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      // Only the runtime catalogue bucket is legitimately read, and this
      // deployment binds none — so EVERY property access throws by name.
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.writeFile('proof.txt', 'no binding was read');
    expect(await workspace.box('agent:main').exec('cat proof.txt'))
      .toMatchObject({ stdout: 'no binding was read', exitCode: 0 });
  });

  /**
   * The split this closes, as an assertion.
   *
   * MemoryStore keeps its FTS5 index in the ACTOR's SQLite, in the same database
   * as the markdown it indexes. Holding the bytes in a second Durable Object
   * lets a partial failure diverge the index from them, and neither object can
   * be snapshotted consistently with the other. One database means one
   * transaction boundary.
   */
  test('the memory index and the bytes it indexes are in one database', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    const store = new MemoryStore(workspace.bundle.vfs, sqlOver(actor.database));
    store.ensureSchema();
    // The store's own write: the bytes go to the workspace filesystem and the
    // chunks to the index, which is the pairing under test.
    await store.writeFile('memory/MEMORY.md', '# Notes\n\nthe indexed bytes\n');
    await store.indexFile('memory/MEMORY.md', '# Notes\n\nthe indexed bytes\n');

    const tables = actor.tables();
    // The bytes...
    expect(tables).toContain('inodes');
    expect(tables).toContain('file_chunks');
    // ...and the index over them, in the same SQLite.
    expect(tables).toContain('memory_chunks');
    expect(store.search('indexed bytes', 5)).not.toHaveLength(0);
    expect(await workspace.bundle.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' }))
      .toContain('the indexed bytes');
  });

  test('destroy drops the filesystem tables and leaves the actor rows alone', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    actor.ctx.storage.sql.exec('CREATE TABLE actor_rows (id INTEGER PRIMARY KEY)');
    actor.ctx.storage.sql.exec('INSERT INTO actor_rows (id) VALUES (1)');
    await workspace.bundle.vfs.writeFile('doomed.txt', 'bytes');
    expect(actor.tables()).toContain('inodes');

    await workspace.destroy();

    expect(actor.tables()).not.toContain('inodes');
    expect(actor.tables()).toContain('actor_rows');
  });

  test('one transient boot failure does not poison the isolate', async () => {
    const actor = actorObject();
    // One armed failure at the storage seam, then a healthy database: the
    // shape a transient DO storage error leaves. The pre-fix caches held the
    // rejection at three layers, so every retry re-awaited the same corpse
    // while resetting the eviction timer that was the only recovery path.
    const realExec = actor.ctx.storage.sql.exec.bind(actor.ctx.storage.sql);
    let failures = 0;
    Object.assign(actor.ctx.storage.sql, {
      exec: (query: string, ...bindings: SqlValue[]) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('transient storage failure');
        }

        return realExec(query, ...bindings);
      },
    });

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    // Armed AFTER construction: the boot is lazy, so the first operation is
    // what meets the failure.
    failures = 1;
    await expect(workspace.bundle.vfs.exists('SOUL.md')).rejects.toThrow(/transient storage failure/);
    // The SAME workspace object, retried: the boot re-attempts instead of
    // re-awaiting the cached rejection.
    await workspace.bundle.vfs.writeFile('recovered.txt', 'alive');
    expect(await workspace.bundle.vfs.readFile('recovered.txt', { encoding: 'utf8' })).toBe('alive');
  });

  test('a durable URL re-drives its owner before routing; unknown and forged links stay 404', async () => {
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, kvBackedStorage(kv));

    const redriven: string[] = [];
    let refusal: Refusal | null = null;

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
      ensureSlate: async (owner) => {
        redriven.push(owner);

        return refusal;
      },
    });

    const capability = 'abcdef0123456789abcdef01';
    kv.set('nimbus_preview_capability:3000', { capability, owner: 'slate-a' });

    // An owned URL names its slate: the owner is re-driven before the route,
    // and with nothing listening after that, Nimbus's own answer is the 404.
    const routed = await workspace.routePreview(
      3000, capability.slice(0, 10), new Request('https://preview.test/'), '/',
    );

    expect(routed.status).toBe(404);
    expect(redriven).toEqual(['slate-a']);

    const unknown = await workspace.routePreview(
      3001, 'ffffffffff', new Request('https://preview.test/'), '/',
    );

    expect(unknown.status).toBe(404);

    // And a handle that does not match the persisted capability is a plain
    // 404 too — a forged link never re-drives anything.
    const forged = await workspace.routePreview(
      3000, 'ffffffffff', new Request('https://preview.test/'), '/',
    );

    expect(forged.status).toBe(404);
    expect(redriven).toEqual(['slate-a']);

    // An owner whose tree is gone refuses `missing`, which is the 404 the URL
    // answers; every other refusal is a retryable 503 carrying it verbatim.
    refusal = { reason: 'missing', error: 'gone' };
    expect((await workspace.routePreview(
      3000, capability.slice(0, 10), new Request('https://preview.test/'), '/',
    )).status).toBe(404);

    refusal = { reason: 'bad_input', error: 'compile failed' };

    const refused = await workspace.routePreview(
      3000, capability.slice(0, 10), new Request('https://preview.test/'), '/',
    );

    expect(refused.status).toBe(503);
    expect(v.parse(v.object({ reason: v.string(), error: v.string() }), await refused.json()))
      .toEqual({ reason: 'bad_input', error: 'compile failed' });
    expect(redriven).toEqual(['slate-a', 'slate-a', 'slate-a']);
  });

  test('a live slate preview refreshes authored code without accepting a visitor invocation id', async () => {
    const actor = actorObject();
    const capability = 'abcdef0123456789abcdef01';
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, kvBackedStorage(kv));
    let source = 'old';

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ url: 'https://preview.test/' }),
      ensureSlate: async () => {
        source = 'edited';

        return null;
      },
    });

    kv.set('nimbus_preview_capability:3000', { capability, owner: await derivedOwner(workspace, ['a']) });

    const pid = await listen(workspace, 3000, ['a'], {
      handleHttpRequest: async (request) => Response.json({ source, invocation: request.headers.get('x-slate-call') }),
    });

    const response = await workspace.routePreview(3000, capability.slice(0, 10), new Request('https://preview.test/', {
      headers: { 'x-slate-call': 'forged-invocation' },
    }), '/');

    expect(v.parse(v.object({ source: v.string(), invocation: v.nullable(v.string()) }), await response.json()))
      .toEqual({ source: 'edited', invocation: null });
    (await workspace.facetManager()).manager.kill(pid);
    expect((await workspace.routePreview(3000, capability.slice(0, 10), new Request('https://preview.test/'), '/')).status).toBe(404);
  });

  test('a preview request runs under an invocation the host names and then releases', async () => {
    const actor = actorObject();
    const capability = 'abcdef0123456789abcdef01';
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, kvBackedStorage(kv));
    const released: string[] = [];

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ url: 'https://preview.test/' }),
      ensureSlate: async () => null,
      slateInvocation: (port) => ({ value: `minted-${String(port)}`, release: () => { released.push(`minted-${String(port)}`); } }),
    });

    kv.set('nimbus_preview_capability:3000', { capability, owner: await derivedOwner(workspace, ['a']) });

    const pid = await listen(workspace, 3000, ['a'], {
      handleHttpRequest: async (request) => Response.json({ invocation: request.headers.get('x-slate-call') }),
    });

    // The visitor's forged value is dropped and the host's own name replaces it,
    // so bindings kept from this request stop resolving the moment it settles.
    const response = await workspace.routePreview(3000, capability.slice(0, 10), new Request('https://preview.test/', {
      headers: { 'x-slate-call': 'forged-invocation' },
    }), '/');

    expect(v.parse(v.object({ invocation: v.nullable(v.string()) }), await response.json()))
      .toEqual({ invocation: 'minted-3000' });
    expect(released).toEqual(['minted-3000']);
    (await workspace.facetManager()).manager.kill(pid);
  });

  test('a durable URL follows its owner across activations and never a different one', async () => {
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, kvBackedStorage(kv));

    const activate = () => createHostedWorkspace({
      ctx: actor.ctx, env: strictEnv(workspaceBindings()),
      previewUrl: async (_port, capability) => ({ url: 'https://preview.test/' + capability }),
    });

    // The reservation is the slate host's act: an owner declares its port and
    // is handed the capability its URL carries, before any process binds it.
    // The owner is the identity the manager derives for the listener below.
    const first = activate();
    const ownerA = await derivedOwner(first, ['A']);
    const app = await first.apps.ensure({ owner: ownerA, preferredPort: 20000 });
    expect(app.port).toBe(20000);
    const handle = app.capability.slice(0, 10);
    await listen(first, 20000, ['A'], { handleHttpRequest: async () => new Response('caller A') });
    expect(await (await first.routePreview(20000, handle, new Request('https://preview.test/'), '/')).text()).toBe('caller A');
    // A new activation rebuilds the same owner at the same port: the
    // reservation names that owner, so its registration re-adopts the stored
    // capability and the URL answers again.
    const sameOwner = activate();
    await listen(sameOwner, 20000, ['A'], { handleHttpRequest: async () => new Response('caller A rebuilt') });
    expect(await (await sameOwner.routePreview(20000, handle, new Request('https://preview.test/'), '/')).text()).toBe('caller A rebuilt');
    // Another identity binding the port registers ephemeral: the stored
    // capability is retired, so the URL answers nothing of B's.
    const differentOwner = activate();
    await listen(differentOwner, 20000, ['B'], { handleHttpRequest: async () => new Response('caller B private data') });
    const refused = await differentOwner.routePreview(20000, handle, new Request('https://preview.test/'), '/');
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain('caller B private data');
    // A third identity is refused it the same way: the reservation still
    // names A, and the URL answers nothing until A binds again.
    const ordinary = activate();
    await listen(ordinary, 20000, ['Z'], { handleHttpRequest: async () => new Response('ordinary port') });
    expect((await ordinary.routePreview(20000, handle, new Request('https://preview.test/'), '/')).status).toBe(404);
  });

  test('a launch a hibernation interrupted is re-driven through the slate host on the next wake', async () => {
    // VENDOR-FORMAT COUPLING: the journal row seeded below copies worker 0.7's
    // own `resident-launch:<n>` recipe shape. A worker that changes the row
    // shape makes the manager ignore the row and this test fail — the right
    // direction, and the one place to update when the vendor moves.
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, kvBackedStorage(kv));
    // The row the previous incarnation's manager journalled for a slate's
    // durable application, exactly as `spawnWorker` writes it: a pid of a
    // generation below this wake's floor, the recipe with no interpreter
    // resident — an embedder's own worker launch, which re-drives through the
    // embedder — and the launch still in flight when the object went away.
    kv.set('resident-launch:41', {
      pid: 41, command: 'slate keeper', attempt: 0, phase: 'starting', owner: 'keeper', restart: 'never', port: 20000,
      recipe: {
        kind: 'worker', owner: 'keeper', port: 20000, cwd: '/home/user/slates/keeper', mainModule: 'runner.js',
        image: { runner: 'a'.repeat(64), application: 'b'.repeat(64) }, compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'],
      },
    });
    const redriven: string[] = [];

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
      ensureSlate: async (owner) => {
        redriven.push(owner);

        return null;
      },
    });

    // The wake: composing the manager is what drains the journal's recovery,
    // and every background turn it started is held by the object.
    await workspace.facetManager();

    while (actor.held.length > 0) await Promise.all(actor.held.splice(0));

    expect(redriven).toEqual(['keeper']);
    // The row this re-drive was owed on is released: the slate host's own boot
    // journals the launch it made under a fresh pid.
    expect(kv.has('resident-launch:41')).toBe(false);
  });
});
