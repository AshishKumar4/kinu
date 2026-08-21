// Map-backed VFS for tests that exercise a real write → read-back path
// (spills, transcripts, attachments). `mkdir` surfaces EEXIST on repeat, like
// the real backends can, so callers' idempotency handling is actually tested.
import type { VFS } from '@kinu.run/core';

export interface MemoryVfs {
  vfs: VFS;
  /** Written files, by absolute path — assert spill contents through this. */
  files: Map<string, string>;
}

export function createMemoryVfs(): MemoryVfs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const vfs: VFS = {
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, data) => {
      files.set(path, data instanceof Uint8Array ? new TextDecoder().decode(data) : data);
    },
    readdir: async (path) => [...files.keys()]
      .filter((f) => f.startsWith(`${path}/`))
      .map((f) => f.slice(path.length + 1)),
    stat: async (path) => {
      const content = files.get(path);
      if (content === undefined) return dirs.has(path) ? { size: 0, mtimeMs: 0, isDir: true } : null;
      return { size: content.length, mtimeMs: 0, isDir: false };
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
