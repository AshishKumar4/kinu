import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from './helpers';
import {
  createNimbusWorkspaceExecutor,
  nimbusSessionFiles,
  nimbusSessionShell,
  type NimbusSandboxHandle,
} from '../src/execution/nimbus';
import { DefaultExecutionRouter } from '../src/execution/router';

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
      stat: async (path) => files.has(path) ? { type: 'file', size: files.get(path)!.byteLength, mtime: 1 } : null,
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
      expose: async (port) => ({ port, url: `https://${port}.example.test`, listening: true }),
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

    await provider.files!.writeFile('/home/user/proof.txt', 'same bytes');
    expect(await provider.files!.stat('/home/user/proof.txt')).toEqual({
      size: 10,
      mtimeMs: 1,
      isDir: false,
    });
    expect(await provider.tools.exec.execute('cat /home/user/proof.txt')).toBe('same bytes');

    const started = String(await provider.tools.startProcess.execute('node server.js'));
    expect(started).toContain('pid=41');
    expect(started).toContain('workspace.logs(41)');
    expect(started).not.toContain('nimbus.');
    expect(await provider.tools.logs.execute(41)).toContain('ready');
    expect(await provider.tools.exposePort.execute(4321)).toBe('https://4321.example.test');
    expect(await provider.exposePort!(4321)).toEqual({
      supported: true,
      port: 4321,
      url: 'https://4321.example.test',
      verified_listening: true,
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

    const bytes = await nimbusSessionFiles(box).readRange('/home/user/large.png', 0, 512 * 1024);

    expect(bytes).toEqual(expected);
    // The reader is fixed Node source. Path, offset and length travel only in
    // its JSON environment payload — never interpolated into shell text — and
    // it receives the admitted window, not an implicit whole-file read.
    expect(requestEnv).toBeDefined();
    const payload = Object.values(requestEnv ?? {})[0] ?? '';
    expect(payload).toContain('"path":"/home/user/large.png"');
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

  test('a listening port the host cannot address reaches the Ports surface as a reason, not as nothing', async () => {
    // The host says why a port has no URL (a deployment with no preview host,
    // a workspace whose name no hostname label can carry). Dropping the entry
    // showed the owner an empty Ports panel over live servers.
    const { rt } = createTestRuntime();
    const box = fakeBox();
    const reason = 'the workspace name "MyAgent" cannot be a preview hostname label';
    box.ports = {
      expose: async (port) => ({ port, listening: true }),
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
    // The model reads the same reason on its own listing.
    expect(JSON.parse(String(await provider.tools.listPorts.execute()))).toEqual([
      { port: 4321, unavailable: reason },
    ]);
  });

  test('a port with a URL still lists, and one the host merely could not price is dropped', async () => {
    // No reason means no claim: an entry with neither URL nor reason is the
    // pre-existing shape (an SDK that answers no URL) and stays filtered.
    const { rt } = createTestRuntime();
    const box = fakeBox();
    box.ports = {
      expose: async (port) => ({ port, listening: true }),
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

  test('exec answers the container, not the compiler', async () => {
    // The hosted runtime forbids `new Function`, so the workspace `node` shim
    // dies as a raw V8 error. The model branches on `reason`, so the tool
    // answers the classified refusal naming the container a served port needs.
    const box = fakeBox();
    box.exec = async (command) => ({
      command, success: false, stdout: '', stderr: CODEGEN_STDERR, exitCode: 1,
    });
    const refusal = JSON.parse(String(await blockedProvider(box).tools.exec.execute('node -e \'console.log(1)\'')));
    expect(refusal.reason).toBe('unsupported');
    expect(refusal.error).toContain('sandbox');
  });

  test('a dead server reads the same way in its logs', async () => {
    // `startProcess` reports the pid while the process is still compiling; the
    // failure lands in `logs`. A log that carries the compiler's complaint is
    // the same fact as the exec above and gets the same classification.
    const box = fakeBox();
    box.processes = {
      kill: async (pid) => ({ ok: true, pid }),
      logs: async (pid) => ({ pid, text: CODEGEN_STDERR }),
    };
    const refusal = JSON.parse(String(await blockedProvider(box).tools.logs.execute(41)));
    expect(refusal.reason).toBe('unsupported');
    expect(refusal.error).toContain('sandbox');
  });

  test('exposing a port nothing listens on names the container', async () => {
    // No node program starts on this host, so no workspace port will ever
    // listen. The exposure answers where a server CAN run instead of the
    // transport's `io`.
    const box = fakeBox();
    box.ports = {
      expose: async () => { throw new Error('No process is listening on workspace port 8789'); },
      unexpose: async () => ({ ok: true }),
      list: async () => [],
    };
    const provider = blockedProvider(box);
    const toolRefusal = JSON.parse(String(await provider.tools.exposePort.execute(8789)));
    expect(toolRefusal.reason).toBe('unsupported');
    expect(toolRefusal.error).toContain('sandbox');
    const direct = await provider.exposePort!(8789);
    expect(direct).toEqual({ supported: false, reason: expect.stringContaining('sandbox') });
  });

  test('an exposure failure that is not an empty port still travels as io', async () => {
    // Only the no-listener shape is reclassified; anything else keeps the
    // seam's own answer for an unrecognised transport failure.
    const box = fakeBox();
    box.ports = {
      expose: async () => { throw new Error('preview signing secret is not set'); },
      unexpose: async () => ({ ok: true }),
      list: async () => [],
    };
    const refusal = JSON.parse(String(await blockedProvider(box).tools.exposePort.execute(8789)));
    expect(refusal.reason).toBe('io');
  });
});
