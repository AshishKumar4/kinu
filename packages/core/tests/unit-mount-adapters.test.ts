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
  createParentRpcMountVFS,
  type ParentRpcFileHandle, type ParentRpcResult, type ParentRpcWrite,
} from '../src/vfs/index.js';
import type { SandboxHandle } from '../src/execution/sandbox.js';
import type { NimbusSandboxHandle, NimbusExecResult } from '../src/execution/nimbus.js';
import type { DeviceTransport } from '../src/execution/device-tunnel-executor.js';
import { createInlineVFS } from '../src/identity/inline-primitives.js';
import { makeSql } from './helpers.js';

const code = (e: unknown) => (e as { code?: string }).code;

// ── fake raw handles ───────────────────────────────────────────────────────

function fakeSandboxHandle() {
  const calls: string[] = [];
  // Models the SDK: binary content is stored as bytes and read back base64-
  // flagged; text stays text.
  const files = new Map<string, string | Uint8Array>([['/workspace/app.ts', 'export {}'], ['/etc/hosts', '127.0.0.1 localhost']]);
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
      if (content == null) return { exitCode: 1 };
      if (content instanceof Uint8Array) {
        return { content: Buffer.from(content).toString('base64'), encoding: 'base64', isBinary: true, exitCode: 0 };
      }
      return { content, exitCode: 0 };
    },
    async writeFile(path, content, opts) {
      calls.push(`write:${path}`);
      files.set(path, opts?.encoding === 'base64' ? new Uint8Array(Buffer.from(content, 'base64')) : content);
    },
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
      async readBytes(path) {
        calls.push(`readBytes:${path}`);
        const c = files.get(path);
        return c == null ? null : typeof c === 'string' ? new TextEncoder().encode(c) : c;
      },
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
  const files = new Map<string, string | Uint8Array>([
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
        // Daemon protocol: an { encoding: 'base64' } option answers in the
        // self-describing base64 shape; the default stays plain text.
        if ((params[1] as { encoding?: string } | undefined)?.encoding === 'base64') {
          const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
          return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
        }
        return typeof content === 'string' ? content : new TextDecoder().decode(content);
      }
      if (method === 'writeFile') {
        const body = (params[2] as { encoding?: string } | undefined)?.encoding === 'base64'
          ? new Uint8Array(Buffer.from(String(params[1]), 'base64'))
          : String(params[1]);
        files.set(String(params[0]), body);
        return { success: true };
      }
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
    expect(await vfs.stat('/workspace/app.ts')).toEqual({ size: 9, mtimeMs: 0, isDir: false });
    expect(await vfs.stat('/workspace/src')).toEqual({ size: 0, mtimeMs: 0, isDir: true });
    expect(await vfs.stat('/workspace/missing.ts')).toBeNull();
    expect(await vfs.stat('/nope/deep')).toBeNull();
    expect(await vfs.stat('/')).toEqual({ size: 0, mtimeMs: 0, isDir: true });
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
    expect(files.get('/workspace/new.ts')).toEqual(new TextEncoder().encode('bytes')); // byte-exact via base64
  });

  test('BINARY round-trip: non-utf8 bytes survive write→read exactly (base64 both ways)', async () => {
    const { handle, files } = fakeSandboxHandle();
    const vfs = createSandboxMountVFS(handle);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

    await vfs.writeFile('/workspace/logo.png', png);
    expect(files.get('/workspace/logo.png')).toEqual(png); // landed byte-exact, never TextDecoder'd
    expect(await vfs.readFile('/workspace/logo.png')).toEqual(png);
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
    expect(await vfs.stat('/home/user/notes.md')).toEqual({ size: 4, mtimeMs: 1700000100000, isDir: false });
    expect(await vfs.stat('/home/user')).toEqual({ size: 4096, mtimeMs: 1700000000000, isDir: true });
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

  test('BINARY round-trip: Uint8Array passes to files.write natively and reads back via readBytes', async () => {
    const { box, files } = fakeNimbusBox();
    const vfs = createNimbusMountVFS(box);
    const bin = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x00]);

    await vfs.writeFile('/home/user/blob.bin', bin);
    expect(files.get('/home/user/blob.bin')).toEqual(bin);
    expect(await vfs.readFile('/home/user/blob.bin')).toEqual(bin);
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
    expect(await vfs.stat('/home/me/proj/readme.md')).toEqual({ size: 5, mtimeMs: 1700000200000, isDir: false });
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

  test('BINARY round-trip: non-utf8 bytes ride the daemon base64 protocol; text stays plain', async () => {
    const { transport, files, calls } = fakeDeviceTransport();
    const vfs = createDeviceMountVFS(transport, subtreeConsent('/home/me/proj'));
    const bin = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x80]);

    await vfs.writeFile('/home/me/proj/blob.bin', bin);
    expect(files.get('/home/me/proj/blob.bin')).toEqual(bin); // landed byte-exact on the "device"
    expect(await vfs.readFile('/home/me/proj/blob.bin')).toEqual(bin);

    // utf8-lossless bytes ride the plain-string write every daemon speaks.
    await vfs.writeFile('/home/me/proj/notes.txt', new TextEncoder().encode('plain'));
    const write = calls.filter((c) => c.method === 'writeFile').find((c) => String(c.params[0]).endsWith('notes.txt'));
    expect(write?.params[1]).toBe('plain');
    expect(write?.params[2]).toBeUndefined();

    // A leading BOM is text but must not be stripped by the lossless check.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    await vfs.writeFile('/home/me/proj/bom.txt', bom);
    const stored = files.get('/home/me/proj/bom.txt');
    const storedBytes = typeof stored === 'string' ? new TextEncoder().encode(stored) : stored;
    expect(storedBytes).toEqual(bom);
  });

  test('an older daemon (no base64 support) still answers text reads correctly', async () => {
    const files = new Map<string, string>([['/home/me/proj/readme.md', 'hello']]);
    const transport: DeviceTransport = {
      status: () => ({ connected: true, registered: true }),
      refreshStatus: async () => ({ connected: true, registered: true }),
      async rpc(method, params) {
        // Ignores the encoding option entirely — the v0 plain-string reply.
        if (method === 'readFile') return files.get(String(params[0])) ?? '';
        throw new Error(`unexpected method: ${method}`);
      },
    };
    const vfs = createDeviceMountVFS(transport, subtreeConsent('/home/me/proj'));
    expect(await vfs.readFile('/home/me/proj/readme.md', { encoding: 'utf8' })).toBe('hello');
    expect(await vfs.readFile('/home/me/proj/readme.md')).toEqual(new TextEncoder().encode('hello'));
  });
});

// ── end-to-end through the CompositeVFS ────────────────────────────────────

const rpcOk = <T>(value: T): ParentRpcResult<T> => ({ ok: true, value });

class MemoryParentRpcHandle implements ParentRpcFileHandle {
  readonly calls: Array<{ method: keyof ParentRpcFileHandle; path: string }> = [];
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set(['']);

  async read(path: string): Promise<ParentRpcResult<Uint8Array>> {
    this.calls.push({ method: 'read', path });
    const data = this.files.get(path);
    return data === undefined
      ? { ok: false, error: { code: 'ENOENT', message: `ENOENT: no such file '${path}'`, path } }
      : rpcOk(data);
  }

  async write(input: ParentRpcWrite): Promise<ParentRpcResult<null>> {
    this.calls.push({ method: 'write', path: input.path });
    if (input.kind === 'directory') {
      this.directories.add(input.path);
    } else {
      this.files.set(input.path, typeof input.data === 'string'
        ? new TextEncoder().encode(input.data)
        : input.data);
    }
    return rpcOk(null);
  }

  async list(path: string): Promise<ParentRpcResult<string[]>> {
    this.calls.push({ method: 'list', path });
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Set<string>();
    for (const entry of [...this.files.keys(), ...this.directories]) {
      if (!entry.startsWith(prefix) || entry === path) continue;
      const relative = entry.slice(prefix.length);
      if (relative && !relative.includes('/')) entries.add(relative);
    }
    return rpcOk([...entries]);
  }

  async stat(path: string): Promise<ParentRpcResult<{ size: number; mtimeMs: number; isDir: boolean } | null>> {
    this.calls.push({ method: 'stat', path });
    const data = this.files.get(path);
    if (data !== undefined) return rpcOk({ size: data.byteLength, mtimeMs: 1, isDir: false });
    return rpcOk(this.directories.has(path) ? { size: 0, mtimeMs: 1, isDir: true } : null);
  }

  async delete(path: string): Promise<ParentRpcResult<null>> {
    this.calls.push({ method: 'delete', path });
    this.files.delete(path);
    return rpcOk(null);
  }
}

describe('composite routing over the mount adapters', () => {
  test("the /parent RPC mount round-trips the parent file plane", async () => {
    // Named /parent, not /workspace: the `run` tool's `runtime: "workspace"`
    // already names the caller's own emulated scratch shell (see exploration.ts
    // and cli-backend/runtime.ts's buildCLIHeadRuntime for the production sites
    // this mirrors).
    const handle = new MemoryParentRpcHandle();
    const composite = new CompositeVFS({ local: createInlineVFS(makeSql(new Database(':memory:'))) });
    composite.mount('parent', {
      vfs: createParentRpcMountVFS(handle),
      policy: { readOnly: false, rootPath: '', consistency: 'durable' },
    });

    expect(await composite.readdir('/parent')).toEqual([]);
    expect(handle.calls.at(-1)).toEqual({ method: 'list', path: '' });
    await composite.mkdir('/parent/src', { recursive: true });
    await composite.writeFile('/parent/src/index.ts', 'export const shared = true;');
    expect(await composite.readFile('/parent/src/index.ts', { encoding: 'utf8' })).toBe('export const shared = true;');
    expect(await composite.readdir('/parent/src')).toEqual(['index.ts']);
    expect(await composite.stat('/parent/src/index.ts')).toEqual({ size: 27, mtimeMs: 1, isDir: false });
    await composite.unlink('/parent/src/index.ts');
    expect(await composite.exists('/parent/src/index.ts')).toBe(false);

    expect(handle.calls).toContainEqual({ method: 'write', path: 'src' });
    expect(handle.calls).toContainEqual({ method: 'write', path: 'src/index.ts' });
    expect(handle.calls.every(({ path }) => !path.startsWith('/parent'))).toBe(true);
  });

  test('the parent RPC mount preserves binary bytes and typed errors', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0, 255, 17, 128]);
    const handle = new MemoryParentRpcHandle();
    const vfs = createParentRpcMountVFS(handle);

    await vfs.writeFile('blob.bin', bytes);
    expect(handle.files.get('blob.bin')).toEqual(bytes);
    expect(await vfs.readFile('blob.bin')).toEqual(bytes);
    expect(await vfs.exists('missing')).toBe(false);
    await expect(vfs.readFile('secret')).rejects.toMatchObject({
      code: 'ENOENT',
      path: 'secret',
      message: "ENOENT: no such file 'secret'",
    });
  });

  test("readFile('/sandbox/etc/hosts') reads the container's real /etc/hosts", async () => {
    const composite = new CompositeVFS({ local: createInlineVFS(makeSql(new Database(':memory:'))) });
    const sandbox = fakeSandboxHandle();
    composite.mount('sandbox', {
      vfs: createSandboxMountVFS(sandbox.handle),
      policy: { readOnly: false, rootPath: '/', consistency: 'ephemeral' },
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
      policy: { readOnly: false, rootPath: '/', consistency: 'live-shared' },
      live: () => connected,
    });

    expect(await composite.readdir('/')).toEqual(['local']);
    expect(await composite.readFile('/pc/home/me/x').catch(code)).toBe('ENXIO');
    connected = true;
    expect(await composite.readdir('/')).toEqual(['local', 'pc']);
    expect(await composite.readFile('/pc/home/me/proj/readme.md', { encoding: 'utf8' })).toBe('hello');
  });
});
