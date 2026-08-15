import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { Nimbus } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type {
  SqlDatabase,
  SqlValue,
} from '@nimbus-sh/core/runtime/os-contracts.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _rpcWriteProtectedRootFile } from '../../../node_modules/@nimbus-sh/worker/dist/session/rpc.js';

const repositoryRoot = join(import.meta.dir, '../../..');

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
      cwd: '/home/user',
    });
    const result = await workspace.exec('xargs -0 -n 1 echo', { stdin: ' leading\0second\0' });

    expect(result).toMatchObject({ exitCode: 0, stdout: ' leading\nsecond\n' });
    db.close();
  });

  test('a protected root file is host-writable and immutable to the session user', async () => {
    const db = new Database(':memory:');
    const workspace = await NimbusWorkspace.create({
      sql: workspaceSql(db),
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => db.transaction(fn)() } },
      generation: 1,
      cwd: '/home/user',
    });
    const host = {
      ensureSqliteFs() {},
      sqliteFs: workspace.vfs,
    };

    await _rpcWriteProtectedRootFile(host, '/home/user', '/home/user/SOUL.md', 'owner identity');
    expect((await workspace.exec("printf 'agent overwrite' > SOUL.md")).exitCode).not.toBe(0);
    expect((await workspace.exec('rm SOUL.md')).exitCode).not.toBe(0);
    expect((await workspace.exec('mv SOUL.md stolen.md')).exitCode).not.toBe(0);
    expect(await workspace.fs.readFile('/home/user/SOUL.md')).toBe('owner identity');

    await _rpcWriteProtectedRootFile(host, '/home/user', '/home/user/SOUL.md', 'owner update');
    expect(await workspace.fs.readFile('/home/user/SOUL.md')).toBe('owner update');
    await workspace.fs.writeFile('/home/user/project.txt', 'ordinary file');
    expect((await workspace.exec('rm project.txt')).exitCode).toBe(0);
    expect(await workspace.fs.exists('/home/user/project.txt')).toBe(false);
    db.close();
  });

  test('the checked Nimbus patches preserve the owner-only file boundary', () => {
    const coreInstalled = readFileSync(join(
      repositoryRoot,
      'node_modules/@nimbus-sh/core/src/vfs/sqlite-vfs.ts',
    ), 'utf8');
    const corePatch = readFileSync(join(
      repositoryRoot,
      'patches/@nimbus-sh%2Fcore@0.4.0.patch',
    ), 'utf8');
    const workerInstalled = readFileSync(join(
      repositoryRoot,
      'node_modules/@nimbus-sh/worker/dist/session/rpc.js',
    ), 'utf8');
    const workerPatch = readFileSync(join(
      repositoryRoot,
      'patches/@nimbus-sh%2Fworker@0.2.3.patch',
    ), 'utf8');

    for (const artifact of [coreInstalled, corePatch]) {
      expect(artifact).toContain('checkStickyParentMutation');
      expect(artifact).toContain('(parentInode.mode & 0o1000)');
    }
    for (const artifact of [workerInstalled, workerPatch]) {
      expect(artifact).toContain('_rpcWriteProtectedRootFile');
      expect(artifact).toContain('fs.chmod(root, 0o1777)');
      expect(artifact).toContain('fs.chmod(protectedPath, 0o444)');
    }
    expect(corePatch).not.toContain('.bun-tag-');
    expect(workerPatch).not.toContain('.bun-tag-');
  });

  test('the installed worker and checked patch both carry capability WebSocket routing', () => {
    const installed = [
      'node_modules/@nimbus-sh/worker/dist/loaders/process-host.js',
      'node_modules/@nimbus-sh/worker/dist/session/routes.js',
      'node_modules/@nimbus-sh/worker/dist/session/rpc.js',
    ].map((path) => readFileSync(join(repositoryRoot, path), 'utf8')).join('\n');
    const patch = readFileSync(join(
      repositoryRoot,
      'patches/@nimbus-sh%2Fworker@0.2.3.patch',
    ), 'utf8');

    for (const artifact of [installed, patch]) {
      expect(artifact).toContain("request.headers.get('x-nimbus-preview-capability')");
      expect(artifact).toContain('routeHostedWebSocket');
      expect(artifact).toContain('HOSTED_WEBSOCKET_CAPABILITY_HEADER');
      expect(artifact).toContain('webSocketCapability = crypto.randomUUID()');
      expect(artifact).toContain('record.webSocketCapability !== capability');
      expect(artifact).not.toContain('Generic guest WebSocket previews are not supported');
    }
  });
});
