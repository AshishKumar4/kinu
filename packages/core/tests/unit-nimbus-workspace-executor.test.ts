import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createTestRuntime, createWorkspaceBundle } from './helpers';
import {
  createNimbusWorkspaceExecutor, createNimbusExecutor,
  nimbusSessionFiles,
  nimbusSessionShell,
  type NimbusSandboxHandle,
} from '../src/execution/nimbus';
import { DefaultExecutionRouter } from '../src/execution/router';
import { createWorkspace, workspaceGenerationStorage } from '../src/vfs/nimbus-workspace';
import type { SQLQueryBindings } from 'bun:sqlite';
import type { SqlValue } from '@nimbus-sh/core';
import type { ExecutorToolResult } from '../src/execution/types';
import { present } from '@kinu.run/test-utils';
import { CommandResultSchema } from '../src/execution/exec-result';

function toolText(result: ExecutorToolResult): string {
  return v.parse(v.string(), result);
}

function fakeBox() {
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const box: NimbusSandboxHandle = {
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
    files: {
      read: async (path) => files.has(path) ? decoder.decode(files.get(path)) : null,
      readBytes: async (path) => files.get(path)?.slice() ?? null,
      write: async (path, content) => {
        files.set(path, content instanceof Uint8Array ? content.slice() : encoder.encode(content));
      },
      stat: async (path) => {
        const bytes = files.get(path);

        return bytes === undefined ? null : { type: 'file', size: bytes.byteLength, mtime: 1 };
      },
      list: async () => [],
      exists: async (path) => files.has(path),
      mkdir: async () => {},
      delete: async (path) => { files.delete(path); },
    },
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
  test('a transport failure never acquires a fabricated process exit', async () => {
    const box = fakeBox();
    box.exec = async (command) => ({ command, success: false, stdout: '', stderr: 'transport unavailable', exitCode: 0 });
    const namespace = createNimbusExecutor({ box });
    const result = await namespace.tools.exec.execute('work');
    expect(result).toMatchObject({ reason: 'io', error: expect.stringContaining('transport unavailable') });
    expect(result).not.toHaveProperty('execution');
    const shell = await nimbusSessionShell(box).exec('work');
    expect(shell).toMatchObject({ exitCode: 0, refusal: { reason: 'io' } });
    expect(shell.refusal).not.toHaveProperty('execution');
  });
  test('one workspace namespace owns both files and the live session', async () => {
    const { rt } = createTestRuntime();
    const box = fakeBox();
    const vfs = nimbusSessionFiles(box);

    const provider = createNimbusWorkspaceExecutor({
      box,
      inline: {
        vfs,
        shell: nimbusSessionShell(box),
        memory: rt.memory,
        craftStore: rt.craftStore,
        sql: rt.storage.sql,
      },
    });

    expect(provider.name).toBe('workspace');
    expect(provider.kind).toBe('workspace');
    expect(provider.types).toContain('namespace workspace');
    expect(provider.types).not.toContain('namespace nimbus');
    const router = new DefaultExecutionRouter({ mode: () => 'allow_all' });
    router.register(provider);
    expect(router.getProviders().map((entry) => entry.name)).toEqual(['workspace']);
    expect(router.getProvider('nimbus')).toBeUndefined();

    const plane = present(provider.files, 'the workspace file plane');

    await plane.writeFile('/home/main/proof.txt', 'same bytes');
    expect(await plane.stat('/home/main/proof.txt')).toEqual({
      size: 10,
      mtimeMs: 1,
      isDir: false,
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

  test('the origin file plane reads a bounded prefix through fixed Node code', async () => {
    const box = fakeBox();
    const expected = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let requestEnv: Record<string, string> | undefined;
    box.exec = async (command, options) => {
      requestEnv = options?.env;

      return {
        command,
        success: true,
        stdout: Buffer.from(expected).toString('base64'),
        stderr: '',
        exitCode: 0,
      };
    };

    const bytes = await nimbusSessionFiles(box).readRange('/home/main/large.png', 0, 512 * 1024);

    expect(bytes).toEqual(expected);
    // Path/offset/length travel only in the reader's JSON env, never interpolated into shell text.
    expect(requestEnv).toBeDefined();
    const payload = Object.values(requestEnv ?? {})[0] ?? '';
    expect(payload).toContain('"path":"/home/main/large.png"');
    expect(payload).toContain('"offset":0');
    expect(payload).toContain('"length":524288');
  });

  test('declares inbound networking only when the host can publish previews', () => {
    const { rt } = createTestRuntime();
    const box = fakeBox();

    const inline = {
      vfs: nimbusSessionFiles(box),
      shell: nimbusSessionShell(box),
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

    const shell = await nimbusSessionShell(box).exec('bun test broken.test.mjs');

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
        vfs: nimbusSessionFiles(box), shell: nimbusSessionShell(box),
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

    const missed = await nimbusSessionShell(box).exec('grep -r thing .');

    expect(missed.refusal?.reason).toBe('unavailable');
    expect(missed.refusal?.error).toContain('sandbox');

    const real = await nimbusSessionShell(box).exec('exit 2');

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
    const missed = await nimbusSessionShell(box).exec('bun test broken.test.mjs');

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
        vfs: nimbusSessionFiles(box), shell: nimbusSessionShell(box),
        memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql,
      },
    });

    await expect(provider.listExposedPorts()).rejects.toMatchObject({
      name: 'KinuError', code: 'unsupported', message: expect.stringContaining(reason),
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
        vfs: nimbusSessionFiles(box), shell: nimbusSessionShell(box),
        memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql,
      },
    });

    expect(await provider.listExposedPorts()).toEqual([
      { port: 4321, url: 'https://4321.example.test', status: 'unknown' },
    ]);
  });
});

describe('a workspace whose host cannot compile node programs', () => {
  const CODEGEN_STDERR = '[probe-8789.js] Code generation from strings disallowed for this context';

  function blockedProvider(box: NimbusSandboxHandle) {
    const { rt } = createTestRuntime();

    return createNimbusWorkspaceExecutor({
      box,
      inline: {
        vfs: nimbusSessionFiles(box), shell: nimbusSessionShell(box),
        memory: rt.memory, craftStore: rt.craftStore, sql: rt.storage.sql,
      },
    });
  }

  test('a command that exited nonzero retains its execution failure', async () => {
    const box = fakeBox();
    box.exec = async (command) => ({
      command, success: false, stdout: '', stderr: CODEGEN_STDERR, exitCode: 1,
    });
    const refusal = await blockedProvider(box).tools.exec.execute('node -e "console.log(1)"');
    expect(refusal).toMatchObject({ reason: 'io', error: expect.stringContaining(CODEGEN_STDERR) });
  });

  test('a node program the host cannot compile refuses as unsupported, naming where it can run', async () => {
    // A missing compiler is `unsupported`, not a retryable `io` failure.
    const box = fakeBox();
    box.exec = async () => { throw new Error(CODEGEN_STDERR); };

    const refusal = await createNimbusExecutor({ box }).tools.exec.execute('node server.js');
    expect(refusal).toMatchObject({ reason: 'unsupported', error: expect.stringContaining('sandbox') });
    expect(String(JSON.stringify(refusal))).not.toContain('Code generation from strings disallowed');
  });

  test('the same compiler failure under a command that never invoked node stays an io failure', async () => {
    // The V8 mark in other output is not the node guard; reclassifying would wrongly forbid retry.
    const box = fakeBox();
    box.exec = async () => { throw new Error(CODEGEN_STDERR); };

    expect(await createNimbusExecutor({ box }).tools.exec.execute('cat build.log')).toMatchObject({ reason: 'io' });
  });

  test('process logs are data even when they contain a compiler failure', async () => {
    const box = fakeBox();
    box.processes = {
      kill: async (pid) => ({ ok: true, pid }),
      logs: async (pid) => ({ pid, text: CODEGEN_STDERR }),
    };
    const logs = await blockedProvider(box).tools.logs.execute(41);
    expect(JSON.parse(toolText(logs))).toEqual({ pid: 41, text: CODEGEN_STDERR });
  });

  test('a port without a listener refuses rather than advertising a working preview', async () => {
    const box = fakeBox();
    box.ports = {
      expose: async () => { throw new Error('No process is listening on workspace port 8789'); },
      unexpose: async () => ({ ok: true }),
      list: async () => [],
    };
    const provider = blockedProvider(box);
    const toolRefusal = JSON.parse(toolText(await provider.tools.exposePort.execute(8789)));
    expect(toolRefusal.reason).toBe('unsupported');
    const direct = await provider.exposePort(8789);
    expect(direct.supported).toBe(false);
  });

  test('an exposure failure that is not an empty port still travels as io', async () => {
    const box = fakeBox();
    box.ports = {
      expose: async () => { throw new Error('preview signing secret is not set'); },
      unexpose: async () => ({ ok: true }),
      list: async () => [],
    };
    const refusal = JSON.parse(toolText(await blockedProvider(box).tools.exposePort.execute(8789)));
    expect(refusal.reason).toBe('io');
  });
});

describe('the embedded workspace removes a tree natively', () => {
  test('a populated directory under a mounted root goes in one removal, and a file removed twice is ENOENT', async () => {
    const database = new Database(':memory:');
    const bundle = createWorkspaceBundle(database);

    try {
      // `/home` is outside the kernel's in-memory nodes.
      await bundle.vfs.mkdir('home/main/tree/a/b', { recursive: true });
      await bundle.vfs.writeFile('home/main/tree/a/b/leaf.txt', 'leaf');
      await bundle.vfs.writeFile('home/main/tree/top.txt', 'top');
      await bundle.vfs.writeFile('home/main/keep.txt', 'keep');

      await bundle.vfs.removeRecursive('home/main/tree');

      expect(await bundle.vfs.exists('home/main/tree')).toBe(false);
      expect(await bundle.vfs.exists('home/main/tree/a/b/leaf.txt')).toBe(false);
      expect(await bundle.vfs.readFile('home/main/keep.txt', { encoding: 'utf8' })).toBe('keep');
      await expect(bundle.vfs.removeRecursive('home/main/tree')).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));
    } finally {
      await bundle.destroy();
      database.close();
    }
  });
});

describe('the workspace generation is fabric\u2019s counter over one row', () => {
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

  test('a bump that did not persist refuses the open, on a boot that is not the first', async () => {
    // Fabric's adopt swallows a failed put; the read-back after it is the whole guard.
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

    await expect(second.session()).rejects.toThrow('could not be persisted');
    expect([...database.query('SELECT value FROM kinu_workspace_generation WHERE id = 1').values()]).toEqual([[1]]);
    database.close();
  });
});
