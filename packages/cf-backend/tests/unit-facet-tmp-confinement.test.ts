import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * A facet's `/tmp` is private only if `confinePrincipal` ran on the owner's own `SqliteVFS`; the method has no RPC,
 * so the provisioner runs on the owning object. Proved against the real `NimbusWorkspace` and `rpcExec`.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { HostedRuntime } from '@nimbus-sh/worker/workspace-host';
import type { SqlDatabase, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { NimbusSandboxHandle, NodeHomeHost, NodeIdentity } from '@kinu.run/core';
import {
  facetHomeProvisioner, facetHomeReleaser, nimbusSessionFiles, headAgentName, restoreAgentTmpConfinements,
  settleWorkspaceRoot, WORKSPACE_ROOT,
} from '@kinu.run/core';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  credentialedSessionBox,
  programmaticHostOver,
  ensureProgrammaticReady,
  rpcExec,
  type ProgrammaticHost,
} from './helpers/programmatic-host';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

/** The session user every unnamed exec already runs as. */
const ORIGIN: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

interface OwnerFixture {
  readonly workspace: NimbusWorkspace;
  readonly host: ProgrammaticHost;
  readonly runtime: () => Promise<HostedRuntime>;
  readonly sql: SqlDatabase;
  readonly box: NimbusSandboxHandle;
  readonly databases: Database[];
  /** The owner's three members, as `WorkspaceBundle.privileged()` plus its sql hand them to the provisioner. */
  readonly homeHost: NodeHomeHost;
}

async function openOwner(): Promise<OwnerFixture> {
  const database = new Database(':memory:');

  const { sql, transactions } = inlineWorkspaceStorage(database);

  const workspace = await NimbusWorkspace.create({
    sql,
    transactions,
    generation: 1,
    cwd: WORKSPACE_ROOT,
    env: { HOME: WORKSPACE_ROOT },
  });

  // The layout Kinu's boot gives every workspace: its root at /home/main.
  settleWorkspaceRoot(workspace.vfs.as(CRED_KERNEL));
  const composed = programmaticHostOver(workspace);
  const host = composed.host;

  await ensureProgrammaticReady(host);

  // Every option rides through: the provisioner roots its layout command with the kernel credential.
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
    workspace, host, runtime: composed.runtime, sql, box, databases: [database],
    homeHost: { root: workspace.vfs.as(CRED_KERNEL), confiner: workspace.vfs, sql },
  };
}

function sessionBoxFor(f: OwnerFixture, cred: VfsCred): NimbusSandboxHandle {
  return credentialedSessionBox(f.runtime, cred);
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
      const provision = (identity: { nodeId: string }) => facetHomeProvisioner(f.homeHost)(headAgentName(identity.nodeId));
      const a = credOf(await provision(node('aX9')));
      const b = credOf(await provision(node('bK2')));

      expect(await rpcExec(f.host, 'echo a > /tmp/x', { cred: a })).toMatchObject({ exitCode: 0 });

      expect((await rpcExec(f.host, 'cat /tmp/x', { cred: b })).exitCode).not.toBe(0);
      expect(f.workspace.vfs.as(ROOT).exists('tmp/x')).toBe(false);
      expect(f.workspace.vfs.as(ROOT).readFileString('tmp/head-aX9/x')).toBe('a\n');
    } finally {
      for (const database of f.databases) database.close();
    }
  });

  test('the credentialed file plane resolves /tmp per credential too', async () => {
    const f = await openOwner();

    try {
      const provision = (identity: { nodeId: string }) => facetHomeProvisioner(f.homeHost)(headAgentName(identity.nodeId));
      const homeA = await provision(node('aX9'));
      const homeB = await provision(node('bK2'));
      const [a, b] = [credOf(homeA), credOf(homeB)];
      const asA = nimbusSessionFiles(sessionBoxFor(f, a), { home: homeA.home, cred: a });
      const asB = nimbusSessionFiles(sessionBoxFor(f, b), { home: homeB.home, cred: b });

      // Includes the stage-and-rename commit, which resolves through the same rewrite.
      await writeText(asA, '/tmp/y', 'from a');

      expect(await readText(asA, '/tmp/y')).toBe('from a');
      // Absent for the sibling is ENOENT and stat null: a boundary reads as empty space, never a refusal.
      await expect(asB.readFile('/tmp/y')).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(await asB.stat('/tmp/y')).toBeNull();
    } finally {
      for (const database of f.databases) database.close();
    }
  });

  test('cleanup drops the confinement with the bytes', async () => {
    const f = await openOwner();

    try {
      const provision = (identity: { nodeId: string }) => facetHomeProvisioner(f.homeHost)(headAgentName(identity.nodeId));
      const a = credOf(await provision(node('aX9')));
      expect(await rpcExec(f.host, 'echo a > /tmp/gone', { cred: a })).toMatchObject({ exitCode: 0 });
      await facetHomeReleaser(f.homeHost)('head-aX9');
      expect(f.workspace.vfs.as(ROOT).exists('tmp/head-aX9')).toBe(false);
      // Dropped confinement fails closed: the shared scratch refuses the credential.
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
      expect((await rpcExec(f.host, 'cat /tmp/x', { cred: head })).exitCode).not.toBe(0);
      expect((await rpcExec(f.host, 'echo h > /home/sub-worker-1/theirs', { cred: head })).exitCode).not.toBe(0);
      expect(root.readFileString('/home/sub-worker-1/own')).toBe('s\n');

      await release('sub-worker-1');
      expect(root.exists('/home/sub-worker-1')).toBe(false);
      expect(root.exists('tmp/sub-worker-1')).toBe(false);
      expect(await rpcExec(f.host, 'echo h > /tmp/y', { cred: head })).toMatchObject({ exitCode: 0 });
      expect(root.readFileString('tmp/head-h1/y')).toBe('h\n');
      // The uid row outlives the bytes, so a returning facet is itself.
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

      // The registry is isolate memory: a second filesystem over the same database starts with none of it.
      const reopened = await NimbusWorkspace.create({
        sql: f.sql,
        transactions: { storage: { transactionSync: <T,>(fn: () => T): T => fn() } },
        generation: 2,
      });

      const before = reopened.vfs.as(sub);
      expect(() => before.writeFile('/tmp/again', 'x')).toThrow(expect.objectContaining({ code: 'EACCES' }));
      restoreAgentTmpConfinements(f.sql, reopened.vfs.as(CRED_KERNEL), reopened.vfs);
      before.writeFile('/tmp/again', 'x');
      expect(reopened.vfs.as(ROOT).readFileString('tmp/sub-worker-1/again')).toBe('x');
      expect(reopened.vfs.as(ROOT).readFileString('tmp/sub-worker-1/x')).toBe('s\n');
    } finally {
      for (const database of f.databases) database.close();
    }
  });
});

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
      const files = nimbusSessionFiles(originFilesBox(f), { home: WORKSPACE_ROOT });

      // A relative shell path and its `/home/main` spelling name the same file; root paths are per-surface.
      expect(await rpcExec(f.host, 'echo live-bytes > tree-probe.md', {}))
        .toMatchObject({ exitCode: 0 });
      expect(await readText(files, 'tree-probe.md')).toBe('live-bytes\n');
      expect(await readText(files, '/home/main/tree-probe.md')).toBe('live-bytes\n');

      await writeText(files, 'tree-probe-2.md', 'file-plane bytes\n');
      expect(await rpcExec(f.host, 'cat tree-probe-2.md', {}))
        .toMatchObject({ exitCode: 0, stdout: 'file-plane bytes\n' });
      expect(await rpcExec(f.host, 'cat /home/main/tree-probe-2.md', {}))
        .toMatchObject({ exitCode: 0, stdout: 'file-plane bytes\n' });
    } finally {
      for (const database of f.databases) database.close();
    }
  });
});
