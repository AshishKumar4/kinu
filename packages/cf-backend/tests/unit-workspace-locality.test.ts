import { exists, readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Nimbus is a library in the Durable Object that owns the workspace, over its own `ctx.storage.sql`; no second
 * object per workspace. Built via `createCFRuntime`; env is a Proxy that throws on any unnamed binding.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createHostedWorkspace, type HostedWorkspace, type HostedWorkspaceEnv } from '../src/workspace-host';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { fakeMossaic, sqlOver } from '@kinu.run/test-utils';
import {
  agentCred, agentIdentity, mossaicVfs, provisionAgentHome, sharedDriveMount, workspaceSoul, workspaceFilePlane, WORKSPACE_ROOT,
  initWorkspaceActorTable, WORKSPACE_IDENTITY_DDL, writeWorkspaceSoul, type JsonValue,
} from '@kinu.run/core';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { Refusal } from '@kinu.run/core/obs';
import type { RouteableFacetTarget, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { actorObjectState, durableObjectStorage, durableSqlStorage, durableStorage, HELD_NIMBUS_TASKS, SCRIPT_EXPORTS } from './helpers/programmatic-host';
import { workerCompatibility } from '../vite-agent-bundle';

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

const SLATE_CWD = '/slates/a';

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
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    // The bundle opens on its first operation, so an activation that touches no file pays for none.
    expect(actor.tables()).toEqual(['kinu_workspace_generation']);

    await writeText(workspace.bundle.vfs, 'memory/MEMORY.md', 'the bytes are here\n');

    const tables = actor.tables();

    // Nimbus's file tables, as the conformance manifest declares them for this root.
    for (const table of [
      'vfs_state', 'vfs_inodes', 'vfs_contents', 'vfs_content_chunks', 'vfs_chunks', 'nimbus_storage_ledger',
      'kinu_workspace_generation',
    ]) {
      expect(tables).toContain(table);
    }

    expect(await readText(workspace.bundle.vfs, 'memory/MEMORY.md'))
      .toBe('the bytes are here\n');
  });

  const OWNER_SOUL = '# the owner wrote this\n';

  /** A born workspace (the identity row exists), opened fresh on each call: a new object boots it. */
  function bornWorkspace(actor: ActorObject): () => HostedWorkspace {
    actor.database.exec(WORKSPACE_IDENTITY_DDL);
    actor.database.exec(`CREATE TABLE IF NOT EXISTS activity_log (
      actor_id TEXT NOT NULL, id TEXT NOT NULL DEFAULT (lower(hex(randomblob(9)))),
      event TEXT NOT NULL, detail TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (actor_id, id))`);
    initWorkspaceActorTable((ddl: string) => { actor.database.exec(ddl); });
    actor.database.run(`INSERT INTO workspace_identity (id, name) VALUES ('w', 'Atlas')`);

    return () => createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });
  }

  async function ownedSoul(actor: ActorObject): Promise<() => HostedWorkspace> {
    const open = bornWorkspace(actor);
    await writeWorkspaceSoul(open().bundle, OWNER_SOUL);

    return open;
  }

  async function soulFile(workspace: HostedWorkspace): Promise<{ text: string; uid: number; mode: number; type: string; ino: number; mtime: number }> {
    const kernel = (await workspace.bundle.session()).vfs.as(CRED_KERNEL);
    const entry = kernel.lstat('/home/main/SOUL.md');

    return {
      text: new TextDecoder().decode(kernel.readFile('/home/main/SOUL.md')),
      uid: entry.uid, mode: entry.mode & 0o7777, type: entry.type, ino: entry.ino, mtime: entry.mtime,
    };
  }

  // SOUL.md is an ordinary file of the workspace: the owner sets it, then any of its agents edits it, and a boot keeps the edit.
  test('every agent of the workspace edits SOUL.md, by its file tool or its shell, and a restart keeps what it wrote', async () => {
    const actor = actorObject();
    const open = await ownedSoul(actor);
    const workspace = open();
    await workspace.box('agent:main').files.write('/home/main/SOUL.md', '# main edited this\n');
    expect(await workspaceSoul(workspace.bundle)).toBe('# main edited this\n');

    const session = await workspace.bundle.session();
    const identity = agentIdentity(session.sql, 'subordinate-alpha');
    const home = provisionAgentHome(session.vfs.as(CRED_KERNEL), 'subordinate-alpha', identity);
    const subordinate = await workspace.bundle.asAgent({ cred: agentCred(identity), home, tmp: `${home}/tmp` });
    const edit = await subordinate.shell.exec("printf '# a subordinate edited this\\n' > /home/main/SOUL.md");

    expect([edit.exitCode, edit.stderr]).toEqual([0, '']);
    const restarted = open();
    expect(await workspaceSoul(restarted.bundle)).toBe('# a subordinate edited this\n');
    expect(await soulFile(restarted)).toMatchObject({ uid: 1000, mode: 0o664, type: 'file' });
  });

  test('only the main agent creates in the workspace root', async () => {
    const workspace = (await ownedSoul(actorObject()))();
    const session = await workspace.bundle.session();
    const identity = agentIdentity(session.sql, 'subordinate-alpha');
    const home = provisionAgentHome(session.vfs.as(CRED_KERNEL), 'subordinate-alpha', identity);
    const subordinate = await workspace.bundle.asAgent({ cred: agentCred(identity), home, tmp: `${home}/tmp` });

    await expect(writeText(subordinate.vfs, '/home/main/AGENTS.md', 'forged')).rejects.toThrow();
    await subordinate.shell.exec('printf forged > /home/main/skills.md');
    await workspace.box('agent:main').exec('printf mine > /home/main/notes.md');

    expect(await exists(workspace.bundle.vfs, 'AGENTS.md')).toBe(false);
    expect(await exists(workspace.bundle.vfs, 'skills.md')).toBe(false);
    expect(await readText(workspace.bundle.vfs, 'notes.md')).toBe('mine');
  });

  test('the shell and the file plane are two views of the same rows', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.mkdir('proof', { recursive: true });
    await writeText(workspace.bundle.vfs, 'proof/from-vfs.txt', 'same bytes');

    const box = workspace.box('agent:main');
    expect(await box.exec('cat proof/from-vfs.txt')).toMatchObject({
      stdout: 'same bytes',
      exitCode: 0,
    });
    expect(await box.exec('printf %s "from the shell" > proof/from-shell.txt'))
      .toMatchObject({ exitCode: 0 });
    expect(await readText(workspace.bundle.vfs, 'proof/from-shell.txt'))
      .toBe('from the shell');

    expect(await box.files.read('/home/main/proof/from-shell.txt')).toBe('from the shell');
    expect(await box.files.exists('/home/main/proof/from-vfs.txt')).toBe(true);
  });

  test('the shell serves the file plane\'s mount points: /shared lists and reads through the same table', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    const drive = mossaicVfs(fakeMossaic().tenant('owner'));
    await writeText(drive, '/notes.md', 'from the Drive\n');
    const box = workspace.box('agent:main');
    const { files } = workspaceFilePlane(box, { mounts: [sharedDriveMount(() => drive, () => 'no Drive in this test')], principal: {}, home: WORKSPACE_ROOT });

    expect((await box.exec('ls /')).stdout.split(/\s+/)).toEqual(expect.arrayContaining(['home', 'shared']));
    expect(await box.exec('cat /shared/notes.md')).toMatchObject({ stdout: 'from the Drive\n', exitCode: 0 });
    // One namespace: the file tool reads the shell's own mount, and a write through either is seen by the other.
    expect(await readText(files, '/shared/notes.md')).toBe('from the Drive\n');
    await writeText(files, '/shared/from-tool.md', 'tool\n');
    expect(await box.exec('cat /shared/from-tool.md')).toMatchObject({ stdout: 'tool\n', exitCode: 0 });
  });

  test('a table serves until its disposer runs, and an older disposer leaves a newer table standing', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    const drive = mossaicVfs(fakeMossaic().tenant('owner'));
    await writeText(drive, '/notes.md', 'from the Drive\n');
    const mounted = () => [sharedDriveMount(() => drive, () => 'no Drive in this test')];
    const box = workspace.box('agent:main');
    const first = box.mountTable?.(mounted());
    box.mountTable?.(mounted());

    first?.();
    expect(await box.exec('cat /shared/notes.md')).toMatchObject({ stdout: 'from the Drive\n', exitCode: 0 });

    // A released actor's table holds its whole runtime; a table kept past release is how 200 heads kept 7.7 MB.
    const last = box.mountTable?.(mounted());
    last?.();
    expect((await box.exec('ls /')).stdout.split(/\s+/)).not.toContain('shared');
  });

  test('a view with no uid of its own never takes the root shell\'s table, so releasing it leaves the root\'s mounts', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    const drive = mossaicVfs(fakeMossaic().tenant('owner'));
    const root = workspace.box('agent:main');
    workspaceFilePlane(root, { mounts: [sharedDriveMount(() => drive, () => 'no Drive in this test')], principal: {}, home: WORKSPACE_ROOT });

    const branch = workspaceFilePlane(workspace.box('branch:b1'), { mounts: [], principal: { actor: 'b1' }, home: WORKSPACE_ROOT });
    branch.unmount();

    expect((await root.exec('ls /')).stdout.split(/\s+/)).toContain('shared');
  });

  // A name keys a durable shell within its agent: another agent's same name is another shell, an unnamed call none.
  test('a named durable shell keeps its own cwd, and siblings do not see it', async () => {
    const actor = actorObject();
    const shellState = new Map<string, JsonValue>();
    const storage = actor.ctx.storage;
    Object.assign(storage, {
      get: async (key: string) => shellState.get(key),
      put: async (key: string, value: JsonValue) => { shellState.set(key, value); },
    });

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await workspace.bundle.vfs.mkdir('alpha', { recursive: true });
    await workspace.bundle.vfs.mkdir('beta', { recursive: true });

    const alpha = workspace.box('subordinate:alpha');
    const beta = workspace.box('head:beta');
    const work = { name: 'work' };
    expect(await alpha.exec('cd /home/main/alpha', work)).toMatchObject({ exitCode: 0 });
    expect(await alpha.exec('pwd', work)).toMatchObject({ stdout: '/home/main/alpha\n' });
    expect(await alpha.shellCwd?.('work')).toBe('/home/main/alpha');
    expect(await beta.exec('pwd', work)).toMatchObject({ stdout: '/home/main\n' });
    expect(await alpha.exec('pwd', { cwd: '/home/main' })).toMatchObject({ stdout: '/home/main\n' });
    // The box is a view: one got again by scope finds the same shell.
    expect(await workspace.box('subordinate:alpha').exec('pwd', work)).toMatchObject({ stdout: '/home/main/alpha\n' });
  });

  test('the workspace never reads a session binding out of env', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      // Only the runtime catalogue bucket may be read, and none is bound here.
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await writeText(workspace.bundle.vfs, 'proof.txt', 'no binding was read');
    expect(await workspace.box('agent:main').exec('cat proof.txt'))
      .toMatchObject({ stdout: 'no binding was read', exitCode: 0 });
  });

  /** One database, one transaction boundary: the FTS5 index lives beside the markdown it indexes. */
  test('the memory index and the bytes it indexes are in one database', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    const store = new MemoryStore(workspace.bundle.vfs, sqlOver(actor.database));
    store.ensureSchema();
    await store.writeFile('memory/MEMORY.md', '# Notes\n\nthe indexed bytes\n');
    await store.indexFile('memory/MEMORY.md', '# Notes\n\nthe indexed bytes\n');

    const tables = actor.tables();
    expect(tables).toContain('vfs_inodes');
    expect(tables).toContain('vfs_chunks');
    expect(tables).toContain('memory_chunks');
    expect(store.search('indexed bytes', 5)).not.toHaveLength(0);
    expect(await readText(workspace.bundle.vfs, 'memory/MEMORY.md'))
      .toContain('the indexed bytes');
  });

  test('destroy drops the filesystem tables and leaves the actor rows alone', async () => {
    const actor = actorObject();

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    actor.ctx.storage.sql.exec('CREATE TABLE actor_rows (id INTEGER PRIMARY KEY)');
    actor.ctx.storage.sql.exec('INSERT INTO actor_rows (id) VALUES (1)');
    await writeText(workspace.bundle.vfs, 'doomed.txt', 'bytes');
    expect(actor.tables()).toContain('vfs_inodes');

    await workspace.destroy();

    expect(actor.tables()).not.toContain('vfs_inodes');
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
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx,
      env: workspaceBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    // Armed after construction: the boot is lazy.
    failures = 1;
    await expect(exists(workspace.bundle.vfs, 'SOUL.md')).rejects.toThrow(/transient storage failure/);
    await writeText(workspace.bundle.vfs, 'recovered.txt', 'alive');
    expect(await readText(workspace.bundle.vfs, 'recovered.txt')).toBe('alive');
  });

  test('a durable URL re-drives its owner before routing; unknown and forged links stay 404', async () => {
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));

    const redriven: string[] = [];
    let refusal: Refusal | null = null;

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
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
      tasks: HELD_NIMBUS_TASKS,
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
      tasks: HELD_NIMBUS_TASKS,
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

  test('a page a person loads counts as a render of its slate; a capture\'s own load never does', async () => {
    const actor = actorObject();
    const capability = 'abcdef0123456789abcdef01';
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));
    const renders: string[] = [];

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx, env: workspaceBindings(),
      previewUrl: async () => ({ url: 'https://preview.test/' }),
      ensureSlate: async () => null,
      pictures: {
        captures: (_port, handle) => handle === 'cafe012345',
        rendered: (slate, port) => { renders.push(`${slate}:${String(port)}`); },
      },
    });

    const owner = await derivedOwner(workspace, ['a']);
    kv.set('nimbus_preview_capability:3000', { capability, owner });

    const pid = await listen(workspace, 3000, ['a'], {
      handleHttpRequest: async (request) => new URL(request.url).pathname === '/'
        ? new Response('<p>board</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : Response.json({ ok: true }),
    });

    const load = (handle: string, destination: string, path = '/', port = 3000) => workspace.routePreview(
      port, handle, new Request(`https://preview.test${path}`, { headers: { 'sec-fetch-dest': destination } }), path,
    );

    expect((await load(capability.slice(0, 10), 'document')).status).toBe(200);
    expect((await load(capability.slice(0, 10), 'iframe')).status).toBe(200);
    // A script's fetch is not a page, and an image or a JSON answer is not a render.
    expect((await load(capability.slice(0, 10), 'empty', '/api')).status).toBe(200);
    expect((await load(capability.slice(0, 10), 'document', '/api')).status).toBe(200);
    expect(renders).toEqual([`${owner}:3000`, `${owner}:3000`]);

    // The capture's handle opens the page, and its load is not counted, or each picture would ask for the next.
    expect((await load('cafe012345', 'document')).status).toBe(200);
    expect(renders).toHaveLength(2);
    expect((await load('0000000000', 'document')).status).toBe(404);

    // A port no slate owns: a capture handle never opens it, and its pages make no picture.
    const shell = 'fedcba9876543210fedcba98';
    kv.set('nimbus_preview_capability:3001', { capability: shell, owner: await derivedOwner(workspace, ['b']), kind: 'derived' });

    const shellPid = await listen(workspace, 3001, ['b'], {
      handleHttpRequest: async () => new Response('<p>shell</p>', { headers: { 'content-type': 'text/html' } }),
    });

    expect((await load('cafe012345', 'document', '/', 3001)).status).toBe(404);
    expect((await load(shell.slice(0, 10), 'document', '/', 3001)).status).toBe(200);
    expect(renders).toHaveLength(2);

    for (const listener of [pid, shellPid]) (await workspace.facetManager()).manager.kill(listener);
  });

  test('a durable URL follows its owner across activations and never a different one', async () => {
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));

    const activate = () => createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
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

  test('a resident exposed with exposePort is verified and routes to its server, never through the slate host', async () => {
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));
    const asked: string[] = [];

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx, env: workspaceBindings(),
      previewUrl: async (_port, capability) => ({ url: `https://preview.test/${capability}/` }),
      // What the slate host answers for an owner that names no slate (`SlateHost.ensureDurable`).
      ensureSlate: async (owner) => {
        asked.push(owner);

        return { reason: 'missing', error: `slate ${owner} durable app: ENOENT: slates/${owner}` };
      },
    });

    await listen(workspace, 8090, ['python3', '-m', 'http.server', '8090', '--bind', '0.0.0.0'], {
      handleHttpRequest: async () => new Response('<h1>2048</h1>'),
    });
    const ports = workspace.box('agent').ports;

    if (ports?.expose === undefined) throw new Error('the workspace box has no port exposure');
    const result = await ports.expose(8090);
    const exposed = v.parse(v.object({ url: v.string(), capability: v.string() }), result);
    const response = await workspace.routePreview(8090, exposed.capability.slice(0, 10), new Request(exposed.url), '/');

    expect(result.route).toEqual({ reached: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>2048</h1>');
    expect(asked).toEqual([]);
  });

  test('exposePort names the gate that refuses when the exposed server has stopped', async () => {
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actor.ctx, env: workspaceBindings(),
      previewUrl: async (_port, capability) => ({ url: `https://preview.test/${capability}/` }),
    });

    const pid = await listen(workspace, 8090, ['python3', '-m', 'http.server', '8090'], {
      handleHttpRequest: async () => new Response('<h1>2048</h1>'),
    });

    const ports = workspace.box('agent').ports;

    if (ports?.expose === undefined) throw new Error('the workspace box has no port exposure');
    await ports.expose(8090);
    (await workspace.facetManager()).manager.kill(pid);

    expect((await ports.expose(8090)).route)
      .toEqual({ reached: false, gate: 'no-listener', detail: 'nothing is listening on port 8090' });
  });

  test('a launch a hibernation interrupted is re-driven through the slate host on the next wake', async () => {
    // Vendor-format coupling: the seeded journal row copies worker 0.13's `resident-launch:<n>` shape, which records
    // the credential it ran as (a row without one is refused, not re-driven); update here when the vendor changes it.
    const actor = actorObject();
    const kv = new Map<string, JsonValue>();
    Object.assign(actor.ctx.storage, durableStorage(kv));
    kv.set('resident-launch:41', {
      pid: 41, command: 'slate keeper', attempt: 0, phase: 'starting', owner: 'keeper', restart: 'never', port: 20000,
      cred: { uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid, groups: [...CRED_SESSION_USER.groups], umask: CRED_SESSION_USER.umask },
      recipe: {
        kind: 'worker', owner: 'keeper', port: 20000, cwd: '/slates/keeper', mainModule: 'runner.js',
        image: { runner: 'a'.repeat(64), application: 'b'.repeat(64) }, ...workerCompatibility,
      },
    });
    const redriven: string[] = [];

    const workspace = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
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

test('a port that starts or stops listening is heard by the workspace, which re-reads its pages\' port lists', async () => {
  let moved = 0;

  const workspace = createHostedWorkspace({
    tasks: HELD_NIMBUS_TASKS,
    ctx: actorObject().ctx,
    env: workspaceBindings(),
    previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    onPortsChanged: () => { moved += 1; },
  });

  const ports = await workspace.ports();

  ports.register(4321, 7);
  expect(moved).toBe(1);

  ports.unregisterByPid(7);
  expect(moved).toBe(2);
});
