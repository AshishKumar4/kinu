import { exists, readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createTestRuntime, createWorkspaceBundle } from './helpers';
import { createNimbusWorkspaceExecutor } from '../src/tools/inline-executor';
import {
  nimbusSessionFiles,
  nimbusSessionShell,
  type RemoteSessionBox,
} from '../src/execution/nimbus';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { DefaultExecutionRouter } from '../src/execution/router';
import { createWorkspace, workspaceGenerationStorage } from '../src/vfs/nimbus-workspace';
import type { SQLQueryBindings } from 'bun:sqlite';
import type { SqlValue } from '@nimbus-sh/core';
import type { ExecutorToolResult } from '../src/execution/types';
import { present } from '@kinu.run/test-utils';
import { sessionFilesOver } from '@kinu.run/test-utils/vfs';
import { CommandResultSchema } from '../src/execution/exec-result';
import { executorNamespace } from '../src/tools/executor-operations';
import { namespaceDeclaration } from '../src/tools/operation-surfaces';

/** An executor's namespace as the model reads it. */
const declared = (provider: Parameters<typeof executorNamespace>[0]): string => namespaceDeclaration(provider.name, executorNamespace(provider).declarations ?? {});


function toolText(result: ExecutorToolResult): string {
  return v.parse(v.string(), result);
}

function fakeBox() {
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  const sdkFiles = sessionFilesOver(files);

  const box: RemoteSessionBox = {
    ready: async () => {},
    exec: async (command) => {
      const match = /^cat (.+)$/.exec(command);

      return {
        command,
        success: true,
        stdout: match ? decoder.decode(files.get(match[1]) ?? new Uint8Array()) : '',
        stderr: '',
        exitCode: 0,
      };
    },
    startProcess: async (command) => ({
      command,
      pid: 41,
      process: { pid: 41, command, state: 'running', exitCode: null, longRunning: true },
      ports: [{ port: 4321, pid: 41 }],
      startedAt: 1,
    }),
    files: sdkFiles,
    processes: {
      kill: async (pid) => ({ ok: true, pid }),
      logs: async (pid) => ({ pid, text: 'ready' }),
    },
    ports: {
      expose: async (port) => ({ port, url: `https://${port}.example.test`, route: { reached: true } }),
      unexpose: async () => ({ ok: true }),
      list: async () => [{ port: 4321, url: 'https://4321.example.test' }],
      url: (port) => `https://${port}.example.test`,
    },
  };

  return box;
}

describe('hosted Nimbus workspace provider', () => {
  test('one workspace namespace owns both files and the live session', async () => {
    const { rt } = createTestRuntime();
    const box = fakeBox();
    const vfs = nimbusSessionFiles(box, { home: WORKSPACE_ROOT });

    const provider = createNimbusWorkspaceExecutor({
      box,
      inline: {
        vfs,
        shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }),
        memory: rt.memory,
        craftStore: rt.craftStore,
        sql: rt.storage.sql,
      },
    });

    expect(provider.name).toBe('workspace');
    expect(provider.kind).toBe('workspace');
    expect(declared(provider)).toContain('declare const workspace');
    expect(declared(provider)).toContain('runCode(');
    const router = new DefaultExecutionRouter({ mode: () => 'allow_all' });
    router.register(provider);
    expect(router.getProviders().map((entry) => entry.name)).toEqual(['workspace']);
    expect(router.getProvider('nimbus')).toBeUndefined();

    const plane = present(provider.files, 'the workspace file plane');

    await writeText(plane, '/home/main/proof.txt', 'same bytes');
    expect(await plane.stat('/home/main/proof.txt')).toEqual({
      size: 10,
      mtimeMs: 1,
      type: 'file',
    });
    expect(await provider.tools.exec.execute('cat /home/main/proof.txt')).toBe('same bytes');

    const started = toolText(await provider.tools.startProcess.execute('node server.js'));
    expect(started).toContain('pid=41');
    expect(started).toContain('workspace.logs(41)');
    expect(started).not.toContain('nimbus.');
    expect(await provider.tools.logs.execute(41)).toContain('ready');
    expect(await provider.tools.exposePort.execute(4321))
      .toBe('https://4321.example.test\nverified: a request to this URL reaches the server on port 4321');
    expect(await provider.exposePort(4321)).toEqual({
      supported: true,
      port: 4321,
      url: 'https://4321.example.test',
      route: { reached: true },
    });
  });

  test('declares inbound networking only when the host can publish previews', () => {
    const { rt } = createTestRuntime();
    const box = fakeBox();

    const inline = {
      vfs: nimbusSessionFiles(box, { home: WORKSPACE_ROOT }),
      shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }),
      memory: rt.memory,
      craftStore: rt.craftStore,
      sql: rt.storage.sql,
    };

    expect(createNimbusWorkspaceExecutor({ box, inline }).capabilities.has('net_inbound')).toBe(true);
    expect(createNimbusWorkspaceExecutor({
      box,
      inline,
      inboundNetwork: false,
    }).capabilities.has('net_inbound')).toBe(false);
  });

  test('a command the box answers 127 for names itself and the two remedies', async () => {
    const box = fakeBox();
    box.exec = async (command) => ({
      command, success: false, stdout: '', stderr: 'bun: command not found', exitCode: 127,
    });
    box.runtimes = { list: async () => ({ installed: [], available: [{ name: 'bun' }] }) };

    const shell = await nimbusSessionShell(box, { home: WORKSPACE_ROOT }).exec('bun test broken.test.mjs');

    expect(shell.exitCode).toBe(127);
    expect(shell.refusal?.reason).toBe('unavailable');
    expect(shell.refusal?.error).toContain('bun');
    expect(shell.refusal?.error).toContain('sandbox');
    expect(shell.refusal?.error).toContain('nimbus install');
    expect(shell.stderr).toContain('command not found');

    const { rt } = createTestRuntime();

    const provider = createNimbusWorkspaceExecutor({
      box,
      inline: {
        vfs: nimbusSessionFiles(box, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }),
        memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql,
      },
    });

    const answer = v.parse(CommandResultSchema, await provider.tools.exec.execute('bun test broken.test.mjs'));

    if (v.is(v.string(), answer)) throw new Error('expected a refusal object');

    expect(answer.reason).toBe('unavailable');
    expect(answer.error).toContain('bun');
    expect(answer.error).toContain('nimbus install');
  });

  test('a box without a runtime catalog still names sandbox, and real failures pass through', async () => {
    const box = fakeBox();
    box.exec = async (command) => command.startsWith('exit')
      ? { command, success: false, stdout: '', stderr: 'no', exitCode: 2 }
      : { command, success: false, stdout: '', stderr: 'grep: command not found', exitCode: 127 };
    // Nothing installable: the text may not promise `nimbus install`.

    const missed = await nimbusSessionShell(box, { home: WORKSPACE_ROOT }).exec('grep -r thing .');

    expect(missed.refusal?.reason).toBe('unavailable');
    expect(missed.refusal?.error).toContain('sandbox');

    const real = await nimbusSessionShell(box, { home: WORKSPACE_ROOT }).exec('exit 2');

    expect(real.refusal).toBeUndefined();
    expect(real.exitCode).toBe(2);
  });

  test('a runtime catalog read failure is carried into the refusal, not hidden as "no bins"', async () => {
    const box = fakeBox();
    box.exec = async (command) => ({
      command, success: false, stdout: '', stderr: 'bun: command not found', exitCode: 127,
    });
    box.runtimes = { list: async () => { throw new Error('session box catalog socket closed'); } };

    // A failed catalog read is stated, since "no bins known" and "could not ask" differ.
    const missed = await nimbusSessionShell(box, { home: WORKSPACE_ROOT }).exec('bun test broken.test.mjs');

    expect(missed.exitCode).toBe(127);
    expect(missed.refusal?.reason).toBe('unavailable');
    expect(missed.refusal?.error).toContain('bun');
    expect(missed.refusal?.error).toContain('sandbox');
    expect(missed.refusal?.error).toContain('nimbus install bun');
    expect(missed.refusal?.error).toContain('runtime catalog could not be read');
    expect(missed.refusal?.error).toContain('session box catalog socket closed');
  });

  test('the embedded workspace shell answers its own absent command with the same refusal', async () => {
    const database = new Database(':memory:');
    const bundle = createWorkspaceBundle(database);

    try {
      const missed = await bundle.shell.exec('bun --version');

      expect(missed.exitCode).toBe(127);
      expect(missed.refusal?.reason).toBe('unavailable');
      expect(missed.refusal?.error).toContain('bun');
      expect(missed.refusal?.error).toContain('sandbox');

      const ran = await bundle.shell.exec('echo embedded');

      expect(ran.exitCode).toBe(0);
      expect(ran.refusal).toBeUndefined();
      expect(ran.stdout).toContain('embedded');
    } finally {
      database.close();
    }
  });

  test('a listening port the host cannot address reaches the Ports surface as a reason, not as nothing', async () => {
    // Portless entries keep the host's reason rather than being dropped from the Ports panel.
    const { rt } = createTestRuntime();
    const box = fakeBox();
    const reason = 'the workspace name "MyAgent" cannot be a preview hostname label';
    box.ports = {
      expose: async (port) => ({ port, route: { reached: true } }),
      unexpose: async () => ({ ok: true }),
      list: async () => [{ port: 4321, unavailable: reason }],
    };

    const provider = createNimbusWorkspaceExecutor({
      box,
      inline: {
        vfs: nimbusSessionFiles(box, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }),
        memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql,
      },
    });

    await expect(provider.listExposedPorts()).rejects.toMatchObject({
      name: 'KinuError[unsupported]', code: 'unsupported', message: expect.stringContaining(reason),
    });
    expect(JSON.parse(toolText(await provider.tools.listPorts.execute()))).toEqual([
      { port: 4321, unavailable: reason },
    ]);
  });

  test('a port with a URL still lists, and one the host merely could not price is dropped', async () => {
    // Neither URL nor reason: filtered.
    const { rt } = createTestRuntime();
    const box = fakeBox();
    box.ports = {
      expose: async (port) => ({ port, route: { reached: true } }),
      unexpose: async () => ({ ok: true }),
      list: async () => [{ port: 4321, url: 'https://4321.example.test' }, { port: 9090 }],
    };

    const provider = createNimbusWorkspaceExecutor({
      box,
      inline: {
        vfs: nimbusSessionFiles(box, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }),
        memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql,
      },
    });

    expect(await provider.listExposedPorts()).toEqual([
      { port: 4321, url: 'https://4321.example.test', status: 'unknown' },
    ]);
  });
});

describe('the workspace process and port surface', () => {

  function blockedProvider(box: RemoteSessionBox) {
    const { rt } = createTestRuntime();

    return createNimbusWorkspaceExecutor({
      box,
      inline: {
        vfs: nimbusSessionFiles(box, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }),
        memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql,
      },
    });
  }

  test('a command that exited nonzero retains its execution failure', async () => {
    const box = fakeBox();
    box.exec = async (command) => ({
      command, success: false, stdout: '', stderr: 'node: boom', exitCode: 1,
    });
    const refusal = await blockedProvider(box).tools.exec.execute('node -e "console.log(1)"');
    expect(refusal).toMatchObject({ reason: 'io', error: expect.stringContaining('node: boom') });
  });

  test("a program's workspace.logs(pid, { lines, bytes }) reads the process with both limits", async () => {
    const box = fakeBox();
    const asked: unknown[] = [];

    box.processes = {
      kill: async (pid) => ({ ok: true, pid }),
      logs: async (pid, limits) => {
        asked.push(limits);

        return { pid, text: 'ready' };
      },
    };

    const workspace = executorNamespace(blockedProvider(box)).tools;

    await present(workspace.logs, 'workspace.logs').execute(41, { lines: 20, bytes: 4096 });
    expect(asked).toEqual([{ lines: 20, bytes: 4096 }]);
  });

  test('a port without a listener refuses rather than advertising a working preview', async () => {
    const box = fakeBox();
    box.ports = {
      expose: async () => { throw new Error('nothing is serving port 8789 — start the server, then expose it'); },
      unexpose: async () => ({ ok: true }),
      list: async () => [],
    };
    const provider = blockedProvider(box);
    expect(await provider.tools.exposePort.execute(8789)).toMatchObject({ reason: 'unsupported' });
    const direct = await provider.exposePort(8789);
    expect(direct).toMatchObject({
      supported: false,
      reason: expect.stringContaining('workspace port 8789 has no server listening'),
    });
  });

  test('an exposure failure that is not an empty port still travels as io', async () => {
    const box = fakeBox();
    box.ports = {
      expose: async () => { throw new Error('preview signing secret is not set'); },
      unexpose: async () => ({ ok: true }),
      list: async () => [],
    };
    expect(await blockedProvider(box).tools.exposePort.execute(8789)).toMatchObject({ reason: 'io' });
  });
});

describe('the embedded workspace removes a tree natively', () => {
  test('a populated directory under a mounted root goes in one removal, and a file removed twice is ENOENT', async () => {
    const database = new Database(':memory:');
    const bundle = createWorkspaceBundle(database);

    try {
      // `/home` is outside the kernel's in-memory nodes.
      await bundle.vfs.mkdir('home/main/tree/a/b', { recursive: true });
      await writeText(bundle.vfs, 'home/main/tree/a/b/leaf.txt', 'leaf');
      await writeText(bundle.vfs, 'home/main/tree/top.txt', 'top');
      await writeText(bundle.vfs, 'home/main/keep.txt', 'keep');

      await bundle.vfs.removeRecursive('home/main/tree');

      expect(await exists(bundle.vfs, 'home/main/tree')).toBe(false);
      expect(await exists(bundle.vfs, 'home/main/tree/a/b/leaf.txt')).toBe(false);
      expect(await readText(bundle.vfs, 'home/main/keep.txt')).toBe('keep');
      await expect(bundle.vfs.removeRecursive('home/main/tree')).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));
    } finally {
      await bundle.destroy();
      database.close();
    }
  });
});

describe('the workspace generation is one row, taken in one write transaction', () => {
  test('each open of the same database adopts the next generation, and the pid floor follows it', async () => {
    const database = new Database(':memory:');
    const first = createWorkspaceBundle(database);
    const firstPid = (await first.session()).processes.spawn('probe', [], '/home/main').pid;
    // A second open models eviction and restart: pids must not repeat.
    const second = createWorkspaceBundle(database);
    const secondPid = (await second.session()).processes.spawn('probe', [], '/home/main').pid;

    expect(firstPid).toBeGreaterThan(1_000_000);
    expect(secondPid).toBeGreaterThan(firstPid + 1_000_000 - 1);
    expect([...database.query('SELECT value FROM kinu_workspace_generation WHERE id = 1').values()]).toEqual([[2]]);
    database.close();
  });

  test('a generation write that fails refuses the open and leaves the counter where it was', async () => {
    const database = new Database(':memory:');
    const first = createWorkspaceBundle(database);
    await first.session();

    const sql = {
      exec(query: string, ...bindings: SqlValue[]) {
        if (/INSERT INTO kinu_workspace_generation/.test(query)) throw new Error('storage write failed');
        const statement = database.prepare<{ value: number }, SQLQueryBindings[]>(query);
        const bound = bindings.map((binding) => v.parse(v.union([v.string(), v.number(), v.null()]), binding));

        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
        statement.run(...bound);

        return [];
      },
    };

    const second = createWorkspace({
      sql,
      transactions: { storage: { transactionSync: <T,>(cb: () => T): T => database.transaction(cb)() } },
      generation: workspaceGenerationStorage(sql),
    });

    await expect(second.session()).rejects.toThrow();
    expect([...database.query('SELECT value FROM kinu_workspace_generation WHERE id = 1').values()]).toEqual([[1]]);
    database.close();
  });
});
