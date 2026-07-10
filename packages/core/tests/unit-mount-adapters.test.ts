/**
 * Mount adapters — VFS views over the executors' RAW handles (never their
 * LLM tools). Verifies the honest synthesis of the methods each handle lacks
 * (sandbox stat/mkdir, nimbus stat, device stat/mkdir/unlink), the /pc
 * consent-scoped root with the full-filesystem tier, and the end-to-end
 * composite routing (/sandbox/etc/hosts → the container's /etc/hosts).
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  CompositeVFS,
  createSandboxMountVFS, createNimbusMountVFS, createDeviceMountVFS,
} from '../src/vfs/index.js';
import type { SandboxHandle } from '../src/execution/sandbox.js';
import type { NimbusSandboxHandle, NimbusExecResult } from '../src/execution/nimbus.js';
import type { DeviceTransport } from '../src/execution/ssh.js';
import { createInlineVFS } from '../src/identity/inline-primitives.js';
import { makeSql } from './helpers.js';

const code = (e: unknown) => (e as { code?: string }).code;

// ── fake raw handles ───────────────────────────────────────────────────────

function fakeSandboxHandle() {
  const calls: string[] = [];
  const files = new Map<string, string>([['/workspace/app.ts', 'export {}'], ['/etc/hosts', '127.0.0.1 localhost']]);
  const listings: Record<string, Array<{ name?: string; path?: string; type?: string; size?: number; isDirectory?: boolean }>> = {
    '/workspace': [
      { name: 'app.ts', type: 'file', size: 9 },
      { path: '/workspace/src', isDirectory: true },
    ],
    '/': [{ name: 'workspace', type: 'directory' }, { name: 'etc', type: 'directory' }],
  };
  const handle: SandboxHandle = {
    async exec(command) {
      calls.push(`exec:${command}`);
      if (command.startsWith('test -e ')) {
        const path = command.match(/'([^']+)'/)?.[1] ?? '';
        return { stdout: files.has(path) || path in listings ? 'true' : 'false', exitCode: 0 };
      }
      if (command.startsWith('mkdir')) {
        if (command.includes('denied')) return { stdout: '', stderr: 'mkdir: cannot create directory: Permission denied', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    },
    async readFile(path) {
      calls.push(`read:${path}`);
      const content = files.get(path);
      return content == null ? { exitCode: 1 } : { content, exitCode: 0 };
    },
    async writeFile(path, content) { calls.push(`write:${path}`); files.set(path, content); },
    async listFiles(path) {
      calls.push(`list:${path}`);
      const entries = listings[path];
      if (!entries) throw new Error(`no such directory: ${path}`);
      return { files: entries };
    },
    async deleteFile(path) { calls.push(`delete:${path}`); files.delete(path); },
    async exposePort(port) { return { url: '', port }; },
    async unexposePort() {},
    async getExposedPorts() { return []; },
    async createBackup() { return { id: 'b', dir: '/workspace' }; },
    async restoreBackup() { return { success: true, dir: '/workspace', id: 'b' }; },
  };
  return { handle, calls, files };
}

function fakeNimbusBox() {
  const calls: string[] = [];
  const files = new Map<string, string | Uint8Array>([['/home/user/notes.md', '# hi']]);
  const ok = (stdout: string): NimbusExecResult =>
    ({ command: '', success: true, stdout, stderr: '', exitCode: 0 });
  const fail = (stderr: string): NimbusExecResult =>
    ({ command: '', success: false, stdout: '', stderr, exitCode: 1 });
  const box: NimbusSandboxHandle = {
    async ready() {},
    async exec(command) {
      calls.push(`exec:${command}`);
      if (command.startsWith("stat -c ")) {
        const path = command.match(/'([^']+)'$/)?.[1] ?? '';
        if (path === '/home/user') return ok('4096 1700000000 directory');
        if (files.has(path)) return ok(`4 1700000100 regular file`);
        return fail(`stat: cannot statx '${path}': No such file or directory`);
      }
      return ok('');
    },
    files: {
      async read(path) { calls.push(`read:${path}`); const c = files.get(path); return c == null ? null : String(c); },
      async write(path, content) { calls.push(`write:${path}`); files.set(path, content); },
      async list(path) { calls.push(`list:${path}`); return [{ name: 'notes.md', isDir: false, size: 4 }]; },
      async exists(path) { calls.push(`exists:${path}`); return files.has(path); },
      async mkdir(path) { calls.push(`mkdir:${path}`); },
      async delete(path, options) {
        calls.push(`delete:${path}${options?.recursive ? ':recursive' : ''}`);
        if (!files.delete(path)) throw new Error(`no such file: ${path}`);
      },
    },
  };
  return { box, calls, files };
}

function fakeDeviceTransport(opts: { home?: string } = {}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const files = new Map<string, string>([
    ['/home/me/proj/readme.md', 'hello'],
    ['/etc/passwd', 'root:x:0:0'],
  ]);
  const transport: DeviceTransport = {
    status: () => ({ connected: true, registered: true }),
    refreshStatus: async () => ({ connected: true, registered: true }),
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'exec') {
        const command = String(params[0]);
        if (command === 'printf %s "$HOME"') return { stdout: opts.home ?? '/home/me', stderr: '', exitCode: 0 };
        if (command.startsWith('stat ')) {
          const path = command.match(/'([^']+)' 2>\/dev\/null/)?.[1] ?? '';
          if (files.has(path)) return { stdout: '5 1700000200 regular file', stderr: '', exitCode: 0 };
          if (path === '/home/me/proj') return { stdout: '4096 1700000000 directory', stderr: '', exitCode: 0 };
          return { stdout: '', stderr: 'stat: No such file or directory', exitCode: 1 };
        }
        if (command.startsWith('rm ')) {
          const path = command.match(/'([^']+)'/)?.[1] ?? '';
          if (!files.delete(path)) return { stdout: '', stderr: `rm: ${path}: No such file or directory`, exitCode: 1 };
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.startsWith('mkdir ')) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (method === 'readFile') {
        const content = files.get(String(params[0]));
        if (content == null) throw new Error(`ENOENT: no such file or directory, open '${String(params[0])}'`);
        return content;
      }
      if (method === 'writeFile') { files.set(String(params[0]), String(params[1])); return { success: true }; }
      if (method === 'listFiles') return [{ name: 'readme.md', type: 'file' }];
      if (method === 'exists') return files.has(String(params[0]));
      throw new Error(`unknown method: ${method}`);
    },
  };
  return { transport, calls, files };
}

// ── /sandbox adapter ───────────────────────────────────────────────────────

describe('sandbox mount adapter (raw SandboxHandle)', () => {
  test('readFile returns utf8 text or encoded bytes; missing → ENOENT', async () => {
    const { handle } = fakeSandboxHandle();
    const vfs = createSandboxMountVFS(handle);
    expect(await vfs.readFile('/workspace/app.ts', { encoding: 'utf8' })).toBe('export {}');
    const bytes = await vfs.readFile('/workspace/app.ts') as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toBe('export {}');
    expect(await vfs.readFile('/nope').catch(code)).toBe('ENOENT');
  });

  test('stat is synthesized from the parent listing (no native stat)', async () => {
    const { handle } = fakeSandboxHandle();
    const vfs = createSandboxMountVFS(handle);
    expect(await vfs.stat('/workspace/app.ts')).toEqual({ size: 9, mtime: 0, isDir: false });
    expect(await vfs.stat('/workspace/src')).toEqual({ size: 0, mtime: 0, isDir: true });
    expect(await vfs.stat('/workspace/missing.ts')).toBeNull();
    expect(await vfs.stat('/nope/deep')).toBeNull();
    expect(await vfs.stat('/')).toEqual({ size: 0, mtime: 0, isDir: true });
  });

  test('mkdir/exists are synthesized via exec; readdir/unlink use the handle', async () => {
    const { handle, calls, files } = fakeSandboxHandle();
    const vfs = createSandboxMountVFS(handle);
    await vfs.mkdir('/workspace/deep/dir', { recursive: true });
    expect(calls).toContain("exec:mkdir -p -- '/workspace/deep/dir'");
    expect(await vfs.mkdir('/denied').catch(code)).toBe('EACCES');

    expect(await vfs.readdir('/workspace')).toEqual(['app.ts', 'src']);
    expect(await vfs.exists('/etc/hosts')).toBe(true);
    await vfs.unlink('/workspace/app.ts');
    expect(files.has('/workspace/app.ts')).toBe(false);

    await vfs.writeFile('/workspace/new.ts', new TextEncoder().encode('bytes'));
    expect(files.get('/workspace/new.ts')).toBe('bytes');
  });
});

// ── /nimbus adapter ────────────────────────────────────────────────────────

describe('nimbus mount adapter (raw NimbusSandboxHandle)', () => {
  test('files.* map directly; null read → ENOENT', async () => {
    const { box, calls } = fakeNimbusBox();
    const vfs = createNimbusMountVFS(box);
    expect(await vfs.readFile('/home/user/notes.md', { encoding: 'utf8' })).toBe('# hi');
    expect(await vfs.readFile('/home/user/none.md').catch(code)).toBe('ENOENT');
    expect(await vfs.readdir('/home/user')).toEqual(['notes.md']);
    expect(await vfs.exists('/home/user/notes.md')).toBe(true);
    await vfs.mkdir('/home/user/dir');
    expect(calls).toContain('mkdir:/home/user/dir');
  });

  test('stat is synthesized via stat(1) with real size + mtime', async () => {
    const { box } = fakeNimbusBox();
    const vfs = createNimbusMountVFS(box);
    expect(await vfs.stat('/home/user/notes.md')).toEqual({ size: 4, mtime: 1700000100000, isDir: false });
    expect(await vfs.stat('/home/user')).toEqual({ size: 4096, mtime: 1700000000000, isDir: true });
    expect(await vfs.stat('/home/user/none.md')).toBeNull();
  });

  test('unlink is file-scoped — never a recursive delete', async () => {
    const { box, calls } = fakeNimbusBox();
    const vfs = createNimbusMountVFS(box);
    await vfs.unlink('/home/user/notes.md');
    expect(calls).toContain('delete:/home/user/notes.md');
    expect(calls.some((c) => c.includes(':recursive'))).toBe(false);
    expect(vfs.unlink('/home/user/none.md')).rejects.toThrow('no such file');
  });
});

// ── /pc adapter (consent-scoped) ───────────────────────────────────────────

describe('device mount adapter (raw DeviceTransport + consent scope)', () => {
  const subtreeConsent = (root: string | null, fullFs = false) => ({
    consentedRoot: () => root,
    hasFullFilesystem: async () => fullFs,
  });

  test('paths inside the consented subtree work end to end', async () => {
    const { transport, files } = fakeDeviceTransport();
    const vfs = createDeviceMountVFS(transport, subtreeConsent('/home/me/proj'));
    expect(await vfs.readFile('/home/me/proj/readme.md', { encoding: 'utf8' })).toBe('hello');
    expect(await vfs.readdir('/home/me/proj')).toEqual(['readme.md']);
    expect(await vfs.stat('/home/me/proj/readme.md')).toEqual({ size: 5, mtime: 1700000200000, isDir: false });
    expect(await vfs.exists('/home/me/proj/readme.md')).toBe(true);
    await vfs.writeFile('/home/me/proj/out.txt', 'x');
    expect(files.get('/home/me/proj/out.txt')).toBe('x');
    await vfs.unlink('/home/me/proj/out.txt');
    expect(files.has('/home/me/proj/out.txt')).toBe(false);
    await vfs.mkdir('/home/me/proj/dir', { recursive: true });
  });

  test('SECURITY: escaping the consented subtree is denied without the full-fs tier', async () => {
    const { transport, calls } = fakeDeviceTransport();
    const vfs = createDeviceMountVFS(transport, subtreeConsent('/home/me/proj'));
    const err = await vfs.readFile('/etc/passwd').catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('EACCES');
    expect((err as Error).message).toContain("outside the consented device directory '/home/me/proj'");
    expect((err as Error).message).toContain('full-filesystem consent tier');
    // Sibling prefix does not sneak past the boundary check.
    expect(await vfs.readFile('/home/me/projects/x').catch(code)).toBe('EACCES');
    // Every op is guarded, including writes, listings, stat and exists.
    expect(await vfs.writeFile('/etc/cron.d/evil', 'x').catch(code)).toBe('EACCES');
    expect(await vfs.readdir('/etc').catch(code)).toBe('EACCES');
    expect(await vfs.stat('/etc/passwd').catch(code)).toBe('EACCES');
    expect(await vfs.exists('/etc/passwd').catch(code)).toBe('EACCES');
    expect(await vfs.unlink('/etc/passwd').catch(code)).toBe('EACCES');
    expect(await vfs.mkdir('/opt/x').catch(code)).toBe('EACCES');
    // The denial happened locally — nothing was sent to the device.
    expect(calls).toEqual([]);
  });

  test('the full-filesystem tier lifts the subtree scope', async () => {
    const { transport } = fakeDeviceTransport();
    const vfs = createDeviceMountVFS(transport, subtreeConsent('/home/me/proj', true));
    expect(await vfs.readFile('/etc/passwd', { encoding: 'utf8' })).toBe('root:x:0:0');
  });

  test('no connect dir → the consented root falls back to the device home (resolved once)', async () => {
    const { transport, calls } = fakeDeviceTransport();
    const vfs = createDeviceMountVFS(transport, subtreeConsent(null));
    expect(await vfs.readFile('/home/me/proj/readme.md', { encoding: 'utf8' })).toBe('hello');
    expect(await vfs.exists('/home/me/proj/readme.md')).toBe(true);
    expect(await vfs.readFile('/etc/passwd').catch(code)).toBe('EACCES');
    expect(calls.filter((c) => c.method === 'exec' && String(c.params[0]).includes('$HOME')).length).toBe(1);
  });

  test('unresolvable home fails closed', async () => {
    const { transport } = fakeDeviceTransport({ home: '' });
    const vfs = createDeviceMountVFS(transport, subtreeConsent(null));
    const err = await vfs.readFile('/anything').catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('EACCES');
    expect((err as Error).message).toContain('cannot determine the consented device directory');
  });

  test('synthesized unlink surfaces honest shell errors', async () => {
    const { transport } = fakeDeviceTransport();
    const vfs = createDeviceMountVFS(transport, subtreeConsent(null, true));
    expect(await vfs.unlink('/home/me/proj/none.txt').catch(code)).toBe('ENOENT');
  });
});

// ── end-to-end through the CompositeVFS ────────────────────────────────────

describe('composite routing over the mount adapters', () => {
  test("readFile('/sandbox/etc/hosts') reads the container's real /etc/hosts", async () => {
    const composite = new CompositeVFS({ local: createInlineVFS(makeSql(new Database(':memory:'))) });
    const sandbox = fakeSandboxHandle();
    composite.mount('sandbox', {
      vfs: createSandboxMountVFS(sandbox.handle),
      policy: { readOnly: false, rootPath: '/', consistency: 'ephemeral', credentialsStayInHost: true },
      workingDir: '/workspace',
    });

    expect(await composite.readFile('/sandbox/etc/hosts', { encoding: 'utf8' })).toBe('127.0.0.1 localhost');
    expect(await composite.readFile('/sandbox/workspace/app.ts', { encoding: 'utf8' })).toBe('export {}');
    expect(sandbox.calls).toContain('read:/etc/hosts');
    expect(await composite.readdir('/')).toEqual(['local', 'sandbox']);
    expect(composite.listMounts().find((m) => m.name === 'sandbox')?.cwd).toBe('/sandbox/workspace');
  });

  test("readdir('/') tracks the /pc mount's live device connection", async () => {
    const composite = new CompositeVFS({ local: createInlineVFS(makeSql(new Database(':memory:'))) });
    let connected = false;
    const { transport } = fakeDeviceTransport();
    composite.mount('pc', {
      vfs: createDeviceMountVFS(transport, { consentedRoot: () => '/home/me', hasFullFilesystem: async () => false }),
      policy: { readOnly: false, rootPath: '/', consistency: 'live-shared', credentialsStayInHost: true },
      live: () => connected,
    });

    expect(await composite.readdir('/')).toEqual(['local']);
    expect(await composite.readFile('/pc/home/me/x').catch(code)).toBe('ENXIO');
    connected = true;
    expect(await composite.readdir('/')).toEqual(['local', 'pc']);
    expect(await composite.readFile('/pc/home/me/proj/readme.md', { encoding: 'utf8' })).toBe('hello');
  });
});
