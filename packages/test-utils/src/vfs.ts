// Map-backed VFS; `mkdir` surfaces EEXIST on repeat, like the real backends.
import type { VFS, VfsNativeReads } from '@kinu.run/core';

export interface MemoryVfs {
  vfs: VFS & Pick<VfsNativeReads, 'readRange'>;
  /** Written files, by absolute path — assert spill contents through this. */
  files: Map<string, string | Uint8Array>;
}

export function createMemoryVfs(): MemoryVfs {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();

  const vfs: VFS & Pick<VfsNativeReads, 'readRange'> = {
    readFile: async (path) => {
      const content = files.get(path);

      if (content === undefined) throw new Error(`ENOENT: ${path}`);

      return content instanceof Uint8Array ? content.slice() : content;
    },
    /** Real prefix read, so callers exercise the ranged-read branch, not the no-ranged-read one. */
    readRange: async (path, offset, length) => {
      const content = files.get(path);

      if (content === undefined) throw new Error(`ENOENT: ${path}`);

      const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);

      return bytes.slice(offset, offset + length);
    },
    writeFile: async (path, data) => {
      files.set(path, data instanceof Uint8Array ? data.slice() : data);
    },
    readdir: async (path) => [...files.keys()]
      .filter((f) => f.startsWith(`${path}/`))
      .map((f) => f.slice(path.length + 1)),
    stat: async (path) => {
      const content = files.get(path);

      if (content === undefined) return dirs.has(path) ? { size: 0, mtimeMs: 0, isDir: true } : null;

      return { size: content instanceof Uint8Array ? content.byteLength : new TextEncoder().encode(content).byteLength, mtimeMs: 0, isDir: false };
    },
    unlink: async (path) => { files.delete(path); },
    mkdir: async (path) => {
      if (dirs.has(path)) throw new Error(`EEXIST: directory exists ${path}`);
      dirs.add(path);
    },
    exists: async (path) => files.has(path) || dirs.has(path),
  };

  return { vfs, files };
}
