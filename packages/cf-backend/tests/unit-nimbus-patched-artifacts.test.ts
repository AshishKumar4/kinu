import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { Nimbus } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type {
  SqlDatabase,
  SqlValue,
} from '@nimbus-sh/core/runtime/os-contracts.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  LEGACY_WORKSPACE_ROOT, TurnContextBudget, WORKSPACE_ROOT, createFileDispatcher, nimbusSessionFiles, settleWorkspaceRoot,
} from '@kinu.run/core';
import { workspaceBoxFiles } from '@kinu.run/core/workspace';
import { TurnFileLedger } from '../../core/src/tools/file-ledger';

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

    const workspace = await NimbusWorkspace.create({
      sql: workspaceSql(db),
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => db.transaction(fn)() } },
      generation: 1,
      cwd: WORKSPACE_ROOT,
      env: { HOME: WORKSPACE_ROOT },
    });

    // Kinu's boot: the root at /home/main, /home/user a link to it.
    settleWorkspaceRoot(workspace.vfs.as(CRED_KERNEL));
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
