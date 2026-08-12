/**
 * What a head did to the filesystem — attribution at the write, not at the end.
 *
 * The trap this design exists to avoid: diffing the shared workspace once a
 * split ends cannot say which of two concurrent heads made which change. So
 * every assertion here is about a write landing in the ledger of the plane it
 * was made through, and about the counts being the ones a review would state.
 */

import { describe, test, expect } from 'bun:test';
import { CompositeVFS } from '../src/vfs/composite.js';
import { HeadFileChanges, formatHeadFileChanges } from '../src/heads/file-changes.js';
import type { VFS } from '../src/types/primitives.js';
import { makeVfsError } from '../src/vfs/errno.js';

/** An in-memory VFS leaf, with a read counter so "one baseline read per path"
 *  is measured rather than assumed. */
function memVfs(seed: Record<string, string> = {}): VFS & { reads: number; files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const self = {
    reads: 0,
    files,
    async readFile(path: string) {
      self.reads++;
      const v = files.get(path);
      if (v === undefined) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
      return v;
    },
    async writeFile(path: string, data: string | Uint8Array) {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    async readdir() { return [...files.keys()]; },
    async stat(path: string) {
      return files.has(path) ? { size: files.get(path)!.length, mtimeMs: 0, isDir: false } : null;
    },
    async unlink(path: string) { files.delete(path); },
    async mkdir() {},
    async exists(path: string) { return files.has(path); },
  };
  return self;
}

/** A composite with a real mount at /workspace and a watched write plane. */
function watched(seed: Record<string, string> = {}) {
  const local = memVfs();
  const workspace = memVfs(seed);
  const vfs = new CompositeVFS({ local });
  vfs.mount('workspace', { vfs: workspace, policy: { readOnly: false, rootPath: '', consistency: 'durable' } });
  const changes = new HeadFileChanges();
  vfs.observeWrites(changes);
  return { vfs, changes, local, workspace };
}

describe('HeadFileChanges — the review a parent gets', () => {
  test('a created file is added, with every line counted', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('/workspace/new.ts', 'a\nb\nc\n');
    expect(changes.snapshot()).toEqual([
      { path: '/workspace/new.ts', status: 'added', added: 3, removed: 0 },
    ]);
  });

  test('an edited file reports the lines a diff would', async () => {
    const { vfs, changes } = watched({ 'keep.ts': 'one\ntwo\nthree\n' });
    await vfs.writeFile('/workspace/keep.ts', 'one\nTWO\nthree\nfour\n');
    expect(changes.snapshot()).toEqual([
      { path: '/workspace/keep.ts', status: 'changed', added: 2, removed: 1 },
    ]);
  });

  test('a deleted file reports its lines as removed', async () => {
    const { vfs, changes } = watched({ 'gone.ts': 'x\ny\n' });
    await vfs.unlink('/workspace/gone.ts');
    expect(changes.snapshot()).toEqual([
      { path: '/workspace/gone.ts', status: 'removed', added: 0, removed: 2 },
    ]);
  });

  test('repeated writes report the NET change, against what the head first found', async () => {
    const { vfs, changes, workspace } = watched({ 'f.ts': 'base\n' });
    await vfs.writeFile('/workspace/f.ts', 'base\nstep one\n');
    await vfs.writeFile('/workspace/f.ts', 'base\nstep one\nstep two\n');
    await vfs.writeFile('/workspace/f.ts', 'base\nfinal\n');
    expect(changes.snapshot()).toEqual([
      { path: '/workspace/f.ts', status: 'changed', added: 1, removed: 0 },
    ]);
    // And the baseline was read once, not once per write.
    expect(workspace.reads).toBe(1);
  });

  test('a file written back to what it was is not a change', async () => {
    const { vfs, changes } = watched({ 'f.ts': 'same\n' });
    await vfs.writeFile('/workspace/f.ts', 'different\n');
    await vfs.writeFile('/workspace/f.ts', 'same\n');
    expect(changes.snapshot()).toEqual([]);
  });

  test('a file created and then deleted is not a change', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('/workspace/tmp.ts', 'scratch\n');
    await vfs.unlink('/workspace/tmp.ts');
    expect(changes.snapshot()).toEqual([]);
  });

  test('binary content is reported as changed without inventing a line count', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('/workspace/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(changes.snapshot()).toEqual([
      { path: '/workspace/logo.png', status: 'added', added: 0, removed: 0, binary: true },
    ]);
  });

  test("the head's private /local scratch is not reported — the parent cannot address it", async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('/local/notes.md', 'thinking out loud\n');
    // Including the compat route, which IS /local under another spelling.
    await vfs.writeFile('/scratch/plan.md', 'also mine\n');
    expect(changes.snapshot()).toEqual([]);
  });

  test('a write that the mount refused is not reported as a change', async () => {
    const { vfs, changes } = watched();
    vfs.reserve('sandbox', 'not configured here', { readOnly: false, rootPath: '/', consistency: 'ephemeral' });
    await expect(vfs.writeFile('/sandbox/x.ts', 'nope')).rejects.toThrow();
    expect(changes.snapshot()).toEqual([]);
  });

  test('changes are sorted by path', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('/workspace/z.ts', 'z\n');
    await vfs.writeFile('/workspace/a.ts', 'a\n');
    expect(changes.snapshot().map((c) => c.path)).toEqual(['/workspace/a.ts', '/workspace/z.ts']);
  });

  test('nothing is watching by default, so an unwired plane costs no extra read', async () => {
    const workspace = memVfs({ 'f.ts': 'x\n' });
    const vfs = new CompositeVFS({ local: memVfs() });
    vfs.mount('workspace', { vfs: workspace, policy: { readOnly: false, rootPath: '', consistency: 'durable' } });
    await vfs.writeFile('/workspace/f.ts', 'y\n');
    expect(workspace.reads).toBe(0);
  });
});

describe('formatHeadFileChanges', () => {
  test('renders status, path and counts; empty in, empty out', () => {
    expect(formatHeadFileChanges([])).toEqual([]);
    expect(formatHeadFileChanges([
      { path: '/workspace/a.ts', status: 'added', added: 12, removed: 0 },
      { path: '/workspace/b.ts', status: 'changed', added: 3, removed: 9 },
      { path: '/workspace/c.ts', status: 'removed', added: 0, removed: 40 },
      { path: '/workspace/d.png', status: 'added', added: 0, removed: 0, binary: true },
    ])).toEqual([
      '  A  /workspace/a.ts  +12 −0',
      '  M  /workspace/b.ts  +3 −9',
      '  D  /workspace/c.ts  +0 −40',
      '  A  /workspace/d.png  (binary)',
    ]);
  });
});
