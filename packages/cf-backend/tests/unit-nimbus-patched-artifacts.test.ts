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

  // These two used to read the patch file beside the installed copy, because the
  // property lived in a patch this repository carried. It does not any more: the
  // whole Nimbus patch set was upstreamed and the packages are consumed from the
  // registry. So the assertion follows the property rather than the mechanism —
  // what matters is that the INSTALLED dependency has it, whoever put it there.
  test('the installed core and worker preserve the owner-only file boundary', () => {
    const coreInstalled = readFileSync(join(
      repositoryRoot,
      'node_modules/@nimbus-sh/core/src/vfs/sqlite-vfs.ts',
    ), 'utf8');
    const workerInstalled = readFileSync(join(
      repositoryRoot,
      'node_modules/@nimbus-sh/worker/dist/session/rpc.js',
    ), 'utf8');

    expect(coreInstalled).toContain('checkStickyParentMutation');
    expect(coreInstalled).toContain('(parentInode.mode & 0o1000)');
    expect(workerInstalled).toContain('_rpcWriteProtectedRootFile');
    expect(workerInstalled).toContain('fs.chmod(root, 0o1777)');
    expect(workerInstalled).toContain('fs.chmod(protectedPath, 0o444)');
  });

  test('the installed packages carry capability WebSocket routing', () => {
    // The routing is spread across three packages by dependency direction, and
    // each file below is the one that measurably carries its share: fabric holds
    // `process-host` and mints the capability, because fabric depends on core
    // while worker depends on fabric, so the header constant belongs on the lower
    // layer; the worker's session router reads the request header; and its rpc and
    // routes compare and dispatch. Reading the worker's own `loaders/process-host`
    // would pass over a file that no longer carries any of this and assert nothing.
    const installed = [
      'node_modules/@nimbus-sh/fabric/dist/process-host.js',
      'node_modules/@nimbus-sh/worker/dist/_shared/session-router.js',
      'node_modules/@nimbus-sh/worker/dist/session/routes.js',
      'node_modules/@nimbus-sh/worker/dist/session/rpc.js',
    ].map((path) => readFileSync(join(repositoryRoot, path), 'utf8')).join('\n');

    // Upstream named the header instead of inlining it, which is a better shape
    // than the patch had. Both halves are asserted so neither can drift alone: the
    // constant must still hold the wire name, and the route must still read it.
    expect(installed).toContain("PREVIEW_CAPABILITY_HEADER = 'x-nimbus-preview-capability'");
    expect(installed).toContain('request.headers.get(PREVIEW_CAPABILITY_HEADER)');
    expect(installed).toContain('routeHostedWebSocket');
    expect(installed).toContain('HOSTED_WEBSOCKET_CAPABILITY_HEADER');
    expect(installed).toContain('webSocketCapability = crypto.randomUUID()');
    expect(installed).toContain('record.webSocketCapability !== capability');
    expect(installed).not.toContain('Generic guest WebSocket previews are not supported');
  });
});
