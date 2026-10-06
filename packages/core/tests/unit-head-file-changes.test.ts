import { type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { describe, test, expect } from 'bun:test';
import { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
import { observeNamespace } from '../src/vfs/write-events';
import { HeadFileChanges } from '../src/heads/file-changes';

import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';

/** In-memory VFS with a read counter. */
function memVfs(seed: Record<string, string> = {}): VFS & { reads: number; files: Map<string, string> } {
  const files = new Map(Object.entries(seed));

  const self: VFS & { reads: number; files: Map<string, string> } = {
    reads: 0,
    files,
    async readFile(path: string) {
      self.reads++;
      const v = files.get(path);

      if (v === undefined) throw new VfsError('ENOENT', 'no such file or directory, open', path);

      return new TextEncoder().encode(v);
    },
    async writeFile(path: string, data: Uint8Array) {
      files.set(path, new TextDecoder().decode(data));
    },
    async readdir() { return [...files.keys()].map((name) => ({ name, type: 'file' as const })); },
    async stat(path: string) {
      const content = files.get(path);

      return content === undefined ? null : { size: new TextEncoder().encode(content).byteLength, mtimeMs: 0, type: 'file' };
    },
    async unlink(path: string) { files.delete(path); },
    async mkdir() {},
  };

  return self;
}

/** `workspace` behind a namespace whose landed writes `changes` hears, as a head's plane is. */
function observeWrites(workspace: VFS, changes: HeadFileChanges): CompositeVFS {
  const namespace = new CompositeVFS(workspace, { resolvesPaths: true });
  observeNamespace(namespace, changes);

  return namespace;
}

/** The parent's workspace, watched; the head's own scratch VFS is not observed. */
function watched(seed: Record<string, string> = {}) {
  const local = memVfs();
  const workspace = memVfs(seed);
  const changes = new HeadFileChanges();

  return { vfs: observeWrites(workspace, changes), changes, local, workspace };
}

describe('HeadFileChanges — the review a parent gets', () => {
  test('a created file is added, with every line counted', async () => {
    const { vfs, changes } = watched();
    await writeText(vfs, '/new.ts', 'a\nb\nc\n');
    expect(changes.snapshot()).toEqual([
      { path: '/new.ts', status: 'added', added: 3, removed: 0 },
    ]);
  });

  test('an edited file reports the lines a diff would', async () => {
    const { vfs, changes } = watched({ '/keep.ts': 'one\ntwo\nthree\n' });
    await writeText(vfs, '/keep.ts', 'one\nTWO\nthree\nfour\n');
    expect(changes.snapshot()).toEqual([
      { path: '/keep.ts', status: 'changed', added: 2, removed: 1 },
    ]);
  });

  test('a deleted file reports its lines as removed', async () => {
    const { vfs, changes } = watched({ '/gone.ts': 'x\ny\n' });
    await vfs.unlink('/gone.ts');
    expect(changes.snapshot()).toEqual([
      { path: '/gone.ts', status: 'removed', added: 0, removed: 2 },
    ]);
  });

  test('repeated writes report the NET change, against what the head first found', async () => {
    const { vfs, changes, workspace } = watched({ '/f.ts': 'base\n' });
    await writeText(vfs, '/f.ts', 'base\nstep one\n');
    await writeText(vfs, '/f.ts', 'base\nstep one\nstep two\n');
    await writeText(vfs, '/f.ts', 'base\nfinal\n');
    expect(changes.snapshot()).toEqual([
      { path: '/f.ts', status: 'changed', added: 1, removed: 0 },
    ]);
    expect(workspace.reads).toBe(1);
  });

  test('a file written back to what it was is not a change', async () => {
    const { vfs, changes } = watched({ '/f.ts': 'same\n' });
    await writeText(vfs, '/f.ts', 'different\n');
    await writeText(vfs, '/f.ts', 'same\n');
    expect(changes.snapshot()).toEqual([]);
  });

  test('a file created and then deleted is not a change', async () => {
    const { vfs, changes } = watched();
    await writeText(vfs, '/tmp.ts', 'scratch\n');
    await vfs.unlink('/tmp.ts');
    expect(changes.snapshot()).toEqual([]);
  });

  test('binary content is reported as changed without inventing a line count', async () => {
    const { vfs, changes } = watched();
    await vfs.writeFile('/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(changes.snapshot()).toEqual([
      { path: '/logo.png', status: 'added', added: 0, removed: 0, binary: true },
    ]);
  });
  test('a binary before-image stays binary (no utf8 decode of the baseline)', async () => {
    const bytes = new Map<string, Uint8Array>([['/logo.png', new Uint8Array([0x89, 0x50, 0xae, 0xff])]]);

    const raw: VFS = {
      readFile: async (path: string) => {
        const found = bytes.get(path);

        if (found === undefined) throw new VfsError('ENOENT', 'no such file or directory, open', path);

        return found;
      },
      writeFile: async (path: string, data: string | Uint8Array) => {
        bytes.set(path, data instanceof Uint8Array ? data : new TextEncoder().encode(data));
      },
      readdir: async () => [...bytes.keys()].map((name) => ({ name, type: 'file' })),
      stat: async (path: string) => {
        const found = bytes.get(path);

        return found === undefined ? null : { size: found.length, mtimeMs: 0, type: 'file' };
      },
      unlink: async (path: string) => { bytes.delete(path); },
      mkdir: async () => {},
    };

    const changes = new HeadFileChanges();
    const vfs = observeWrites(raw, changes);
    await writeText(vfs, '/logo.png', 'hello\n');
    expect(changes.snapshot()).toEqual([
      { path: '/logo.png', status: 'changed', added: 0, removed: 0, binary: true },
    ]);
  });

  test("the head's own workspace is not reported — the parent cannot address it", async () => {
    const { local, changes } = watched();
    await writeText(local, '/notes.md', 'thinking out loud\n');
    await writeText(local, '/plan.md', 'also mine\n');
    expect(changes.snapshot()).toEqual([]);
  });

  test('a write the plane refused is not reported as a change', async () => {
    const changes = new HeadFileChanges();

    const refusing = observeWrites({
      ...memVfs(),
      async writeFile(_path: string, _data: string | Uint8Array) { throw new VfsError('EROFS', 'read-only', '/x.ts'); },
    }, changes);

    await expect(writeText(refusing, '/x.ts', 'nope')).rejects.toThrow('EROFS: read-only');
    expect(changes.snapshot()).toEqual([]);
  });

  test('a deleted directory is reported as one, and never read', async () => {
    const workspace = memVfs();
    const changes = new HeadFileChanges();
    let directoryReads = 0;

    const vfs = observeWrites({
      ...workspace,
      async stat(path: string) {
        return path === '/build' ? { size: 0, mtimeMs: 0, type: 'directory' as const } : workspace.stat(path);
      },
      async readFile(path: string) {
        if (path !== '/build') return workspace.readFile(path);
        directoryReads += 1;
        throw new VfsError('EISDIR', 'illegal operation on a directory, read', path);
      },
    }, changes);

    await vfs.unlink('/build');

    expect(changes.snapshot()).toEqual([{ path: '/build', status: 'removed', added: 0, removed: 0, directory: true }]);
    expect(directoryReads).toBe(0);
  });

  test('a write over content that cannot be read still lands in the review, counts omitted', async () => {
    const workspace = memVfs({ '/locked.ts': 'x\n' });
    const changes = new HeadFileChanges();

    const vfs = observeWrites({
      ...workspace,
      async readFile(path: string) { throw new VfsError('EACCES', `permission denied, open '${path}'`, path); },
    }, changes);

    await writeText(vfs, '/locked.ts', 'y\n');

    expect(changes.snapshot()).toEqual([{ path: '/locked.ts', status: 'changed', added: 0, removed: 0, unreadable: true }]);
  });

  test('changes are sorted by path', async () => {
    const { vfs, changes } = watched();
    await writeText(vfs, '/z.ts', 'z\n');
    await writeText(vfs, '/a.ts', 'a\n');
    expect(changes.snapshot().map((c) => c.path)).toEqual(['/a.ts', '/z.ts']);
  });

  test('an unwatched plane costs no extra read', async () => {
    const workspace = memVfs({ '/f.ts': 'x\n' });
    await writeText(workspace, '/f.ts', 'y\n');
    expect(workspace.reads).toBe(0);
  });
});
