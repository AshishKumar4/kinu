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

  // These read the installed dependency, not a patch file: Nimbus packages come from the registry with the
  // patch set upstreamed, so assert the property, whoever put it there.
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
    // Routing spans three packages by dependency direction: fabric holds `process-host` and the header constant,
    // the worker's session router reads the header, its rpc and routes dispatch. `loaders/process-host` carries none of it.
    const installed = [
      'node_modules/@nimbus-sh/fabric/dist/process-host.js',
      'node_modules/@nimbus-sh/worker/dist/_shared/session-router.js',
      'node_modules/@nimbus-sh/worker/dist/session/routes.js',
      'node_modules/@nimbus-sh/worker/dist/session/rpc.js',
    ].map((path) => readFileSync(join(repositoryRoot, path), 'utf8')).join('\n');

    // Both halves, so neither drifts alone: the constant holds the wire name and the route reads it.
    expect(installed).toContain("PREVIEW_CAPABILITY_HEADER = 'x-nimbus-preview-capability'");
    expect(installed).toContain('request.headers.get(PREVIEW_CAPABILITY_HEADER)');
    expect(installed).toContain('routeHostedWebSocket');
    expect(installed).toContain('HOSTED_WEBSOCKET_CAPABILITY_HEADER');
    expect(installed).toContain('webSocketCapability = crypto.randomUUID()');
    expect(installed).toContain('record.webSocketCapability !== capability');
    expect(installed).not.toContain('Generic guest WebSocket previews are not supported');
  });
});
