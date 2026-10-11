import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { RemoteSessionBox } from '@kinu.run/core';
// Map-backed VFS; `mkdir` surfaces EEXIST on repeat unless recursive, like the real backends.


export interface MemoryVfs {
  vfs: VFS & Required<Pick<VFS, 'readRange'>>;
  /** Written files, by absolute path — assert spill contents through this. */
  files: Map<string, string | Uint8Array>;
}

export function createMemoryVfs(): MemoryVfs {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();

  const vfs: VFS & Required<Pick<VFS, 'readRange'>> = {
    readFile: (path) => {
      return settle(Effect.gen(function* () {
        const content = files.get(path);

        if (content === undefined) return yield* Effect.die(new Error(`ENOENT: ${path}`));

        return content instanceof Uint8Array ? content.slice() : new TextEncoder().encode(content);
      }));
    },
    /** Real prefix read, so callers exercise the ranged-read branch, not the no-ranged-read one. */
    readRange: (path, offset, length) => {
      return settle(Effect.gen(function* () {
        const content = files.get(path);

        if (content === undefined) return yield* Effect.die(new Error(`ENOENT: ${path}`));

        const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);

        return bytes.slice(offset, offset + length);
      }));
    },
    writeFile: async (path, data) => {
      files.set(path, data instanceof Uint8Array ? data.slice() : data);
    },
    readdir: async (path) => [...files.keys()]
      .filter((f) => f.startsWith(`${path}/`))
      .map((f) => ({ name: f.slice(path.length + 1), type: 'file' })),
    stat: async (path) => {
      const content = files.get(path);

      if (content === undefined) return dirs.has(path) ? { size: 0, mtimeMs: 0, type: 'directory' } : null;

      return { size: content instanceof Uint8Array ? content.byteLength : new TextEncoder().encode(content).byteLength, mtimeMs: 0, type: 'file' };
    },
    unlink: async (path) => { files.delete(path); },
    mkdir: (path, opts) => {
      return settle(Effect.gen(function* () {
        if (dirs.has(path) && opts?.recursive === true) return;

        if (dirs.has(path)) return yield* Effect.die(new Error(`EEXIST: directory exists ${path}`));
        dirs.add(path);
      }));
    },

  };

  return { vfs, files };
}

/** A remote session's file plane over `files`, shaped as the Nimbus SDK's: an absent path answers null. */
export function sessionFilesOver(files = new Map<string, Uint8Array>()): RemoteSessionBox['files'] {
  const stat = async (path: string) => {
    const bytes = files.get(path);

    return bytes === undefined ? null : { type: 'file', size: bytes.byteLength, mtime: 1 };
  };

  const plane: RemoteSessionBox['files'] = {
    as: () => plane,
    readBytes: async (path) => files.get(path)?.slice() ?? null,
    readRange: async (path, offset, length) => files.get(path)?.slice(offset, offset + length) ?? null,
    write: async (path, content) => { files.set(path, content instanceof Uint8Array ? content.slice() : new TextEncoder().encode(content)); },
    stat,
    lstat: stat,
    // No links in this plane: a present file is no link, as the session answers.
    readlink: async () => null,
    list: async () => [],
    rename: async (from, to) => {
      const bytes = files.get(from);

      if (bytes !== undefined) files.set(to, bytes);
      files.delete(from);
    },
    mkdir: async () => {},
    delete: async (path) => { files.delete(path); },
  };

  return plane;
}
