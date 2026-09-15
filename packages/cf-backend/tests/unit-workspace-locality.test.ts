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
import { createHostedWorkspace } from '../src/workspace-host';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { sqlOver } from '@kinu.run/test-utils';
import type { JsonValue } from '@kinu.run/core';
import type { Refusal } from '@kinu.run/core/obs';
import type { SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';

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

  const context = {
    storage,
    id: { toString: () => 'locality-actor', name: 'locality-actor' },
    waitUntil: () => {},
    getWebSockets: () => [],
  };

  const partial: Partial<DurableObjectState> = {};
  Object.assign(partial, context);
  // SAFETY: the partial above is constructed with exactly the members
  // `createHostedWorkspace` reads; any other member access throws by name.
  const ctx = partial as DurableObjectState;

  return {
    database,
    ctx,
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
  const listRows = async <T,>(options: { prefix: string }): Promise<Map<string, T>> => {
    const entries = new Map<string, unknown>();

    for (const [key, value] of kv) {
      if (key.startsWith(options.prefix)) entries.set(key, value);
    }

    // SAFETY: the storage list contract types each row by the caller's T,
    // which the untyped stand-in rows cannot name; `never` keeps the Map
    // assignable to every T.
    return entries as Map<string, never>;
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
      list<T2 = unknown>(options: { prefix: string }): Promise<Map<string, T2>>;
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
function workspaceBindings(): Partial<Env> {
  // Unchecked and named: `WorkerLoader` is a workerd binding with no
  // constructible form; the manager reads `load` and `get`, and neither is
  // reached by a suite that spawns nothing.
  const LOADER: WorkerLoader = Object.create({
    load() { throw new Error('the hosted workspace loaded a dynamic worker'); },
    get() { throw new Error('the hosted workspace loaded a dynamic worker'); },
  });

  return {
    NIMBUS_RUNTIME_CACHE: undefined,
    LOADER,
    ASSETS: undefined,
    NIMBUS_DEBUG: undefined,
    NIMBUS_LAUNCH_CHUNK_BYTES: undefined,
    NIMBUS_PROCESS_HOST: undefined,
  };
}

function strictEnv(bindings: Partial<Env>): Env {
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
    kv.set('nimbus_preview_capability:3000', { capability, owner: 'slate-a' });
    let source = 'old';

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ url: 'https://preview.test/' }),
      ensureSlate: async () => {
        source = 'edited';

        return null;
      },
    });

    await workspace.registerPort(9000, 3000, {
      handleHttpRequest: async (request) => Response.json({ source, invocation: request.headers.get('x-slate-call') }),
    }, 'slate-a');

    const response = await workspace.routePreview(3000, capability.slice(0, 10), new Request('https://preview.test/', {
      headers: { 'x-slate-call': 'forged-invocation' },
    }), '/');

    expect(v.parse(v.object({ source: v.string(), invocation: v.nullable(v.string()) }), await response.json()))
      .toEqual({ source: 'edited', invocation: null });
    workspace.unregisterPorts(9000);
    expect((await workspace.routePreview(3000, capability.slice(0, 10), new Request('https://preview.test/'), '/')).status).toBe(404);
  });

  test('a preview request runs under an invocation the host names and then releases', async () => {
    const actor = actorObject();
    const capability = 'abcdef0123456789abcdef01';
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, kvBackedStorage(kv));
    kv.set('nimbus_preview_capability:3000', { capability, owner: 'slate-a' });
    const released: string[] = [];

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: strictEnv(workspaceBindings()),
      previewUrl: async () => ({ url: 'https://preview.test/' }),
      ensureSlate: async () => null,
      slateInvocation: (port) => ({ value: `minted-${String(port)}`, release: () => { released.push(`minted-${String(port)}`); } }),
    });

    await workspace.registerPort(9000, 3000, {
      handleHttpRequest: async (request) => Response.json({ invocation: request.headers.get('x-slate-call') }),
    }, 'slate-a');

    // The visitor's forged value is dropped and the host's own name replaces it,
    // so bindings kept from this request stop resolving the moment it settles.
    const response = await workspace.routePreview(3000, capability.slice(0, 10), new Request('https://preview.test/', {
      headers: { 'x-slate-call': 'forged-invocation' },
    }), '/');

    expect(v.parse(v.object({ invocation: v.nullable(v.string()) }), await response.json()))
      .toEqual({ invocation: 'minted-3000' });
    expect(released).toEqual(['minted-3000']);
    workspace.unregisterPorts(9000);
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
    const first = activate();
    const app = await first.apps.ensure({ owner: 'workspace/slate-A/caller-A', preferredPort: 20000 });
    expect(app.port).toBe(20000);
    const handle = app.capability.slice(0, 10);
    await first.registerPort(9000, 20000, { handleHttpRequest: async () => new Response('caller A') }, 'workspace/slate-A/caller-A');
    expect(await (await first.routePreview(20000, handle, new Request('https://preview.test/'), '/')).text()).toBe('caller A');
    // A new activation rebuilds the same owner at the same port: the
    // reservation names that owner, so its registration re-adopts the stored
    // capability and the URL answers again.
    const sameOwner = activate();
    await sameOwner.registerPort(9001, 20000, { handleHttpRequest: async () => new Response('caller A rebuilt') }, 'workspace/slate-A/caller-A');
    expect(await (await sameOwner.routePreview(20000, handle, new Request('https://preview.test/'), '/')).text()).toBe('caller A rebuilt');
    // First activity after another activation is call(B), not preview/expose(B).
    const differentOwner = activate();
    await differentOwner.registerPort(9002, 20000, { handleHttpRequest: async () => new Response('caller B private data') }, 'workspace/slate-A/caller-B');
    const refused = await differentOwner.routePreview(20000, handle, new Request('https://preview.test/'), '/');
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain('caller B private data');
    // A third owner registering on the port is refused it the same way: the
    // reservation still names slate-A's caller, so the stored capability is
    // retired and the URL answers nothing until that owner binds again.
    const ordinary = activate();
    await ordinary.registerPort(9003, 20000, { handleHttpRequest: async () => new Response('ordinary port') }, 'workspace/slate-Z');
    expect((await ordinary.routePreview(20000, handle, new Request('https://preview.test/'), '/')).status).toBe(404);
  });
});
