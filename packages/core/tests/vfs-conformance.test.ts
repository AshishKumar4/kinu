import { exists, readText, type Awaitable, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
/**
 * VFS conformance (SPEC §11.1) across the workspace filesystem and every executor file view:
 * exact binary byte round-trip, and the errno taxonomy (missing path → ENOENT).
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';

import type { JsonValue } from '../src/utils/json';
import { present } from '@kinu.run/test-utils';
import {
  sandboxFiles,
  nimbusSessionFiles,
  deviceFiles,
  type DeviceTransport,
  type NimbusSandboxHandle,
  type SandboxHandle,
} from '../src/execution/index';
import { createWorkspaceBundle } from './helpers';
import { nativeFileRead, sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';
import { createParentWorkspaceVfs } from '../src/execution/parent';
import { shellQuote } from '../src/utils/shell';
import {
  agentCred,
  agentHome,
  agentTmpRoot,
  confineAgentTmp,
  provisionAgentHome,
} from '../src/vfs/agent-home';
import { withMountTable } from '../src/vfs/mounts';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';

/** NUL, a UTF-8 BOM, high bytes, and invalid-UTF-8 0x80 (forces the base64 transport). */
const BINARY = new Uint8Array([0xef, 0xbb, 0xbf, 0x00, 0x01, 0x80, 0xff, 0xfe, 0x00, 0x42]);

const ErrorCodeSchema = v.object({ code: v.optional(v.string()) });

async function rejectionCode<Result>(action: () => Awaitable<Result>): Promise<string | undefined> {
  try {
    await action();

    return undefined;
  } catch (error) {
    const parsed = v.safeParse(ErrorCodeSchema, error);

    return parsed.success ? parsed.output.code : undefined;
  }
}

class MemFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['/']);
  readonly mtimeMs = 1_700_000_000_000;

  private norm(p: string): string { return p.replace(/\/+$/, '') || '/'; }
  private addParents(p: string): void {
    let cur = p, i: number;

    while ((i = cur.lastIndexOf('/')) > 0) { cur = cur.slice(0, i); this.dirs.add(cur); }
  }
  write(p: string, b: Uint8Array): void {
    const path = this.norm(p);

    this.files.set(path, b);
    this.addParents(path);
  }
  read(p: string): Uint8Array | null { return this.files.get(this.norm(p)) ?? null; }
  mkdir(p: string): void {
    const path = this.norm(p);

    this.dirs.add(path);
    this.addParents(path);
  }
  exists(p: string): boolean {
    const path = this.norm(p);

    return this.files.has(path) || this.dirs.has(path);
  }
  del(p: string): boolean { return this.files.delete(this.norm(p)); }
  stat(p: string): { size: number; isDir: boolean } | null {
    const path = this.norm(p);
    const file = this.files.get(path);

    if (file) return { size: file.length, isDir: false };

    if (this.dirs.has(path)) return { size: 0, isDir: true };

    return null;
  }
  list(dir: string): string[] {
    const root = this.norm(dir);
    const names = new Set<string>();

    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p === root || p === '/') continue;
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';

      if (parent === root) names.add(p.slice(p.lastIndexOf('/') + 1));
    }

    return [...names];
  }
  /** stat(1) line the exec-based adapters parse: `<size> <mtime-s> <type>`. */
  statLine(p: string) {
    const s = this.stat(p);

    if (!s) return { stdout: '', exitCode: 1 };

    return { stdout: `${s.size} ${Math.floor(this.mtimeMs / 1000)} ${s.isDir ? 'directory' : 'regular file'}`, exitCode: 0 };
  }
}

/** The path is the last quoted token (`stat -c` quotes its format first). */
const quoted = (cmd: string): string => {
  const all = [...cmd.matchAll(/'([^']*)'/g)];

  return all.length ? all[all.length - 1][1] : '';
};

/** A native file failure as it reaches core: the errno travels in `Error.cause`, which Worker RPC keeps. */
function nativeFileError(code: string, path: string, operation: string): Error {
	return new Error(`${code}: ${path}`, { cause: { kind: 'devbox.file', code, path, operation } });
}

function sandboxHandle(fs: MemFs): SandboxHandle {
	const handle: SandboxHandle = {
		async readFile(path: string, opts?: { encoding?: 'utf-8' | 'base64' }) {
			const b = fs.read(path);

			if (b === null) {
				throw nativeFileError('ENOENT', path, 'readFile');
			}

			return nativeFileRead(b, opts);
		},
		async writeFile(path: string, content: string, opts?: { encoding?: string }) {
			fs.write(path, opts?.encoding === 'base64'
				? new Uint8Array(Buffer.from(content, 'base64'))
				: new TextEncoder().encode(content));
		},
		async listFiles(dir: string) {
			if (dir !== '/' && !fs.exists(dir)) {
				throw nativeFileError('ENOENT', dir, 'readDirectory');
			}

			return { files: fs.list(dir).map((name) => {
				const s = fs.stat(`${dir === '/' ? '' : dir}/${name}`);

				if (!s) throw new Error(`Expected '${name}' in in-memory filesystem`);

				return { name, type: s.isDir ? 'directory' : 'file', size: s.size, mode: s.isDir ? 0o40755 : 0o100644, mtimeMs: fs.mtimeMs };
			}) };
		},
		async deleteFile(path: string) {
			if (!fs.del(path)) {
				throw nativeFileError('ENOENT', path, 'remove');
			}
		},
    async exec(command: string) {
      const p = quoted(command);

      if (command.startsWith('mkdir')) {
        fs.mkdir(p);

        return { exitCode: 0, stdout: '' };
      }

      if (command.startsWith('test -e')) return { exitCode: 0, stdout: fs.exists(p) ? 'true' : 'false' };

      if (command.startsWith('set -o pipefail; dd ')) {
        const range = /skip=(\d+) count=(\d+)/.exec(command);

        if (!range) return { exitCode: 1, stdout: '', stderr: 'range syntax missing' };
        const bytes = fs.read(p)?.subarray(Number(range[1]), Number(range[1]) + Number(range[2]));

        return bytes
          ? { exitCode: 0, stdout: Buffer.from(bytes).toString('base64') }
          : { exitCode: 1, stdout: '', stderr: 'ENOENT' };
      }

      return { exitCode: 0, stdout: '' };
    },
    async exposePort(port, opts) {
      const exposed = { url: `https://preview.invalid/${port}`, port, route: { reached: true } as const };

      return opts.name ? { ...exposed, name: opts.name } : exposed;
    },
    async unexposePort() {},
    async getExposedPorts() { return []; },
    ...sandboxHandleLifecycle,
    async statFile(path: string) {
      const stat = fs.stat(path);

      if (stat === null) throw nativeFileError('ENOENT', path, 'stat');

      return { type: stat.isDir ? 'directory' : 'file', size: stat.size, mode: stat.isDir ? 0o40755 : 0o100644, mtimeMs: fs.mtimeMs };
    },
  };

  return handle;
}

function nimbusHandle(fs: MemFs): NimbusSandboxHandle {
  const handle: NimbusSandboxHandle = {
    async ready() {},
    files: {
      async read(path: string) {
        const b = fs.read(path);

        return b === null ? null : new TextDecoder().decode(b);
      },
      async readBytes(path: string) { return fs.read(path); },
      async write(path: string, data: string | Uint8Array) {
        const text = v.safeParse(v.string(), data);
        fs.write(path, text.success
          ? new TextEncoder().encode(text.output)
          : v.parse(v.instance(Uint8Array), data));
      },
      async list(path: string) { return fs.list(path).map((name) => ({ name })); },
      async exists(path: string) { return fs.exists(path); },
      async mkdir(path: string) { fs.mkdir(path); },
      async delete(path: string) { fs.del(path); },
    },
    async exec(cmd: string) {
      if (cmd.startsWith('stat -c')) {
        const result = fs.statLine(quoted(cmd));

        return { command: cmd, success: true, ...result, stderr: '' };
      }

      return { command: cmd, success: true, exitCode: 0, stdout: '', stderr: '' };
    },
  };

  return handle;
}

function deviceTransport(fs: MemFs, calls: string[] = []): DeviceTransport {
  const transport: DeviceTransport = {
    async rpc(method, params): Promise<JsonValue | undefined> {
      calls.push(method);
      const path = v.safeParse(v.string(), params[0]);
      const p = path.success ? path.output : '';

      if (method === 'readFile') {
        const b = fs.read(p);

        if (b === null) throw Object.assign(new Error(`ENOENT: no such file '${p}'`), { code: 'ENOENT' });

        return { content: Buffer.from(b).toString('base64'), encoding: 'base64' };
      }

      if (method === 'readRange') {
        const offset = v.parse(v.number(), params[1]);
        const length = v.parse(v.number(), params[2]);
        const b = fs.read(p);

        if (b === null) throw Object.assign(new Error(`ENOENT: no such file '${p}'`), { code: 'ENOENT' });

        return { content: Buffer.from(b.subarray(offset, offset + length)).toString('base64'), encoding: 'base64' };
      }

      if (method === 'writeFile') {
        const content = v.parse(v.string(), params[1]);
        const options = v.safeParse(v.object({ encoding: v.optional(v.string()) }), params[2]);
        fs.write(p, options.success && options.output.encoding === 'base64'
          ? new Uint8Array(Buffer.from(content, 'base64'))
          : new TextEncoder().encode(content));

        return { success: true };
      }

      if (method === 'listFiles') return { entries: fs.list(p).map((name) => ({ name })), next: null };

      if (method === 'exists') return fs.exists(p);

      if (method === 'statPath') {
        const stat = fs.stat(p);

        return stat === null ? null : { ...stat, mtimeMs: fs.mtimeMs };
      }

      if (method === 'unlinkPath') {
        if (!fs.del(p)) throw Object.assign(new Error(`ENOENT: no such file '${p}'`), { code: 'ENOENT' });

        return { success: true };
      }

      if (method === 'mkdirPath') {
        fs.mkdir(p);

        return { success: true };
      }

      if (method === 'exec') {
        const cmd = v.parse(v.string(), params[0] ?? ''), q = quoted(cmd);

        if (cmd.startsWith('stat -c')) {
          const r = fs.statLine(q);

          return { ...r, stderr: '' };
        }

        if (cmd.startsWith('rm ')) return fs.del(q) ? { stdout: '', stderr: '', exitCode: 0 } : { stdout: '', stderr: 'No such file', exitCode: 1 };

        if (cmd.startsWith('mkdir')) {
          fs.mkdir(q);

          return { stdout: '', stderr: '', exitCode: 0 };
        }

        return { stdout: '', stderr: '', exitCode: 0 };
      }

      return null;
    },
    status: () => ({ connected: true, registered: true, toolchain: null }),
    refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
  };

  return transport;
}

interface Case {
  name: string;
  make: () => VFS;
  /** Compose a path this implementation accepts (env-native root varies). */
  path: (sub: string) => string;
}

const cases: Case[] = [
  { name: 'the workspace filesystem',
    make: () => createWorkspaceBundle(new Database(':memory:')).vfs,
    path: (s) => `conf/${s}` },
  { name: 'sandbox file view',
    make: () => sandboxFiles(sandboxHandle(new MemFs())), path: (s) => `/conf/${s}` },
  { name: 'nimbus session file view',
    make: () => nimbusSessionFiles(nimbusHandle(new MemFs()), { home: '/' }), path: (s) => `/conf/${s}` },
  { name: 'device file view',
    make: () => deviceFiles(deviceTransport(new MemFs()), {
      consentedRoot: async () => '/', deviceHome: async () => '/', scope: async () => 'unconfined',
    }), path: (s) => `/conf/${s}` },
  { name: 'parent workspace file view',
    make: () => {
      const workspace = createWorkspaceBundle(new Database(':memory:'));
      const files = workspace.vfs;

      return createParentWorkspaceVfs({
        read: async (path) => files.readFile(path),
        write: async (input) => {
          if (input.kind === 'file') return Promise.resolve(files.writeFile(input.path, input.data)).then(() => null);

          const options = input.recursive ? '-p ' : '';
          const made = await workspace.shell.exec(`mkdir ${options}${shellQuote(input.path)}`);

          if (made.exitCode !== 0) throw new VfsError('EIO', made.stderr, input.path);

          return null;
        },
        list: async (path) => files.readdir(path),
        stat: async (path, options) => files.stat(path, options),
        delete: async (path) => {
          await files.unlink(path);

          return null;
        },
        exec: async () => { throw new Error('this fixture drives the parent file plane, not its shell'); },
      });
    }, path: (path) => `conf/${path}` },
  { name: 'mounted workspace file view',
    make: () => {
      const workspace = createWorkspaceBundle(new Database(':memory:')).vfs;

      return withMountTable(createWorkspaceBundle(new Database(':memory:')).vfs, [{
        name: 'store', files: () => workspace, absentReason: () => 'not mounted', filesOwner: 'agent',
      }]);
    }, path: (path) => `/store${WORKSPACE_ROOT}/conf/${path}` },
];

for (const c of cases) {
  describe(`VFS conformance — ${c.name}`, () => {
    test('binary bytes round-trip exactly (NUL, BOM, invalid-UTF-8, high bytes)', async () => {
      const vfs = c.make();
      const p = c.path('blob.bin');
      await vfs.writeFile(p, BINARY);
      const back = await vfs.readFile(p);
      expect(back instanceof Uint8Array ? back : new TextEncoder().encode(back)).toEqual(BINARY);
    });

    test('utf-8 text round-trips through the encoding gate', async () => {
      const vfs = c.make();
      const p = c.path('notes.md');
      await writeText(vfs, p, 'héllo — wörld\n');
      expect(await readText(vfs, p)).toBe('héllo — wörld\n');
    });

    test('readdir lists written entries', async () => {
      const vfs = c.make();
      await writeText(vfs, c.path('a.txt'), 'a');
      await writeText(vfs, c.path('b.txt'), 'b');
      const names = (await vfs.readdir(c.path('').replace(/\/$/, ''))).map(({ name }) => name);
      expect(names).toContain('a.txt');
      expect(names).toContain('b.txt');
    });

    test('stat of a written file reports size + isDir:false', async () => {
      const vfs = c.make();
      const p = c.path('sized.bin');
      await vfs.writeFile(p, BINARY);
      const s = present(await vfs.stat(p), 'the written file\'s stat');
      expect((s.type === 'directory')).toBe(false);
      expect(s.size).toBe(BINARY.length);
    });

    test('an empty file reads as empty; only a missing one throws ENOENT (closed taxonomy)', async () => {
      const vfs = c.make();
      await writeText(vfs, c.path('empty.txt'), '');
      expect(await readText(vfs, c.path('empty.txt'))).toBe('');
      expect(await rejectionCode(() => vfs.readFile(c.path('nope.txt')))).toBe('ENOENT');
    });

    test('stat of a missing name under a live directory is null', async () => {
      const vfs = c.make();
      await vfs.mkdir(c.path('ghost').replace(/\/ghost$/, ''), { recursive: true });
      expect(await vfs.stat(c.path('ghost'))).toBeNull();
    });

    test('stat under an absent parent is null', async () => {
      expect(await c.make().stat(c.path('missing-parent/ghost'))).toBeNull();
    });

    test('exists tracks written / removed files', async () => {
      const vfs = c.make();
      const p = c.path('here.txt');
      expect(await exists(vfs, p)).toBe(false);
      await writeText(vfs, p, 'x');
      expect(await exists(vfs, p)).toBe(true);
      await vfs.unlink(p);
      expect(await exists(vfs, p)).toBe(false);
    });
  });
}

test('sandbox stat preserves a denied parent instead of reporting absence', async () => {
  const handle = sandboxHandle(new MemFs());
  handle.statFile = async () => { throw nativeFileError('EACCES', '/private/file', 'stat'); };

  expect(await rejectionCode(() => sandboxFiles(handle).stat('/private/file'))).toBe('EACCES');
});

// A link's own stat must not follow it or read its siblings.
test('sandbox lstat reports a link as a link, with its own metadata', async () => {
  const handle = sandboxHandle(new MemFs());
  handle.statFile = async () => ({ type: 'symlink', size: 21, mode: 0o120777, mtimeMs: 1_700_000_000_000 });

  expect(await sandboxFiles(handle).stat('/workspace/AGENTS.md', { follow: false })).toMatchObject({ type: 'symlink', size: 21 });
});

test('sandbox stat preserves a failed transport instead of reporting absence', async () => {
  const failure = new Error('the file transport disconnected');
  const handle = sandboxHandle(new MemFs());
  handle.statFile = async () => { throw failure; };

  await expect(sandboxFiles(handle).stat('/workspace/file')).rejects.toBe(failure);
});

test('a directory walk lists once and reads each stat directly at any sibling count', async () => {
  for (const width of [1, 72]) {
    const fs = new MemFs();

    for (let entry = 0; entry < width; entry += 1) fs.mkdir(`/workspace/entry-${String(entry)}`);
    const handle = sandboxHandle(fs);
    const calls = { list: 0, stat: 0 };
    const list = handle.listFiles.bind(handle);
    const stat = handle.statFile.bind(handle);

    handle.listFiles = (path, options) => {
      calls.list += 1;

      return list(path, options);
    };

    handle.statFile = (path, options) => {
      calls.stat += 1;

      return stat(path, options);
    };

    const files = sandboxFiles(handle);
    const entries = await files.readdir('/workspace');

    for (const entry of entries) {
      expect(entry.stat).toMatchObject({ type: 'directory', mode: 0o40755, mtimeMs: fs.mtimeMs });
      expect(await files.stat(`/workspace/${entry.name}`, { follow: false })).toEqual(entry.stat ?? null);
    }

    expect(calls).toEqual({ list: 1, stat: width });
  }
});

test('a listing carries a link\'s own metadata while stat follows it only when asked', async () => {
  const handle = sandboxHandle(new MemFs());
  const link = { type: 'symlink', size: 7, mode: 0o120777, mtimeMs: 1_700_000_000_000 };
  handle.listFiles = async () => ({ files: [{ name: 'link', ...link }] });
  handle.statFile = async (_path, options) => options?.follow === false ? link : { type: 'directory', size: 4096, mode: 0o40700, mtimeMs: link.mtimeMs };
  const files = sandboxFiles(handle);

  expect(await files.readdir('/workspace')).toMatchObject([{ name: 'link', type: 'symlink', stat: link }]);
  expect(await files.stat('/workspace/link', { follow: false })).toMatchObject(link);
  expect(await files.stat('/workspace/link')).toMatchObject({ type: 'directory', mode: 0o40700 });
});

test('the workspace filesystem names the absolute path, never the storage key, when a relative listing fails', async () => {
  // The 2048 transcript: `readdir('skills')` failed as `ENOENT: home/user/skills`, a path no tool can address.
  const vfs = createWorkspaceBundle(new Database(':memory:')).vfs;

  await expect(Promise.resolve(vfs.readdir('skills')).then(entries => entries.map(({ name }) => name))).rejects.toThrow(`${WORKSPACE_ROOT}/skills`);
});

describe('the global workspace namespace', () => {
  test('registers private tmp by storage key while retaining one logical path', () => {
    const roots: Array<[number, string]> = [];

    const logical = confineAgentTmp({
      confinePrincipal: (uid, tmpRoot) => { roots.push([uid, tmpRoot]); },
      releasePrincipal: () => {},
    }, 'agent-a', { uid: 2_001, gid: 2_001 });

    expect(logical).toBe('/tmp/agent-a');
    expect(roots).toEqual([[2_001, 'tmp/agent-a']]);
  });

  test('two agents share a readable workspace but own their writes and private tmp on both planes', async () => {
    const db = new Database(':memory:');

    try {
      const workspace = createWorkspaceBundle(db);
      const { root, confiner } = await workspace.privileged();
      const agentA = { uid: 2_001, gid: 2_001 };
      const agentB = { uid: 2_002, gid: 2_002 };
      provisionAgentHome(root, 'agent-a', agentA);
      provisionAgentHome(root, 'agent-b', agentB);
      confineAgentTmp(confiner, 'agent-a', agentA);
      confineAgentTmp(confiner, 'agent-b', agentB);

      const a = await workspace.asAgent({
        cred: agentCred(agentA),
        home: agentHome('agent-a'),
        tmp: agentTmpRoot('agent-a'),
      });

      const b = await workspace.asAgent({
        cred: agentCred(agentB),
        home: agentHome('agent-b'),
        tmp: agentTmpRoot('agent-b'),
      });

      await writeText(a.vfs, '/home/agent-a/owned.txt', 'a owns this');
      expect(await readText(b.vfs, '/home/agent-a/owned.txt')).toBe('a owns this');
      expect(await rejectionCode(() => writeText(b.vfs, '/home/agent-a/blocked.txt', 'b'))).toBe('EACCES');

      expect((await a.shell.exec('echo a-scratch > /tmp/scratch.txt')).exitCode).toBe(0);
      expect((await b.shell.exec('echo b-scratch > /tmp/scratch.txt')).exitCode).toBe(0);
      expect(await readText(a.vfs, '/tmp/scratch.txt')).toBe('a-scratch\n');
      expect(await readText(b.vfs, '/tmp/scratch.txt')).toBe('b-scratch\n');

      confiner.releasePrincipal(agentA.uid);
      expect(await rejectionCode(() => a.vfs.readFile('/tmp/scratch.txt'))).toBe('ENOENT');
      expect(await readText(a.vfs, '/home/agent-a/owned.txt')).toBe('a owns this');
      expect(await readText(b.vfs, '/tmp/scratch.txt')).toBe('b-scratch\n');
    } finally {
      db.close();
    }
  });

  test('the real shell remains on the base tree when the VFS has a live mount', async () => {
    const db = new Database(':memory:');

    try {
      const workspace = createWorkspaceBundle(db);

      const device: VFS = {
        readFile: async () => new Uint8Array(),
        writeFile: async () => undefined,
        readdir: async () => [],
        stat: async () => null,
        unlink: async () => undefined,
        mkdir: async () => undefined,

      };

      const mounted = withMountTable(workspace.vfs, [{
        name: 'pc',
        files: () => device,
        absentReason: () => 'not used',
        filesOwner: 'user',
      }]);

      expect((await mounted.readdir('/')).map(({ name }) => name)).toContain('pc');
      expect((await workspace.shell.exec('test ! -e /pc')).exitCode).toBe(0);
    } finally {
      db.close();
    }
  });
});

// Path scope over the hub's action consent, asserted directly: the shared contract runs
// the device view at the full-filesystem tier, where the guard is inert.
describe('device file view — the consented subtree is a boundary', () => {
  function scoped(root: string) {
    const calls: string[] = [];
    const consent = { consentedRoot: async () => root, deviceHome: async () => root, scope: async () => 'root' as const };

    return { vfs: deviceFiles(deviceTransport(new MemFs(), calls), consent), calls };
  }

  test('SECURITY: escaping the consented directory is denied while the sandbox is on', async () => {
    const { vfs, calls } = scoped('/home/me/proj');
    expect(await rejectionCode(() => vfs.readFile('/etc/passwd'))).toBe('EACCES');
    await expect(vfs.readFile('/etc/passwd')).rejects.toThrow(
      /outside the consented device directory '\/home\/me\/proj'[\s\S]*Ask the owner to consent that directory/,
    );
    expect(await rejectionCode(() => vfs.readFile('/home/me/projects/x'))).toBe('EACCES');
    expect(await rejectionCode(() => writeText(vfs, '/etc/cron.d/evil', 'x'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.readdir('/etc'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.stat('/etc/passwd'))).toBe('EACCES');
    expect(await rejectionCode(() => exists(vfs, '/etc/passwd'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.unlink('/etc/passwd'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.mkdir('/opt/x'))).toBe('EACCES');
    expect(calls).toEqual([]);
  });

  test('the consented root itself, and everything under it, stays reachable', async () => {
    const { vfs } = scoped('/home/me/proj');
    await writeText(vfs, '/home/me/proj/notes.md', 'ok');
    expect(await readText(vfs, '/home/me/proj/notes.md')).toBe('ok');
    expect((await vfs.readdir('/home/me/proj')).map(({ name }) => name)).toContain('notes.md');
  });
});

describe('sandbox file view — bounded range reads', () => {
  test('streams only the requested prefix through dd/base64', async () => {
    const fs = new MemFs();
    const all = new Uint8Array(512 * 1024 + 32).fill(0x61);
    all[512 * 1024] = 0x00; // sentinel just beyond the admitted window
    fs.write('/workspace/large.bin', all);

    const bytes = await sandboxFiles(sandboxHandle(fs)).readRange('/workspace/large.bin', 0, 512 * 1024);

    expect(bytes.byteLength).toBe(512 * 1024);
    expect(bytes.includes(0)).toBe(false);
  });
});

describe('device file view — bounded range reads', () => {
  test('the device range stays within its consented device path and admitted window', async () => {
    const fs = new MemFs();
    const all = new Uint8Array(512 * 1024 + 32).fill(0x61);
    all[512 * 1024] = 0x00;
    fs.write('/home/me/proj/large.bin', all);
    const calls: string[] = [];

    const consent = {
      consentedRoot: async () => '/home/me/proj',
      deviceHome: async () => '/home/me',
      scope: async () => 'root' as const,
    };

    const vfs = deviceFiles(deviceTransport(fs, calls), consent);

    const bytes = await vfs.readRange('/home/me/proj/large.bin', 0, 512 * 1024);

    expect(bytes.byteLength).toBe(512 * 1024);
    expect(bytes.includes(0)).toBe(false);
    expect(calls).toEqual(['readRange']);
    expect(await rejectionCode(() => vfs.readRange('/etc/passwd', 0, 1))).toBe('EACCES');
    expect(calls).toEqual(['readRange']);
  });
});
