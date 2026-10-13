import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import type { NimbusSandboxFiles, NimbusSandboxHandle } from '@kinu.run/core';
// Map-backed VFS; `mkdir` surfaces EEXIST on repeat unless recursive, like the real backends. Each write moves the file's
// revision, and a revision-checked write lands only over the one named (0: no file), as the workspace's store checks.


export interface MemoryVfs {
  vfs: VFS & Required<Pick<VFS, 'readRange' | 'writeFileIfRevision'>>;
  /** Written files, by absolute path — assert spill contents through this. */
  files: Map<string, string | Uint8Array>;
}

export function createMemoryVfs(): MemoryVfs {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const revisions = new Map<string, number>();
  // A file put straight into `files` is at revision 1.
  let clock = 1;
  const revisionOf = (path: string): number => (files.has(path) ? revisions.get(path) ?? 1 : 0);

  const write = (path: string, data: string | Uint8Array): void => {
    files.set(path, data instanceof Uint8Array ? data.slice() : data);
    clock += 1;
    revisions.set(path, clock);
  };

  const vfs: VFS & Required<Pick<VFS, 'readRange' | 'writeFileIfRevision'>> = {
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
    writeFile: async (path, data) => { write(path, data); },
    writeFileIfRevision: async (path, data, expected) => {
      if (String(revisionOf(path)) !== String(expected)) return { ok: false, revision: revisionOf(path) };
      write(path, data);

      return { ok: true, revision: revisionOf(path) };
    },
    readdir: async (path) => [...files.keys()]
      .filter((f) => f.startsWith(`${path}/`))
      .map((f) => ({ name: f.slice(path.length + 1), type: 'file' })),
    stat: async (path) => {
      const content = files.get(path);

      if (content === undefined) return dirs.has(path) ? { size: 0, mtimeMs: 0, type: 'directory' } : null;

      return {
        size: content instanceof Uint8Array ? content.byteLength : new TextEncoder().encode(content).byteLength, mtimeMs: 0, type: 'file', revision: revisionOf(path),
      };
    },
    unlink: async (path) => {
      files.delete(path);
      revisions.delete(path);
    },
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
  };

  return plane;
}
