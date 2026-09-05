/**
 * The hosted /tmp rewrite, applied where the workspace lives.
 *
 * A facet's `/tmp` is private only if `confinePrincipal` ran on the owner's
 * own `SqliteVFS`: the method has no RPC, so the provisioner runs ON the
 * owning object, through the same three host members the local backend hands
 * core's one provisioner. A command hardcoding `/tmp/x` then resolves
 * per-credential on every plane the session serves, with no mount copy and
 * no second filesystem.
 *
 * Proved against the real substrate: the same `NimbusWorkspace` and
 * `rpcExec` a facet reaches, with the owner's own members as the host —
 * exactly what the owning Durable Object hands over.
 */
import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { NimbusSandboxHandle, NodeHomeHost, NodeIdentity } from '@kinu.run/core';
import {
  agentHomeNodeProvisioner, facetHomeProvisioner, facetHomeReleaser, nimbusSessionFiles, restoreAgentTmpConfinements,
} from '@kinu.run/core';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  ensureProgrammaticReady,
  rpcExec,
  type ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
/** The session user every unnamed exec already runs as. */
const ORIGIN: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    const source = new DataView(value.buffer, value.byteOffset, value.byteLength);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = source.getUint8(index);
    return bytes;
  }
  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

interface OwnerFixture {
  readonly workspace: NimbusWorkspace;
  readonly host: ProgrammaticHost;
  readonly sql: SqlDatabase;
  readonly box: NimbusSandboxHandle;
  readonly databases: Database[];
  /** The owner's three members, as `WorkspaceBundle.privileged()` plus its sql
   *  hand them to core's provisioner. */
  readonly homeHost: NodeHomeHost;
}

async function openOwner(): Promise<OwnerFixture> {
  const database = new Database(':memory:');
  const sql: SqlDatabase = {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);
      return [];
    },
  };
  const workspace = await NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
    generation: 1,
  });
  const durable = new Map<string, unknown>();
  const host: ProgrammaticHost = {
    _w1SessionDestroyed: false,
    env: {},
    ctx: {
      storage: {
        get: async (key) => durable.get(key),
        put: async (key, value) => { durable.set(key, value); },
        delete: async (key) => { durable.delete(key); },
        deleteAll: async () => { durable.clear(); },
        deleteAlarm: async () => undefined,
      },
    },
    shell: workspace.shell,
    shellProcessPid: null,
    sqliteFs: workspace.vfs,
    processes: new SessionProcessSupervisor(),
    portRegistry: new PortRegistry(),
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: workspace.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    ensureSqliteFs: () => undefined,
    ensureFacetManager: () => undefined,
    initSession: async () => { throw new Error('workspace is already composed'); },
  };
  await ensureProgrammaticReady(host);
  // The owner's own box: every option the session accepts rides through,
  // because the provisioner roots its layout command with the kernel
  // credential and a facet's file plane pins its own.
  const box: NimbusSandboxHandle = {
    ready: async () => undefined,
    exec: async (command, options) => {
      const result = await rpcExec(host, command, {
        cwd: options?.cwd,
        env: options?.env,
        cred: options?.cred,
      });
      return {
        command,
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    files: {
      read: async () => { throw new Error('the owner box execs; it never falls back to the session user'); },
      write: async () => { throw new Error('the owner box execs; it never falls back to the session user'); },
      list: async () => { throw new Error('the owner box execs; it never falls back to the session user'); },
      exists: async () => { throw new Error('the owner box execs; it never falls back to the session user'); },
      delete: async () => { throw new Error('the owner box execs; it never falls back to the session user'); },
    },
  };
  return {
    workspace, host, sql, box, databases: [database],
    homeHost: { root: workspace.vfs.as(CRED_KERNEL), confiner: workspace.vfs, sql },
  };
}

/** The session addressed as one node, for the credentialed file plane. */
function sessionBoxFor(host: ProgrammaticHost, cred: VfsCred): NimbusSandboxHandle {
  return {
    ready: async () => undefined,
    exec: async (rawCommand, options) => {
      const forwarded: Parameters<typeof rpcExec>[2] = { cred: options?.cred ?? cred };
      if (options?.env !== undefined) forwarded.env = options.env;
      const result = await rpcExec(host, rawCommand, forwarded);
      return {
        command: rawCommand,
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    files: {
      read: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      write: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      list: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      exists: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
      delete: async () => { throw new Error('a credentialed plane must not fall back to the session user'); },
    },
  };
}

function node(nodeId: string): NodeIdentity {
  return { nodeId, rootId: 'root-1', depth: 1 };
}

function credOf(workspace: { readonly cred?: VfsCred; readonly home: string }): VfsCred {
  if (!workspace.cred) throw new Error(`node at ${workspace.home} was given no credential`);
  return workspace.cred;
}

describe('a hosted node hardcoding /tmp stays private', () => {
  test('the shell resolves /tmp per credential once the owner confines it', async () => {
    const f = await openOwner();
    try {
      const provision = agentHomeNodeProvisioner(f.homeHost);
      const a = credOf(await provision(node('aX9')));
      const b = credOf(await provision(node('bK2')));

      expect(await rpcExec(f.host, 'echo a > /tmp/x', { cred: a })).toMatchObject({ exitCode: 0 });

      // The sibling sees no such file, through the shell AND the substrate.
      expect((await rpcExec(f.host, 'cat /tmp/x', { cred: b })).exitCode).not.toBe(0);
      expect(f.workspace.vfs.as(ROOT).exists('tmp/x')).toBe(false);
      expect(f.workspace.vfs.as(ROOT).readFileString('tmp/node-aX9/x')).toBe('a\n');
    } finally {
      for (const database of f.databases) database.close();
    }
  });

  test('the credentialed file plane resolves /tmp per credential too', async () => {
    const f = await openOwner();
    try {
      const provision = agentHomeNodeProvisioner(f.homeHost);
      const a = credOf(await provision(node('aX9')));
      const b = credOf(await provision(node('bK2')));
      const asA = nimbusSessionFiles(sessionBoxFor(f.host, a), a);
      const asB = nimbusSessionFiles(sessionBoxFor(f.host, b), b);

      // The whole write path, including the stage-and-rename commit, which
      // resolves through the same rewrite as every other operation.
      await asA.writeFile('/tmp/y', 'from a');

      expect(await asA.readFile('/tmp/y', { encoding: 'utf8' })).toBe('from a');
      // Absent for the sibling is ENOENT, and stat answers null — a
      // boundary reads as an empty space, never as a refusal.
      await expect(asB.readFile('/tmp/y')).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(await asB.stat('/tmp/y')).toBeNull();
    } finally {
      for (const database of f.databases) database.close();
    }
  });

  test('cleanup drops the confinement with the bytes', async () => {
    const f = await openOwner();
    try {
      const provision = agentHomeNodeProvisioner(f.homeHost);
      const a = credOf(await provision(node('aX9')));
      expect(await rpcExec(f.host, 'echo a > /tmp/gone', { cred: a })).toMatchObject({ exitCode: 0 });
      await facetHomeReleaser(f.homeHost)('node-aX9');
      expect(f.workspace.vfs.as(ROOT).exists('tmp/node-aX9')).toBe(false);
      // The mapping is gone with the bytes: the same credential no longer
      // reaches a private root, and the shared scratch refuses it — dropped
      // confinement fails closed, never open.
      const refused = await rpcExec(f.host, 'echo z > /tmp/z', { cred: a });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr.toLowerCase()).toContain('permission denied');
      expect(f.workspace.vfs.as(ROOT).exists('tmp/z')).toBe(false);
    } finally {
      for (const database of f.databases) database.close();
    }
  });
});

describe('every facet kind is one home namespace on the owner', () => {
  test('a subordinate and a head provision, write privately, and release to nothing', async () => {
    const f = await openOwner();
    try {
      const provision = facetHomeProvisioner(f.homeHost);
      const release = facetHomeReleaser(f.homeHost);
      const sub = credOf(await provision('sub-worker-1'));
      const head = credOf(await provision('head-h1'));
      const root = f.workspace.vfs.as(ROOT);
      expect(root.isDirectory('/home/sub-worker-1')).toBe(true);
      expect(root.isDirectory('/home/head-h1')).toBe(true);

      expect(await rpcExec(f.host, 'echo s > /tmp/x && echo s > "$HOME/own"', { cred: sub, env: { HOME: '/home/sub-worker-1' } })).toMatchObject({ exitCode: 0 });
      // The head's `/tmp/x` is a different file, and the subordinate's home is
      // readable but not writable to it.
      expect((await rpcExec(f.host, 'cat /tmp/x', { cred: head })).exitCode).not.toBe(0);
      expect((await rpcExec(f.host, 'echo h > /home/sub-worker-1/theirs', { cred: head })).exitCode).not.toBe(0);
      expect(root.readFileString('/home/sub-worker-1/own')).toBe('s\n');

      await release('sub-worker-1');
      expect(root.exists('/home/sub-worker-1')).toBe(false);
      expect(root.exists('tmp/sub-worker-1')).toBe(false);
      // Released means released: the head's home and rewrite are untouched.
      expect(await rpcExec(f.host, 'echo h > /tmp/y', { cred: head })).toMatchObject({ exitCode: 0 });
      expect(root.readFileString('tmp/head-h1/y')).toBe('h\n');
      // The uid row outlives the bytes, so a facet that comes back is itself.
      expect(credOf(await provision('sub-worker-1')).uid).toBe(sub.uid);
    } finally {
      for (const database of f.databases) database.close();
    }
  });

  test('a filesystem reopened over the same rows keeps every live rewrite', async () => {
    const f = await openOwner();
    try {
      const sub = credOf(await facetHomeProvisioner(f.homeHost)('sub-worker-1'));
      expect(await rpcExec(f.host, 'echo s > /tmp/x', { cred: sub })).toMatchObject({ exitCode: 0 });
      // The registry is isolate memory: a second filesystem over the same
      // database starts with none of it.
      const reopened = await NimbusWorkspace.create({
        sql: f.sql,
        transactions: { storage: { transactionSync: <T,>(fn: () => T): T => fn() } },
        generation: 2,
      });
      const before = reopened.vfs.as(sub);
      expect(() => before.writeFile('/tmp/again', 'x')).toThrow(expect.objectContaining({ code: 'EACCES' }));
      // Restored from the durable layout, the same credential resolves the
      // same private root again.
      restoreAgentTmpConfinements(f.sql, reopened.vfs.as(CRED_KERNEL), reopened.vfs);
      before.writeFile('/tmp/again', 'x');
      expect(reopened.vfs.as(ROOT).readFileString('tmp/sub-worker-1/again')).toBe('x');
      expect(reopened.vfs.as(ROOT).readFileString('tmp/sub-worker-1/x')).toBe('s\n');
    } finally {
      for (const database of f.databases) database.close();
    }
  });
});

/** The origin's own files, for the uncredentialed plane below. */
function originFilesBox(f: OwnerFixture): NimbusSandboxHandle {
  const view = f.workspace.vfs.as(ORIGIN);
  return {
    ready: async () => undefined,
    exec: (command, options) => f.box.exec(command, options),
    files: {
      read: async (path) => {
        try {
          return view.readFileString(path);
        } catch (error) {
          const code = v.safeParse(v.object({ code: v.string() }), error);
          if (code.success && code.output.code === 'ENOENT') return null;
          throw error;
        }
      },
      write: async (path, content) => {
        view.writeFile(path, content);
      },
      list: async (path) => view.readdir(path ?? '/').map((entry) => ({ name: entry.name })),
      exists: async (path) => view.exists(path),
      delete: async (path) => {
        view.unlink(path);
      },
    },
  };
}

describe('one box answers both surfaces with the same bytes', () => {
  test('a shell write inside the workspace tree reads back through the files surface, and back', async () => {
    const f = await openOwner();
    try {
      const files = nimbusSessionFiles(originFilesBox(f));

      // The workspace tree is the one view: a relative shell path and its
      // `/home/user` spelling name the same file the file plane reads. Paths
      // at the filesystem root are outside that view — each surface keeps
      // its own root — so the coherent contract is stated here, where it
      // holds, rather than there.
      expect(await rpcExec(f.host, 'echo live-bytes > tree-probe.md', {}))
        .toMatchObject({ exitCode: 0 });
      expect(await files.readFile('tree-probe.md', { encoding: 'utf8' })).toBe('live-bytes\n');
      expect(await files.readFile('/home/user/tree-probe.md', { encoding: 'utf8' })).toBe('live-bytes\n');

      await files.writeFile('tree-probe-2.md', 'file-plane bytes\n');
      expect(await rpcExec(f.host, 'cat tree-probe-2.md', {}))
        .toMatchObject({ exitCode: 0, stdout: 'file-plane bytes\n' });
      expect(await rpcExec(f.host, 'cat /home/user/tree-probe-2.md', {}))
        .toMatchObject({ exitCode: 0, stdout: 'file-plane bytes\n' });
    } finally {
      for (const database of f.databases) database.close();
    }
  });
});
