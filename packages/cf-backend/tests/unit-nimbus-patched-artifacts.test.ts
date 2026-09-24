import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { Nimbus } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type {
  SqlDatabase,
  SqlValue,
} from '@nimbus-sh/core/runtime/os-contracts.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import * as v from 'valibot';
import {
  LEGACY_WORKSPACE_ROOT, TurnContextBudget, WORKSPACE_ROOT, createFileDispatcher, nimbusSessionFiles, settleWorkspaceRoot,
} from '@kinu.run/core';
import { workspaceBoxFiles } from '@kinu.run/core/workspace';
import { TurnFileLedger } from '../../core/src/tools/file-ledger';
import { mockAgentsSdk } from './helpers/agents-sdk';

// `agents` reaches `cloudflare:email`: mock first, then the harness.
mockAgentsSdk();

const { orchestratorHarness } = await import('./helpers/actor-harness');

type NativeSqlValue = string | number | bigint | null | Uint8Array;

type NativeSqlRow = Record<string, NativeSqlValue>;

function nativeBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return value;
}

function workspaceSql(database: Database): SqlDatabase {
  return {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<NativeSqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(nativeBinding);

      if (statement.columnNames.length > 0) return statement.all(...bound);
      statement.run(...bound);

      return [];
    },
  };
}

/** A workspace booted as Kinu boots one: the root at /home/main, /home/user a link to it. */
async function linkedWorkspace(db: Database): Promise<NimbusWorkspace> {
  const workspace = await NimbusWorkspace.create({
    sql: workspaceSql(db),
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => db.transaction(fn)() } },
    generation: 1,
    cwd: WORKSPACE_ROOT,
    env: { HOME: WORKSPACE_ROOT },
  });

  settleWorkspaceRoot(workspace.vfs.as(CRED_KERNEL));

  return workspace;
}

/** Every name a directory lists. */
const namesIn = (vfs: CredentialedVfs, path: string): string[] => vfs.readdir(path).map((entry) => entry.name);

describe('installed Nimbus dependency integrity', () => {
  test('the SDK preserves runtime policy enforcement', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        _rpcReady: async () => ({ ok: true as const, preinstalled: [] }),
      }),
    };

    const box = Nimbus.fromEnv(
      { NIMBUS_SESSION: namespace },
      { sandboxes: { default: { runtimes: { allow: ['node'], onDemand: true } } } },
    ).sandbox('patched-sdk');

    await expect(box.runtimes.install('python')).rejects.toThrow(
      "Nimbus runtime 'python' is not allowed",
    );
  });

  test('xargs null mode preserves leading whitespace in the first argument', async () => {
    const db = new Database(':memory:');

    const workspace = await NimbusWorkspace.create({
      sql: workspaceSql(db),
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => db.transaction(fn)() } },
      generation: 1,
      cwd: '/home/main',
    });

    const result = await workspace.exec('xargs -0 -n 1 echo', { stdin: ' leading\0second\0' });

    expect(result).toMatchObject({ exitCode: 0, stdout: ' leading\nsecond\n' });
    db.close();
  });

  // patches/@nimbus-sh%2Fcore@0.12.0.patch (Nimbus ask N21) until a release carries it: SqliteVFS.readdir keyed
  // its children on the path as given, so a directory reached through a link listed nothing.
  test('the workspace root, reached through its legacy link, lists what the root holds', async () => {
    const db = new Database(':memory:');
    const workspace = await linkedWorkspace(db);

    workspace.vfs.as(CRED_SESSION_USER).writeFile(`${WORKSPACE_ROOT}/flow-probe.txt`, new TextEncoder().encode('probe'));

    const listed = workspace.vfs.as(CRED_SESSION_USER).readdir(LEGACY_WORKSPACE_ROOT).map((entry) => entry.name);

    const shell = await workspace.exec(`ls ${LEGACY_WORKSPACE_ROOT}`);

    const file = createFileDispatcher({
      vfs: nimbusSessionFiles({
        files: workspaceBoxFiles(async () => workspace.vfs),
        ready: async () => undefined,
        exec: async () => { throw new Error('the file tool runs no commands'); },
      }),
      ledger: new TurnFileLedger(),
      budget: new TurnContextBudget(),
    });

    const tool = v.parse(v.object({ entries: v.array(v.string()) }), await file({ action: 'list', path: LEGACY_WORKSPACE_ROOT }));

    expect(listed).toContain('flow-probe.txt');
    expect(shell).toMatchObject({ exitCode: 0 });
    expect(shell.stdout.split(/\s+/u)).toContain('flow-probe.txt');
    expect(tool.entries).toContain('flow-probe.txt');
    db.close();
  });

  // patches/@nimbus-sh%2Fcore@0.12.0.patch (Nimbus ask N22) until a release carries it: SqliteVFS keyed a new entry on
  // the path as given, so one made through the link landed under the link's own name, where nothing reached through
  // the link finds it; rmdir and revision read that name too. Old SOULs and conversations still name /home/user.
  describe('through the legacy link, an entry lands where the root holds it', () => {
    test('the file plane writes into a directory that does not exist yet', async () => {
      const db = new Database(':memory:');
      const workspace = await linkedWorkspace(db);

      const plane = nimbusSessionFiles({
        files: workspaceBoxFiles(async () => workspace.vfs),
        ready: async () => undefined,
        exec: async () => { throw new Error('the plane runs no commands'); },
      });

      await plane.writeFile(`${LEGACY_WORKSPACE_ROOT}/slates/a/package.json`, '{}');

      expect(workspace.vfs.as(CRED_SESSION_USER).readFileString(`${WORKSPACE_ROOT}/slates/a/package.json`)).toBe('{}');
      db.close();
    });

    test('mkdir makes the directory under the root, listed by both names, recursive or not', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.mkdir(`${LEGACY_WORKSPACE_ROOT}/a/b`, { recursive: true });
      vfs.mkdir(`${LEGACY_WORKSPACE_ROOT}/c`);

      expect(vfs.isDirectory(`${WORKSPACE_ROOT}/a/b`)).toBe(true);
      expect(vfs.isDirectory(`${WORKSPACE_ROOT}/c`)).toBe(true);
      expect(namesIn(vfs, `${WORKSPACE_ROOT}/a`)).toEqual(['b']);
      expect(namesIn(vfs, `${LEGACY_WORKSPACE_ROOT}/a`)).toEqual(['b']);
      db.close();
    });

    test('mkdirBatch makes every missing directory under the root', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.mkdirBatch([`${LEGACY_WORKSPACE_ROOT}/pkg/lib`]);

      expect(vfs.isDirectory(`${WORKSPACE_ROOT}/pkg/lib`)).toBe(true);
      db.close();
    });

    test('a batch writes, and deletes, where the root holds its paths', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);
      const bytes = new TextEncoder().encode('export {};');
      const at = (path: string) => ({ path, parentPath: path.slice(0, path.lastIndexOf('/')) });

      vfs.writeBatch({
        inodes: [
          { ...at(`${LEGACY_WORKSPACE_ROOT}/mod`), isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 },
          { ...at(`${LEGACY_WORKSPACE_ROOT}/mod/index.js`), isDir: false, size: bytes.length, mtime: 1, mode: 0o644, chunkCount: 1 },
        ],
        chunks: [{ path: `${LEGACY_WORKSPACE_ROOT}/mod/index.js`, chunkId: 0, data: bytes }],
      });

      expect(vfs.readFileString(`${WORKSPACE_ROOT}/mod/index.js`)).toBe('export {};');

      vfs.writeBatch({ inodes: [], chunks: [], deletePaths: [`${LEGACY_WORKSPACE_ROOT}/mod/index.js`] });

      expect(vfs.exists(`${WORKSPACE_ROOT}/mod/index.js`)).toBe(false);
      db.close();
    });

    test('a link made through the link lands under the root', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.writeFile(`${WORKSPACE_ROOT}/target.txt`, 'target');
      vfs.symlink(`${WORKSPACE_ROOT}/target.txt`, `${LEGACY_WORKSPACE_ROOT}/shortcut`);

      expect(vfs.readlink(`${WORKSPACE_ROOT}/shortcut`)).toBe(`${WORKSPACE_ROOT}/target.txt`);
      db.close();
    });

    test('rmdir removes the directory the link reaches', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.mkdir(`${WORKSPACE_ROOT}/emptied`);
      vfs.rmdir(`${LEGACY_WORKSPACE_ROOT}/emptied`);

      expect(vfs.exists(`${WORKSPACE_ROOT}/emptied`)).toBe(false);
      db.close();
    });

    test('a revision read through the link moves when the file does', async () => {
      const db = new Database(':memory:');
      const vfs = (await linkedWorkspace(db)).vfs.as(CRED_SESSION_USER);

      vfs.writeFile(`${WORKSPACE_ROOT}/watched.txt`, 'one');
      const before = vfs.revision(`${LEGACY_WORKSPACE_ROOT}/watched.txt`);

      vfs.writeFile(`${WORKSPACE_ROOT}/watched.txt`, 'two');

      expect(vfs.revision(`${LEGACY_WORKSPACE_ROOT}/watched.txt`)).toBeGreaterThan(before);
      expect(vfs.revision(`${LEGACY_WORKSPACE_ROOT}/watched.txt`)).toBe(vfs.revision(`${WORKSPACE_ROOT}/watched.txt`));
      db.close();
    });
  });

  // `writeWorkspaceSoul` rests on the installed filesystem: a sticky 1777 root owned by the kernel, SOUL.md kernel-owned 444.
  test('the agent cannot remove, rename or rewrite the SOUL.md its owner wrote', async () => {
    const { agent } = orchestratorHarness();
    const soul = '# Checkout\n\n## Mission\n\nAudit the checkout flow.';

    await agent.setSoul(soul);

    const attempts = await Promise.all([
      'rm -f /home/main/SOUL.md',
      'mv /home/main/SOUL.md /home/main/renamed.md',
      'echo rewritten > /home/main/SOUL.md',
    ].map(async (command) => {
      const ran = await agent.execWorkspaceCommand(`${command}; echo "exit=$?"`);

      return ran.ok ? ran.value.stdout.trim() : ran.error.message;
    }));

    expect(attempts).toEqual(['exit=1', 'exit=1', 'exit=1']);
    expect((await agent.deleteWorkspaceFile('SOUL.md')).ok).toBe(false);
    expect((await agent.writeWorkspaceFile({ kind: 'file', path: 'SOUL.md', data: 'rewritten' })).ok).toBe(false);

    const kept = await agent.execWorkspaceCommand('cat /home/main/SOUL.md');

    expect(kept.ok ? kept.value.stdout : kept.error.message).toBe(soul);
  });
});
