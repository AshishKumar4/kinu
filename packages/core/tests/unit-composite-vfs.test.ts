/**
 * CompositeVFS — the workspace file plane.
 *
 * Phase 0 pins the risk-retirement contract: with only /local mounted, the
 * composite is byte-identical to the bare SqliteFS-backed Storage.vfs it
 * replaced — same rows, same addressing, same interop with raw-SQL writers.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeVfsFileSync } from '@proteus/agent-utils/vfs';
import { CompositeVFS, cleanAbsolutePath } from '../src/vfs/index.js';
import { createInlineVFS } from '../src/identity/inline-primitives.js';
import { makeSql } from './helpers.js';

function createComposite() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const vfs = new CompositeVFS({ local: createInlineVFS(sql) });
  return { sql, vfs };
}

describe('cleanAbsolutePath', () => {
  test('preserves the leading slash and resolves dot segments', () => {
    expect(cleanAbsolutePath('/a/./b/../c')).toBe('/a/c');
    expect(cleanAbsolutePath('/a//b/')).toBe('/a/b');
    expect(cleanAbsolutePath('/')).toBe('/');
  });

  test(".. above root clamps at root (chroot semantics)", () => {
    expect(cleanAbsolutePath('/../..')).toBe('/');
    expect(cleanAbsolutePath('/a/../../b')).toBe('/b');
  });
});

describe('Phase 0 — compat routing to /local', () => {
  test('bare, deeper-absolute, and /local-prefixed paths address the same file', async () => {
    const { vfs } = createComposite();
    await vfs.writeFile('scaffold/agent.js', 'v1');
    expect(await vfs.readFile('/scaffold/agent.js', { encoding: 'utf8' })).toBe('v1');
    expect(await vfs.readFile('/local/scaffold/agent.js', { encoding: 'utf8' })).toBe('v1');

    await vfs.writeFile('/local/scaffold/agent.js', 'v2');
    expect(await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })).toBe('v2');
  });

  test('relative paths resolve against the default cwd /local', async () => {
    const { vfs } = createComposite();
    expect(vfs.cwd).toBe('/local');
    await vfs.writeFile('notes/./a/../b.md', 'hello');
    expect(await vfs.readFile('/local/notes/b.md', { encoding: 'utf8' })).toBe('hello');
  });

  test('vfs_files rows are byte-identical to a direct SqliteFS write', async () => {
    const { sql, vfs } = createComposite();
    await vfs.writeFile('/local/a.txt', 'same-content');
    writeVfsFileSync(sql, 'b.txt', 'same-content');

    const rows = sql<{ path: string; chunk_index: number; parent_path: string; is_dir: number; size: number; t: string }>`
      SELECT path, chunk_index, parent_path, is_dir, size, typeof(data) AS t
      FROM vfs_files WHERE path IN ('a.txt', 'b.txt') ORDER BY path
    `;
    expect(rows.length).toBe(2);
    const [a, b] = rows;
    expect({ ...a, path: '' }).toEqual({ ...b, path: '' });
  });

  test('raw-SQL writes (writeVfsFileSync) are readable through the composite', async () => {
    const { sql, vfs } = createComposite();
    writeVfsFileSync(sql, 'SOUL.md', '# Jarvis');
    expect(await vfs.readFile('SOUL.md', { encoding: 'utf8' })).toBe('# Jarvis');
    expect(await vfs.readFile('/local/SOUL.md', { encoding: 'utf8' })).toBe('# Jarvis');
  });

  test('binary content round-trips byte-for-byte', async () => {
    const { vfs } = createComposite();
    const bytes = new Uint8Array(512).map((_, i) => i % 251);
    await vfs.writeFile('bin/blob.dat', bytes);
    const back = (await vfs.readFile('/local/bin/blob.dat')) as Uint8Array;
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  test('the full 7-method surface delegates to /local', async () => {
    const { vfs } = createComposite();
    await vfs.mkdir('proj/src', { recursive: true });
    await vfs.writeFile('proj/src/main.ts', 'x');

    expect(await vfs.readdir('proj')).toEqual(['src']);
    expect(await vfs.readdir('/local/proj/src')).toEqual(['main.ts']);
    expect(await vfs.exists('/proj/src/main.ts')).toBe(true);
    const st = await vfs.stat('proj/src/main.ts');
    expect(st).toEqual({ size: 1, mtime: st!.mtime, isDir: false });
    expect((await vfs.stat('/local/proj'))!.isDir).toBe(true);

    await vfs.unlink('/local/proj/src/main.ts');
    expect(await vfs.exists('proj/src/main.ts')).toBe(false);
    expect(await vfs.stat('proj/src/missing.ts')).toBeNull();
    expect(await vfs.readFile('nope.txt').catch((e: { code?: string }) => e.code)).toBe('ENOENT');
  });

  test('ENOENT reads match the bare-VFS contract', async () => {
    const { vfs } = createComposite();
    expect(await vfs.exists('missing.txt')).toBe(false);
    expect(await vfs.stat('/local/missing.txt')).toBeNull();
  });
});

/** In-memory VFS test double that records every delegated call. */
function recordingVFS() {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const vfs = {
    async readFile(path: string) { calls.push(`read:${path}`); return files.get(path) ?? ''; },
    async writeFile(path: string, data: string | Uint8Array) { calls.push(`write:${path}`); files.set(path, String(data)); },
    async readdir(path: string) { calls.push(`readdir:${path}`); return [...files.keys()]; },
    async stat(path: string) { calls.push(`stat:${path}`); return { size: 0, mtime: 1, isDir: path === '/' }; },
    async unlink(path: string) { calls.push(`unlink:${path}`); files.delete(path); },
    async mkdir(path: string) { calls.push(`mkdir:${path}`); },
    async exists(path: string) { calls.push(`exists:${path}`); return files.has(path); },
  };
  return { vfs, calls, files };
}

const envPolicy = { readOnly: false, rootPath: '/', consistency: 'ephemeral' as const, credentialsStayInHost: true };

describe("Phase 1 — synthetic read-only '/'", () => {
  test("readdir('/') lists live mount names only", async () => {
    const { vfs } = createComposite();
    const sandbox = recordingVFS();
    let sandboxLive = true;
    vfs.mount('sandbox', { vfs: sandbox.vfs, policy: envPolicy, live: () => sandboxLive });
    vfs.reserve('nimbus', 'NIMBUS_SESSION binding missing', envPolicy);

    expect(await vfs.readdir('/')).toEqual(['local', 'sandbox']);
    sandboxLive = false;
    expect(await vfs.readdir('/')).toEqual(['local']);
  });

  test("stat('/') and exists('/') describe the synthetic root", async () => {
    const { vfs } = createComposite();
    expect(await vfs.stat('/')).toEqual({ size: 0, mtime: 0, isDir: true });
    expect(await vfs.exists('/')).toBe(true);
    expect(await vfs.readFile('/').catch((e: { code?: string }) => e.code)).toBe('EISDIR');
    expect(await vfs.writeFile('/', 'x').catch((e: { code?: string }) => e.code)).toBe('EISDIR');
    expect(await vfs.unlink('/').catch((e: { code?: string }) => e.code)).toBe('EPERM');
    await vfs.mkdir('/'); // '/' always exists — a no-op, never an error
  });

  test("THE OWNER'S QUESTION: a bare top-level create at '/' is refused with EROFS", async () => {
    const { vfs } = createComposite();
    const err = await vfs.writeFile('/x', 'stray').catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('EROFS');
    expect((err as Error).message).toContain("'/' is the workspace mount table; write under a mount (e.g. /local/x)");
    expect(await vfs.mkdir('/newdir').catch((e: { code?: string }) => e.code)).toBe('EROFS');
    expect(await vfs.unlink('/x').catch((e: { code?: string }) => e.code)).toBe('EROFS');
  });

  test('single top-level non-mount reads resolve against the mount table, not /local', async () => {
    const { vfs } = createComposite();
    await vfs.writeFile('/local/x', 'in-local');
    expect(await vfs.readFile('/x').catch((e: { code?: string }) => e.code)).toBe('ENOENT');
    expect(await vfs.stat('/x')).toBeNull();
    expect(await vfs.exists('/x')).toBe(false);
    expect(await vfs.readdir('/x').catch((e: { code?: string }) => e.code)).toBe('ENOENT');
  });

  test('backward compat survives root semantics: bare and deeper-absolute still hit /local', async () => {
    const { vfs } = createComposite();
    await vfs.writeFile('x', 'bare');
    await vfs.writeFile('/src/main.ts', 'deep');
    expect(await vfs.readFile('/local/x', { encoding: 'utf8' })).toBe('bare');
    expect(await vfs.readFile('/local/src/main.ts', { encoding: 'utf8' })).toBe('deep');
  });

  test('EEXIST: local top-level names of LIVE mounts are reserved; freed when not live', async () => {
    const { vfs } = createComposite();
    const sandbox = recordingVFS();
    let live = true;
    vfs.mount('sandbox', { vfs: sandbox.vfs, policy: envPolicy, live: () => live });

    const err = await vfs.mkdir('/local/sandbox').catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('EEXIST');
    expect((err as Error).message).toContain('name reserved for the sandbox mount');
    // Same rule for the relative spelling and for file creates.
    expect(await vfs.mkdir('sandbox').catch((e: { code?: string }) => e.code)).toBe('EEXIST');
    expect(await vfs.writeFile('/local/sandbox', 'f').catch((e: { code?: string }) => e.code)).toBe('EEXIST');
    // Deeper local paths under a same-named dir are untouched by the guard.
    await vfs.writeFile('/local/sandbox-notes/readme.md', 'ok');

    live = false;
    await vfs.mkdir('/local/sandbox'); // mount not live — the name frees up
    expect(await vfs.readdir('/local/sandbox')).toEqual([]);
  });

  test('segment-boundary matching: /sandboxes/x never hits the /sandbox mount', async () => {
    const { vfs } = createComposite();
    const sandbox = recordingVFS();
    vfs.mount('sandbox', { vfs: sandbox.vfs, policy: envPolicy });

    await vfs.writeFile('/sandboxes/x', 'local-data');
    expect(sandbox.calls).toEqual([]);
    expect(await vfs.readFile('/local/sandboxes/x', { encoding: 'utf8' })).toBe('local-data');

    await vfs.writeFile('/sandbox/workspace/app.ts', 'env-data');
    expect(sandbox.calls).toEqual(['write:/workspace/app.ts']);
  });

  test('mount roots: writable-looking ops are guarded, reads delegate', async () => {
    const { vfs } = createComposite();
    const sandbox = recordingVFS();
    vfs.mount('sandbox', { vfs: sandbox.vfs, policy: envPolicy });

    expect(await vfs.writeFile('/sandbox', 'x').catch((e: { code?: string }) => e.code)).toBe('EISDIR');
    expect(await vfs.unlink('/sandbox').catch((e: { code?: string }) => e.code)).toBe('EPERM');
    await vfs.mkdir('/sandbox'); // exists — no-op
    expect(sandbox.calls).toEqual([]);

    expect((await vfs.stat('/local'))!.isDir).toBe(true); // delegates to the mount
    await vfs.readdir('/sandbox');
    expect(sandbox.calls).toEqual(['readdir:/']);
  });

  test('reserved / non-live mounts error clearly instead of compat-routing', async () => {
    const { vfs } = createComposite();
    vfs.reserve('nimbus', 'NIMBUS_SESSION binding missing', envPolicy);
    const err = await vfs.readFile('/nimbus/etc/hosts').catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('ENXIO');
    expect((err as Error).message).toContain('NIMBUS_SESSION binding missing');
    expect(await vfs.exists('/nimbus/etc/hosts')).toBe(false);
    // Nothing leaked into /local under the reserved prefix.
    expect(await vfs.exists('/local/nimbus')).toBe(false);
  });

  test('dot segments cannot escape into another mount accidentally', async () => {
    const { vfs } = createComposite();
    const sandbox = recordingVFS();
    vfs.mount('sandbox', { vfs: sandbox.vfs, policy: envPolicy });

    // /local/../sandbox/x normalizes to /sandbox/x — an intentional cross-mount hop.
    await vfs.writeFile('/local/../sandbox/x', 'hop');
    expect(sandbox.calls).toEqual(['write:/x']);
    // /local/.. is the synthetic root itself.
    expect(await vfs.stat('/local/..')).toEqual({ size: 0, mtime: 0, isDir: true });
  });

  test('read-only mounts refuse writes with EROFS', async () => {
    const { vfs } = createComposite();
    const ro = recordingVFS();
    vfs.mount('snapshots', { vfs: ro.vfs, policy: { ...envPolicy, readOnly: true } });
    expect(await vfs.writeFile('/snapshots/a', 'x').catch((e: { code?: string }) => e.code)).toBe('EROFS');
    expect(await vfs.unlink('/snapshots/a').catch((e: { code?: string }) => e.code)).toBe('EROFS');
    expect(await vfs.mkdir('/snapshots/d').catch((e: { code?: string }) => e.code)).toBe('EROFS');
    await vfs.readFile('/snapshots/a'); // reads pass through
    expect(ro.calls).toEqual(['read:/a']);
  });
});

describe('mount table basics', () => {
  test('/local is always mounted, writable, durable — and never unmounts', () => {
    const { vfs } = createComposite();
    expect(vfs.listMounts()).toEqual([{
      name: 'local',
      prefix: '/local',
      live: true,
      policy: { readOnly: false, rootPath: '', consistency: 'durable', credentialsStayInHost: false },
      cwd: '/local',
      reason: null,
    }]);
    expect(() => vfs.unmount('local')).toThrow(/never unmounts/);
  });

  test("mount names are validated and 'local' is not remountable", () => {
    const { vfs } = createComposite();
    const spec = {
      vfs: createInlineVFS(makeSql(new Database(':memory:'))),
      policy: { readOnly: false, rootPath: '/', consistency: 'ephemeral' as const, credentialsStayInHost: true },
    };
    expect(() => vfs.mount('local', spec)).toThrow(/permanent writable base/);
    expect(() => vfs.mount('Bad Name', spec)).toThrow(/invalid mount name/);
  });
});
