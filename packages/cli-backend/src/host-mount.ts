/**
 * /pc — the host filesystem as a composite mount.
 *
 * The cloud backend mounts the user's machine at /pc over the device tunnel
 * (createDeviceMountVFS). Locally the agent IS on that machine, so the same
 * plane is node:fs directly — no tunnel, no consent round-trip, the same
 * addresses. Without it the local backend had a `laptop` executor whose files
 * were unreachable by composite path, so every /pc address the cloud agent can
 * use silently compat-routed into /local.
 *
 * Writes snapshot into the same shadow-git checkpoints the bound shell and
 * `laptop.writeFile` use, so /undo covers file-plane mutations too.
 */

import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileCheckpoints, VFS, VfsErrorCode } from '@proteus/core';
import { ERRNO, makeVfsError } from '@proteus/core';

function isVfsErrorCode(code: string): code is VfsErrorCode {
  return code in ERRNO;
}

/** node:fs errno → the core VfsError shape mounts are contracted to throw.
 *  Codes core does not model (EMFILE, ELOOP, …) pass through untranslated
 *  rather than being flattened into a lie about what went wrong. */
function asVfsError(err: unknown, syscall: string, path: string): unknown {
  const code = (err as { code?: string } | null)?.code;
  return code && isVfsErrorCode(code)
    ? makeVfsError(code, `${(err as Error).message}, ${syscall} '${path}'`, path)
    : err;
}

export function createHostMountVFS(checkpoints: FileCheckpoints | undefined): VFS {
  const snapshot = async (path: string, reason: string): Promise<void> => {
    await checkpoints?.ensureCheckpoint(checkpoints.workdirForPath(path), reason);
  };
  return {
    async readFile(path, opts) {
      try {
        return opts?.encoding === 'utf-8' || opts?.encoding === 'utf8'
          ? await fs.readFile(path, 'utf-8')
          : new Uint8Array(await fs.readFile(path));
      } catch (err) { throw asVfsError(err, 'open', path); }
    },
    async writeFile(path, data) {
      await snapshot(path, 'file write');
      try {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, data);
      } catch (err) { throw asVfsError(err, 'open', path); }
    },
    async readdir(path) {
      try { return await fs.readdir(path); }
      catch (err) { throw asVfsError(err, 'scandir', path); }
    },
    async stat(path) {
      try {
        const s = await fs.stat(path);
        return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return null;
        throw asVfsError(err, 'stat', path);
      }
    },
    async unlink(path) {
      await snapshot(path, 'file delete');
      try { await fs.rm(path, { recursive: true, force: true }); }
      catch (err) { throw asVfsError(err, 'unlink', path); }
    },
    async mkdir(path, opts) {
      try { await fs.mkdir(path, { recursive: opts?.recursive ?? false }); }
      catch (err) { throw asVfsError(err, 'mkdir', path); }
    },
    async exists(path) {
      try { await fs.stat(path); return true; }
      catch { return false; }
    },
  };
}
