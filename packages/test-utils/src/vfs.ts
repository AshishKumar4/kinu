import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import type { VFS, VfsCasResult } from '@nimbus-sh/core/vfs/vfs.js';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import type { NimbusSandboxFiles, NimbusSandboxHandle } from '@kinu.run/core';

/** A test's file plane: every member a workspace's store answers, its revision-checked write among them. */
export type TestVfs = VFS & Required<Pick<VFS, 'readRange' | 'readlink' | 'rename' | 'removeRecursive' | 'rmdir' | 'symlink' | 'writeFileIfRevision'>>;

export interface MemoryVfs {
  readonly vfs: TestVfs;
}

/**
 * Nimbus's MemoryVFS, POSIX-shaped (a file's directory must be there, so a test seeds it), as a plain object a test may
 * spread to replace one member, with the revision-checked write the workspace's store makes: compared and written in one
 * step, absent at revision 0.
 */
export function createMemoryVfs(): MemoryVfs {
  const memory = new MemoryVFS();

  const vfs: TestVfs = {
    stat: (path, options) => memory.stat(path, options),
    readFile: (path) => memory.readFile(path),
    readRange: (path, offset, length) => memory.readRange(path, offset, length),
    writeFile: (path, data, options) => { memory.writeFile(path, data, options); },
    readdir: (path) => memory.readdir(path),
    mkdir: (path, options) => { memory.mkdir(path, options); },
    unlink: (path) => { memory.unlink(path); },
    rmdir: (path) => { memory.rmdir(path); },
    removeRecursive: (path) => { memory.removeRecursive(path); },
    rename: (from, to) => { memory.rename(from, to); },
    symlink: (target, path) => { memory.symlink(target, path); },
    readlink: (path) => memory.readlink(path),
    writeFileIfRevision: (path, data, expected): VfsCasResult => {
      const current = memory.stat(path)?.revision ?? 0;

      if (String(current) !== String(expected)) return { ok: false, revision: current };
      memory.writeFile(path, data);

      return { ok: true, revision: memory.stat(path)?.revision ?? 0 };
    },
  };

  return { vfs };
}

/** Writes each of `files` (path: text) into `vfs`, making its directories first, as a test's seed. */
export async function seedFiles(vfs: VFS, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const dir = path.slice(0, path.lastIndexOf('/'));

    if (dir !== '') await vfs.mkdir(dir, { recursive: true });
    await vfs.writeFile(path, new TextEncoder().encode(text));
  }
}

/** Every file under `dir` in `vfs`, by absolute path, in order: what a test reads to say what was written. */
export async function filesIn(vfs: VFS, dir = '/'): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await vfs.readdir(dir)) {
    const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;

    if (entry.type === 'directory') found.push(...await filesIn(vfs, path));
    else found.push(path);
  }

  return found.sort();
}

/** A test's Nimbus box with a session's file plane beside it, the plane `nimbusSessionFiles` reads. */
export type SessionBox = NimbusSandboxHandle & { readonly files: NimbusSandboxFiles };

/**
 * A remote session's file plane over `files`, the Nimbus SDK's contract: an absent path answers null, and each write
 * moves the file's revision, which a revision-checked write is checked against (0: no file). It keeps no modes.
 */
export function sessionFilesOver(files = new Map<string, Uint8Array>()): NimbusSandboxFiles {
  const revisions = new Map<string, number>();
  // A file seeded into `files` is at revision 1.
  let clock = 1;

  const stat = async (path: string) => {
    const bytes = files.get(path);

    return bytes === undefined ? null : { type: 'file', size: bytes.byteLength, mtime: 1, mode: 0o644, revision: revisions.get(path) ?? 1 };
  };

  const write = (path: string, content: string | Uint8Array): void => {
    files.set(path, content instanceof Uint8Array ? content.slice() : new TextEncoder().encode(content));
    clock += 1;
    revisions.set(path, clock);
  };

  const plane: NimbusSandboxFiles = {
    as: () => plane,
    read: async (path) => {
      const bytes = files.get(path);

      return bytes === undefined ? null : new TextDecoder().decode(bytes);
    },
    readBytes: async (path) => files.get(path)?.slice() ?? null,
    exists: async (path) => files.has(path),
    readRange: async (path, offset, length) => files.get(path)?.slice(offset, offset + length) ?? null,
    write: async (path, content) => { write(path, content); },
    writeIfRevision: async (path, content, expected) => {
      const current = files.has(path) ? revisions.get(path) ?? 1 : 0;

      if (current !== expected) return { ok: false, revision: current };
      write(path, content);

      return { ok: true, revision: revisions.get(path) ?? 1 };
    },
    stat,
    lstat: stat,
    // No links in this plane: a present file is no link, as the session answers.
    readlink: async () => null,
    list: async () => [],
    rename: async (from, to) => {
      const bytes = files.get(from);

      if (bytes !== undefined) write(to, bytes);
      files.delete(from);
      revisions.delete(from);
    },
    mkdir: async () => {},
    chmod: (path) => settle(Effect.fail(new VfsError('ENOTSUP', 'this test plane keeps no modes', path))),
    delete: async (path) => {
      files.delete(path);
      revisions.delete(path);
    },
    unlink: async (path) => {
      files.delete(path);
      revisions.delete(path);
    },
    // No directories in this plane, so none to remove.
    rmdir: (path) => settle(Effect.fail(new VfsError('ENOTDIR', 'this test plane keeps no directories', path))),
    appendFile: async (path, content) => {
      const added = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
      const present = files.get(path) ?? new Uint8Array();
      const joined = new Uint8Array(present.byteLength + added.byteLength);

      joined.set(present);
      joined.set(added, present.byteLength);
      write(path, joined);
    },
    symlink: (_target, path) => settle(Effect.fail(new VfsError('ENOTSUP', 'this test plane keeps no links', path))),
    realpath: async (path) => path,
    truncate: async (path, size) => {
      const present = files.get(path) ?? new Uint8Array();
      const cut = new Uint8Array(size);

      cut.set(present.subarray(0, size));
      write(path, cut);
    },
    utimes: (path) => settle(Effect.fail(new VfsError('ENOTSUP', 'this test plane keeps no times', path))),
    chown: (path) => settle(Effect.fail(new VfsError('ENOTSUP', 'this test plane keeps no owners', path))),
  };

  return plane;
}
