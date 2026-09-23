/**
 * Nimbus is a library in the Durable Object that owns the workspace, over its own `ctx.storage.sql`; no second
 * object per workspace. Built via `createCFRuntime`; env is a Proxy that throws on any unnamed binding.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createHostedWorkspace, type HostedWorkspace, type HostedWorkspaceEnv } from '../src/workspace-host';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { sqlOver } from '@kinu.run/test-utils';
import type { JsonValue } from '@kinu.run/core';
import type { Refusal } from '@kinu.run/core/obs';
import type { RouteableFacetTarget, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { actorObjectState, durableObjectStorage, durableSqlStorage, durableStorage, SCRIPT_EXPORTS } from './helpers/programmatic-host';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});



interface ActorObject {
  readonly database: Database;
  readonly ctx: DurableObjectState;
  tables(): string[];
  /** Promises the object was asked to hold open, so a test can await what production only retains. */
  readonly held: Promise<unknown>[];
}

/**
 * Real SQLite with a real `transactionSync`: every atomic filesystem write rests on it, and a fake turns each
 * into a torn write that reports success. Other `ctx` members refuse by name (`actorObjectState`).
 */
function actorObject(): ActorObject {
  const database = new Database(':memory:');
  databases.push(database);
  const held: Promise<unknown>[] = [];

  const ctx = actorObjectState({
    id: { toString: () => 'locality-actor', equals: () => false, name: 'locality-actor' },
    storage: durableObjectStorage({
      ...durableStorage(new Map()),
      sql: durableSqlStorage(database),
      transactionSync: <T,>(closure: () => T): T => database.transaction(closure)(),
    }),
    waitUntil: (promise: Promise<unknown>) => { held.push(promise); },
    getWebSockets: () => [],
    exports: SCRIPT_EXPORTS,
  });

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

/** Every binding a hosted workspace reads; the loader and host namespace refuse, since this suite spawns nothing. */
function workspaceBindings(): HostedWorkspaceEnv<string> {
  const spawned = (): never => { throw new Error('the hosted workspace loaded a dynamic worker'); };

  const dispatched = (): never => { throw new Error('a facet dispatched through the host namespace'); };

  // `load` is checked beside `get`; the platform's `WorkerLoader` declaration omits it.
  const LOADER = Object.assign({ get: spawned }, { load: spawned });

  return {
    NIMBUS_RUNTIME_CACHE: undefined,
    ASSETS: undefined,
    LOADER,
    OrchestratorAgent: { get: dispatched, idFromName: dispatched, idFromString: dispatched },
  };
}

const SLATE_CWD = '/home/main/slates/a';

async function listen(workspace: HostedWorkspace, port: number, argv: string[], target: RouteableFacetTarget): Promise<number> {
  const session = await workspace.bundle.session();
  const pid = session.processes.spawn('slate', argv, SLATE_CWD, { longRunning: true }).pid;
  (await workspace.ports()).bindFacetStub(pid, target);
  await (await workspace.facetManager()).manager.registerPort(pid, port);

  return pid;
}

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
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    // The bundle opens on its first operation, so an activation that touches no file pays for none.
    expect(actor.tables()).toEqual(['kinu_workspace_generation']);

    await workspace.bundle.vfs.writeFile('memory/MEMORY.md', 'the bytes are here\n');

    const tables = actor.tables();

    // The namespace `NimbusWorkspace.destroy()` drops and the conformance manifest declares for this root.
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
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.mkdir('proof', { recursive: true });
    await workspace.bundle.vfs.writeFile('proof/from-vfs.txt', 'same bytes');

    const box = workspace.box('agent:main');
    expect(await box.exec('cat proof/from-vfs.txt')).toMatchObject({
      stdout: 'same bytes',
      exitCode: 0,
    });
    expect(await box.exec('printf %s "from the shell" > proof/from-shell.txt'))
      .toMatchObject({ exitCode: 0 });
    expect(await workspace.bundle.vfs.readFile('proof/from-shell.txt', { encoding: 'utf8' }))
      .toBe('from the shell');

    expect(await box.files.read('/home/main/proof/from-shell.txt')).toBe('from the shell');
    expect(await box.files.exists('/home/main/proof/from-vfs.txt')).toBe(true);
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
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.mkdir('alpha', { recursive: true });
    await workspace.bundle.vfs.mkdir('beta', { recursive: true });

    const alpha = workspace.box('subordinate:alpha');
    const beta = workspace.box('head:beta');
    expect(await alpha.exec('cd /home/main/alpha')).toMatchObject({ exitCode: 0 });
    expect(await alpha.exec('pwd')).toMatchObject({ stdout: '/home/main/alpha\n' });
    expect(await beta.exec('pwd')).toMatchObject({ stdout: '/home/main\n' });
  });

  test('the workspace never reads a session binding out of env', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      // Only the runtime catalogue bucket may be read, and none is bound here.
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.writeFile('proof.txt', 'no binding was read');
    expect(await workspace.box('agent:main').exec('cat proof.txt'))
      .toMatchObject({ stdout: 'no binding was read', exitCode: 0 });
  });

  /** One database, one transaction boundary: the FTS5 index lives beside the markdown it indexes. */
  test('the memory index and the bytes it indexes are in one database', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    const store = new MemoryStore(workspace.bundle.vfs, sqlOver(actor.database));
    store.ensureSchema();
    await store.writeFile('memory/MEMORY.md', '# Notes\n\nthe indexed bytes\n');
    await store.indexFile('memory/MEMORY.md', '# Notes\n\nthe indexed bytes\n');

    const tables = actor.tables();
    expect(tables).toContain('inodes');
    expect(tables).toContain('file_chunks');
    expect(tables).toContain('memory_chunks');
    expect(store.search('indexed bytes', 5)).not.toHaveLength(0);
    expect(await workspace.bundle.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' }))
      .toContain('the indexed bytes');
  });

  test('destroy drops the filesystem tables and leaves the actor rows alone', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: workspaceBindings(),
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
    // One armed failure at the storage seam, then a healthy database: a cached rejection must not be re-awaited.
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
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    // Armed after construction: the boot is lazy.
    failures = 1;
    await expect(workspace.bundle.vfs.exists('SOUL.md')).rejects.toThrow(/transient storage failure/);
    await workspace.bundle.vfs.writeFile('recovered.txt', 'alive');
    expect(await workspace.bundle.vfs.readFile('recovered.txt', { encoding: 'utf8' })).toBe('alive');
  });

  test('a durable URL re-drives its owner before routing; unknown and forged links stay 404', async () => {
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));

    const redriven: string[] = [];
    let refusal: Refusal | null = null;

    const workspace = createHostedWorkspace({
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
      ensureSlate: async (owner) => {
        redriven.push(owner);

        return refusal;
      },
    });

    const capability = 'abcdef0123456789abcdef01';
    kv.set('nimbus_preview_capability:3000', { capability, owner: 'slate-a' });

    const routed = await workspace.routePreview(
      3000, capability.slice(0, 10), new Request('https://preview.test/'), '/',
    );

    expect(routed.status).toBe(404);
    expect(redriven).toEqual(['slate-a']);

    const unknown = await workspace.routePreview(
      3001, 'ffffffffff', new Request('https://preview.test/'), '/',
    );

    expect(unknown.status).toBe(404);

    // A forged handle never re-drives anything.
    const forged = await workspace.routePreview(
      3000, 'ffffffffff', new Request('https://preview.test/'), '/',
    );

    expect(forged.status).toBe(404);
    expect(redriven).toEqual(['slate-a']);

    // `missing` is the 404; every other refusal is a retryable 503 carrying it verbatim.
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
    Object.assign(actor.ctx.storage, durableStorage(kv));
    let source = 'old';

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: workspaceBindings(),
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
    Object.assign(actor.ctx.storage, durableStorage(kv));
    const released: string[] = [];

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: workspaceBindings(),
      previewUrl: async () => ({ url: 'https://preview.test/' }),
      ensureSlate: async () => null,
      slateInvocation: (port) => ({ value: `minted-${String(port)}`, release: () => { released.push(`minted-${String(port)}`); } }),
    });

    kv.set('nimbus_preview_capability:3000', { capability, owner: await derivedOwner(workspace, ['a']) });

    const pid = await listen(workspace, 3000, ['a'], {
      handleHttpRequest: async (request) => Response.json({ invocation: request.headers.get('x-slate-call') }),
    });

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
    Object.assign(actor.ctx.storage, durableStorage(kv));

    const activate = () => createHostedWorkspace({
      ctx: actor.ctx, env: workspaceBindings(),
      previewUrl: async (_port, capability) => ({ url: 'https://preview.test/' + capability }),
    });

    const first = activate();
    const ownerA = await derivedOwner(first, ['A']);
    const app = await first.apps.ensure({ owner: ownerA, preferredPort: 20000 });
    expect(app.port).toBe(20000);
    const handle = app.capability.slice(0, 10);
    await listen(first, 20000, ['A'], { handleHttpRequest: async () => new Response('caller A') });
    expect(await (await first.routePreview(20000, handle, new Request('https://preview.test/'), '/')).text()).toBe('caller A');
    const sameOwner = activate();
    await listen(sameOwner, 20000, ['A'], { handleHttpRequest: async () => new Response('caller A rebuilt') });
    expect(await (await sameOwner.routePreview(20000, handle, new Request('https://preview.test/'), '/')).text()).toBe('caller A rebuilt');
    const differentOwner = activate();
    await listen(differentOwner, 20000, ['B'], { handleHttpRequest: async () => new Response('caller B private data') });
    const refused = await differentOwner.routePreview(20000, handle, new Request('https://preview.test/'), '/');
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain('caller B private data');
    const ordinary = activate();
    await listen(ordinary, 20000, ['Z'], { handleHttpRequest: async () => new Response('ordinary port') });
    expect((await ordinary.routePreview(20000, handle, new Request('https://preview.test/'), '/')).status).toBe(404);
  });

  test('a launch a hibernation interrupted is re-driven through the slate host on the next wake', async () => {
    // Vendor-format coupling: the seeded journal row copies worker 0.7's `resident-launch:<n>` recipe shape;
    // update here when the vendor changes it.
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));
    kv.set('resident-launch:41', {
      pid: 41, command: 'slate keeper', attempt: 0, phase: 'starting', owner: 'keeper', restart: 'never', port: 20000,
      recipe: {
        kind: 'worker', owner: 'keeper', port: 20000, cwd: '/home/main/slates/keeper', mainModule: 'runner.js',
        image: { runner: 'a'.repeat(64), application: 'b'.repeat(64) }, compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'],
      },
    });
    const redriven: string[] = [];

    const workspace = createHostedWorkspace({
      ctx: actor.ctx, env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
      ensureSlate: async (owner) => {
        redriven.push(owner);

        return null;
      },
    });

    await workspace.facetManager();

    while (actor.held.length > 0) await Promise.all(actor.held.splice(0));

    expect(redriven).toEqual(['keeper']);
    expect(kv.has('resident-launch:41')).toBe(false);
  });
});
