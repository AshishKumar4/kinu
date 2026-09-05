/**
 * What a head did to the filesystem — attribution at the write, not at the end.
 *
 * The trap this design exists to avoid: diffing the shared workspace once a
 * split ends cannot say which of two concurrent heads made which change. So
 * every assertion here is about a write landing in the ledger of the plane it
 * was made through, and about the counts being the ones a review would state.
 */

import { describe, test, expect } from 'bun:test';
import { observeWrites } from '../src/vfs/observe';
import { HeadFileChanges } from '../src/heads/file-changes';
import type { VFS } from '../src/types/primitives';
import { makeVfsError } from '../src/vfs/errno';

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
      files.set(path, data instanceof Uint8Array ? new TextDecoder().decode(data) : data);
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

/** A head's view of its PARENT's workspace, watched. The head's own filesystem
 *  is a different object entirely and is deliberately not observed — it is
 *  private scratch that dies with the head. */
function watched(seed: Record<string, string> = {}) {
  const local = memVfs();
  const workspace = memVfs(seed);
  const changes = new HeadFileChanges();
  return { vfs: observeWrites(workspace, changes), changes, local, workspace };
}

describe('HeadFileChanges — the review a parent gets', () => {
  test('a created file is added, with every line counted', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('new.ts', 'a\nb\nc\n');
    expect(changes.snapshot()).toEqual([
      { path: 'new.ts', status: 'added', added: 3, removed: 0 },
    ]);
  });

  test('an edited file reports the lines a diff would', async () => {
    const { vfs, changes } = watched({ 'keep.ts': 'one\ntwo\nthree\n' });
    await vfs.writeFile('keep.ts', 'one\nTWO\nthree\nfour\n');
    expect(changes.snapshot()).toEqual([
      { path: 'keep.ts', status: 'changed', added: 2, removed: 1 },
    ]);
  });

  test('a deleted file reports its lines as removed', async () => {
    const { vfs, changes } = watched({ 'gone.ts': 'x\ny\n' });
    await vfs.unlink('gone.ts');
    expect(changes.snapshot()).toEqual([
      { path: 'gone.ts', status: 'removed', added: 0, removed: 2 },
    ]);
  });

  test('repeated writes report the NET change, against what the head first found', async () => {
    const { vfs, changes, workspace } = watched({ 'f.ts': 'base\n' });
    await vfs.writeFile('f.ts', 'base\nstep one\n');
    await vfs.writeFile('f.ts', 'base\nstep one\nstep two\n');
    await vfs.writeFile('f.ts', 'base\nfinal\n');
    expect(changes.snapshot()).toEqual([
      { path: 'f.ts', status: 'changed', added: 1, removed: 0 },
    ]);
    // And the baseline was read once, not once per write.
    expect(workspace.reads).toBe(1);
  });

  test('a file written back to what it was is not a change', async () => {
    const { vfs, changes } = watched({ 'f.ts': 'same\n' });
    await vfs.writeFile('f.ts', 'different\n');
    await vfs.writeFile('f.ts', 'same\n');
    expect(changes.snapshot()).toEqual([]);
  });

  test('a file created and then deleted is not a change', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('tmp.ts', 'scratch\n');
    await vfs.unlink('tmp.ts');
    expect(changes.snapshot()).toEqual([]);
  });

  test('binary content is reported as changed without inventing a line count', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(changes.snapshot()).toEqual([
      { path: 'logo.png', status: 'added', added: 0, removed: 0, binary: true },
    ]);
  });
  test('a binary before-image stays binary (no utf8 decode of the baseline)', async () => {
    const bytes = new Map<string, Uint8Array>([['logo.png', new Uint8Array([0x89, 0x50, 0xae, 0xff])]]);
    const raw: VFS = {
      readFile: async (path: string, opts?: { encoding?: string }) => {
        const found = bytes.get(path);
        if (found === undefined) throw makeVfsError('ENOENT', `no such file or directory, open '${path}'`, path);
        return opts?.encoding === 'utf8' ? new TextDecoder().decode(found) : found;
      },
      writeFile: async (path: string, data: string | Uint8Array) => {
        bytes.set(path, data instanceof Uint8Array ? data : new TextEncoder().encode(data));
      },
      readdir: async () => [...bytes.keys()],
      stat: async (path: string) => {
        const found = bytes.get(path);
        return found === undefined ? null : { size: found.length, mtimeMs: 0, isDir: false };
      },
      unlink: async (path: string) => { bytes.delete(path); },
      mkdir: async () => {},
      exists: async (path: string) => bytes.has(path),
    };
    const changes = new HeadFileChanges();
    const vfs = observeWrites(raw, changes);
    await vfs.writeFile('logo.png', 'hello\n');
    expect(changes.snapshot()).toEqual([
      { path: 'logo.png', status: 'changed', added: 0, removed: 0, binary: true },
    ]);
  });

  test("the head's own workspace is not reported — the parent cannot address it", async () => {
    const { local, changes } = watched();
    // The head's private scratch is a DIFFERENT filesystem, and nothing wraps
    // it: writing there cannot reach this ledger even by accident.
    await local.writeFile('notes.md', 'thinking out loud\n');
    await local.writeFile('plan.md', 'also mine\n');
    expect(changes.snapshot()).toEqual([]);
  });

  test('a write the plane refused is not reported as a change', async () => {
    const changes = new HeadFileChanges();
    const refusing = observeWrites({
      ...memVfs(),
      async writeFile(_path: string, _data: string | Uint8Array) { throw makeVfsError('EROFS', 'read-only', 'x.ts'); },
    }, changes);
    await expect(refusing.writeFile('x.ts', 'nope')).rejects.toThrow();
    expect(changes.snapshot()).toEqual([]);
  });

  test('changes are sorted by path', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('z.ts', 'z\n');
    await vfs.writeFile('a.ts', 'a\n');
    expect(changes.snapshot().map((c) => c.path)).toEqual(['a.ts', 'z.ts']);
  });

  test('an unwatched plane costs no extra read', async () => {
    const workspace = memVfs({ 'f.ts': 'x\n' });
    await workspace.writeFile('f.ts', 'y\n');
    expect(workspace.reads).toBe(0);
  });
});
