import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import {
  createNimbusWorkspaceExecutor,
  nimbusSessionFiles,
  nimbusSessionShell,
  type NimbusSandboxHandle,
} from '../src/execution/nimbus.js';
import { DefaultExecutionRouter } from '../src/execution/router.js';

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
});
