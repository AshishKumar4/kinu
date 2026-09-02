/**
 * Parameterized VFS conformance suite (SPEC §11.1).
 *
 * ONE contract, run against EVERY VFS implementation — the workspace filesystem
 * and each executor's own raw-handle file view. It locks:
 *   - the binary byte round-trip invariant (commit 2f57753): every one must
 *     return the exact bytes it was given, NUL / high bytes / a UTF-8 BOM and
 *     all, whether the transport is base64 or lossless-text;
 *   - the errno taxonomy (readFile of a missing path → ENOENT, closed union).
 *
 * The executor views are exercised over a shared in-memory environment that
 * stores real bytes, so the round-trip assertion is genuine, not stubbed.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { VFS } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';
import {
  sandboxFiles,
  nimbusSessionFiles,
  deviceFiles,
  type DeviceTransport,
  type NimbusSandboxHandle,
  type SandboxHandle,
} from '../src/execution/index';
import { createWorkspaceBundle } from './helpers';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';
import {
  agentCred,
  agentHome,
  agentTmpRoot,
  confineAgentTmp,
  provisionAgentHome,
} from '../src/vfs/agent-home';
import { withMountTable } from '../src/vfs/mounts';

/** The byte corpus that must survive a write→read round trip on every mount:
 *  NUL, a UTF-8 BOM (the silent-3-byte-loss trap), high bytes and a lone 0x80
 *  that is invalid UTF-8 (forces the base64 transport). */
const BINARY = new Uint8Array([0xef, 0xbb, 0xbf, 0x00, 0x01, 0x80, 0xff, 0xfe, 0x00, 0x42]);

const ErrorCodeSchema = v.object({ code: v.optional(v.string()) });

async function rejectionCode<Result>(action: () => Promise<Result>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    const parsed = v.safeParse(ErrorCodeSchema, error);
    return parsed.success ? parsed.output.code : undefined;
  }
}

// ── shared in-memory environment for the mount adapters ─────────────────────

class MemFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(['/']);
  readonly mtimeMs = 1_700_000_000_000;

  private norm(p: string): string { return p.replace(/\/+$/, '') || '/'; }
  private addParents(p: string): void {
    let cur = p, i: number;
    while ((i = cur.lastIndexOf('/')) > 0) { cur = cur.slice(0, i); this.dirs.add(cur); }
  }
  write(p: string, b: Uint8Array): void { p = this.norm(p); this.files.set(p, b); this.addParents(p); }
  read(p: string): Uint8Array | null { return this.files.get(this.norm(p)) ?? null; }
  mkdir(p: string): void { p = this.norm(p); this.dirs.add(p); this.addParents(p); }
  exists(p: string): boolean { p = this.norm(p); return this.files.has(p) || this.dirs.has(p); }
  del(p: string): boolean { return this.files.delete(this.norm(p)); }
  stat(p: string): { size: number; isDir: boolean } | null {
    p = this.norm(p);
    const file = this.files.get(p);
    if (file) return { size: file.length, isDir: false };
    if (this.dirs.has(p)) return { size: 0, isDir: true };
    return null;
  }
  list(dir: string): string[] {
    dir = this.norm(dir);
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p === dir || p === '/') continue;
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';
      if (parent === dir) names.add(p.slice(p.lastIndexOf('/') + 1));
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

/** The shell-quoted PATH the adapters pass — always the LAST quoted token (a
 *  `stat -c '%s %Y %F' 'path'` also quotes its format string first). */
const quoted = (cmd: string): string => {
  const all = [...cmd.matchAll(/'([^']*)'/g)];
  return all.length ? all[all.length - 1]![1]! : '';
};

function sandboxHandle(fs: MemFs): SandboxHandle {
  const handle: SandboxHandle = {
    async readFile(path: string) {
      const b = fs.read(path);
      if (b === null) return { exitCode: 1 };
      return { content: Buffer.from(b).toString('base64'), encoding: 'base64', exitCode: 0 };
    },
    async writeFile(path: string, content: string, opts?: { encoding?: string }) {
      fs.write(path, opts?.encoding === 'base64'
        ? new Uint8Array(Buffer.from(content, 'base64'))
        : new TextEncoder().encode(content));
    },
    async listFiles(dir: string) {
      return { files: fs.list(dir).map((name) => {
        const s = fs.stat(`${dir === '/' ? '' : dir}/${name}`);
        if (!s) throw new Error(`Expected '${name}' in in-memory filesystem`);
        return { name, type: s.isDir ? 'directory' : 'file', size: s.size };
      }) };
    },
    async deleteFile(path: string) { fs.del(path); },
    async exec(command: string) {
      const p = quoted(command);
      if (command.startsWith('mkdir')) { fs.mkdir(p); return { exitCode: 0, stdout: '' }; }
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
      const exposed = { url: `https://preview.invalid/${port}`, port };
      return opts.name ? { ...exposed, name: opts.name } : exposed;
    },
    async unexposePort() {},
    async getExposedPorts() { return []; },
    ...sandboxHandleLifecycle,
  };
  return handle;
}

function nimbusHandle(fs: MemFs): NimbusSandboxHandle {
  const handle: NimbusSandboxHandle = {
    async ready() {},
    files: {
      async read(path: string) { const b = fs.read(path); return b === null ? null : new TextDecoder().decode(b); },
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

/** `calls` records every method that actually reached the device, so a test can
 *  assert a denial happened locally rather than at the far end. */
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
        return 'ok';
      }
      if (method === 'listFiles') return fs.list(p).map((name) => ({ name }));
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
        const cmd = String(params[0] ?? ''), q = quoted(cmd);
        if (cmd.startsWith('stat -c')) { const r = fs.statLine(q); return { ...r, stderr: '' }; }
        if (cmd.startsWith('rm ')) return fs.del(q) ? { stdout: '', stderr: '', exitCode: 0 } : { stdout: '', stderr: 'No such file', exitCode: 1 };
        if (cmd.startsWith('mkdir')) { fs.mkdir(q); return { stdout: '', stderr: '', exitCode: 0 }; }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return null;
    },
    status: () => ({ connected: true, registered: true, toolchain: null }),
    refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
  };
  return transport;
}

// ── the parameterized contract ──────────────────────────────────────────────

interface Case {
  name: string;
  make: () => VFS;
  /** Compose a path this implementation accepts (env-native root varies). */
  path: (sub: string) => string;
  /** How a missing path stats: the core-VFS impls normalise to null; bare
   *  Node semantics would throw ENOENT; the core contract says null. */
  statMissing: 'null' | 'enoent';
}

const cases: Case[] = [
  { name: 'the workspace filesystem', statMissing: 'null',
    make: () => createWorkspaceBundle(new Database(':memory:')).vfs,
    path: (s) => `conf/${s}` },
  { name: 'sandbox file view', statMissing: 'null',
    make: () => sandboxFiles(sandboxHandle(new MemFs())), path: (s) => `/conf/${s}` },
  { name: 'nimbus session file view', statMissing: 'null',
    make: () => nimbusSessionFiles(nimbusHandle(new MemFs())), path: (s) => `/conf/${s}` },
  { name: 'device file view', statMissing: 'null',
    make: () => deviceFiles(deviceTransport(new MemFs()), {
      consentedRoot: async () => '/', deviceHome: async () => '/', hasFullFilesystem: async () => true,
    }), path: (s) => `/conf/${s}` },
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
      await vfs.writeFile(p, 'héllo — wörld\n');
      expect(await vfs.readFile(p, { encoding: 'utf8' })).toBe('héllo — wörld\n');
    });

    test('readdir lists written entries', async () => {
      const vfs = c.make();
      await vfs.writeFile(c.path('a.txt'), 'a');
      await vfs.writeFile(c.path('b.txt'), 'b');
      const names = await vfs.readdir(c.path('').replace(/\/$/, ''));
      expect(names).toContain('a.txt');
      expect(names).toContain('b.txt');
    });

    test('stat of a written file reports size + isDir:false', async () => {
      const vfs = c.make();
      const p = c.path('sized.bin');
      await vfs.writeFile(p, BINARY);
      const s = await vfs.stat(p);
      expect(s).not.toBeNull();
      expect(s!.isDir).toBe(false);
      expect(s!.size).toBe(BINARY.length);
    });

    test('reading a missing file throws ENOENT (closed taxonomy)', async () => {
      const vfs = c.make();
      expect(await rejectionCode(() => vfs.readFile(c.path('nope.txt')))).toBe('ENOENT');
    });

    test('stat of a missing path signals absence per the impl contract', async () => {
      const vfs = c.make();
      if (c.statMissing === 'null') {
        expect(await vfs.stat(c.path('ghost'))).toBeNull();
      } else {
        expect(await rejectionCode(() => vfs.stat(c.path('ghost')))).toBe('ENOENT');
      }
    });

    test('exists tracks written / removed files', async () => {
      const vfs = c.make();
      const p = c.path('here.txt');
      expect(await vfs.exists(p)).toBe(false);
      await vfs.writeFile(p, 'x');
      expect(await vfs.exists(p)).toBe(true);
      await vfs.unlink(p);
      expect(await vfs.exists(p)).toBe(false);
    });
  });
}

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

      await a.vfs.writeFile('/home/agent-a/owned.txt', 'a owns this');
      expect(await b.vfs.readFile('/home/agent-a/owned.txt', { encoding: 'utf8' })).toBe('a owns this');
      expect(await rejectionCode(() => b.vfs.writeFile('/home/agent-a/blocked.txt', 'b'))).toBe('EACCES');

      expect((await a.shell.exec('echo a-scratch > /tmp/scratch.txt')).exitCode).toBe(0);
      expect((await b.shell.exec('echo b-scratch > /tmp/scratch.txt')).exitCode).toBe(0);
      expect(await a.vfs.readFile('/tmp/scratch.txt', { encoding: 'utf8' })).toBe('a-scratch\n');
      expect(await b.vfs.readFile('/tmp/scratch.txt', { encoding: 'utf8' })).toBe('b-scratch\n');

      confiner.releasePrincipal(agentA.uid);
      expect(await rejectionCode(() => a.vfs.readFile('/tmp/scratch.txt'))).toBe('ENOENT');
      expect(await a.vfs.readFile('/home/agent-a/owned.txt', { encoding: 'utf8' })).toBe('a owns this');
      expect(await b.vfs.readFile('/tmp/scratch.txt', { encoding: 'utf8' })).toBe('b-scratch\n');
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
        exists: async () => false,
      };
      const mounted = withMountTable(workspace.vfs, [{
        name: 'pc',
        files: () => device,
        absentReason: () => 'not used',
      }]);

      expect(await mounted.readdir('/')).toContain('pc');
      expect((await workspace.shell.exec('test ! -e /pc')).exitCode).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ── the device consent scope ────────────────────────────────────────────────

// The path-scope layer over the hub's action consent: the only thing between an
// agent granted one directory and the rest of the user's machine. Asserted
// directly because the shared contract above runs the device view at the
// full-filesystem tier, where the guard is deliberately inert.
describe('device file view — the consented subtree is a boundary', () => {
  function scoped(root: string) {
    const calls: string[] = [];
    const consent = { consentedRoot: async () => root, deviceHome: async () => root, hasFullFilesystem: async () => false };
    return { vfs: deviceFiles(deviceTransport(new MemFs(), calls), consent), calls };
  }

  test('SECURITY: escaping the consented subtree is denied without the full-fs tier', async () => {
    const { vfs, calls } = scoped('/home/me/proj');
    expect(await rejectionCode(() => vfs.readFile('/etc/passwd'))).toBe('EACCES');
    await expect(vfs.readFile('/etc/passwd')).rejects.toThrow(
      /outside the consented device directory '\/home\/me\/proj'[\s\S]*full-filesystem consent tier/,
    );
    // A sibling whose name merely BEGINS with the consented one is outside it.
    expect(await rejectionCode(() => vfs.readFile('/home/me/projects/x'))).toBe('EACCES');
    // Every op is guarded, not just reads.
    expect(await rejectionCode(() => vfs.writeFile('/etc/cron.d/evil', 'x'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.readdir('/etc'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.stat('/etc/passwd'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.exists('/etc/passwd'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.unlink('/etc/passwd'))).toBe('EACCES');
    expect(await rejectionCode(() => vfs.mkdir('/opt/x'))).toBe('EACCES');
    // The denial happened locally — nothing was ever sent to the device.
    expect(calls).toEqual([]);
  });

  test('the consented root itself, and everything under it, stays reachable', async () => {
    const { vfs } = scoped('/home/me/proj');
    await vfs.writeFile('/home/me/proj/notes.md', 'ok');
    expect(await vfs.readFile('/home/me/proj/notes.md', { encoding: 'utf8' })).toBe('ok');
    expect(await rejectionCode(() => vfs.readdir('/home/me/proj'))).toBeUndefined();
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
  test('the laptop range stays within its consented device path and admitted window', async () => {
    const fs = new MemFs();
    const all = new Uint8Array(512 * 1024 + 32).fill(0x61);
    all[512 * 1024] = 0x00;
    fs.write('/home/me/proj/large.bin', all);
    const calls: string[] = [];
    const consent = {
      consentedRoot: async () => '/home/me/proj',
      deviceHome: async () => '/home/me',
      hasFullFilesystem: async () => false,
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
