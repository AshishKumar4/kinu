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
import * as v from 'valibot';

const nodeErrorSchema = v.object({
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});

function isVfsErrorCode(code: string): code is VfsErrorCode {
  return code in ERRNO;
}

/** node:fs errno → the core VfsError shape mounts are contracted to throw.
 *  Codes core does not model (EMFILE, ELOOP, …) pass through untranslated
 *  rather than being flattened into a lie about what went wrong. */
function nodeError(input: { error: unknown }): v.InferOutput<typeof nodeErrorSchema> | null {
  const parsed = v.safeParse(nodeErrorSchema, input.error);
  return parsed.success ? parsed.output : null;
}

function throwVfsError(input: { error: unknown; syscall: string; path: string }): never {
  const error = nodeError(input);
  if (error?.code && isVfsErrorCode(error.code)) {
    const message = error.message ?? String(input.error);
    throw makeVfsError(error.code, `${message}, ${input.syscall} '${input.path}'`, input.path);
  }
  throw input.error;
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
      } catch (error) { throwVfsError({ error, syscall: 'open', path }); }
    },
    async writeFile(path, data) {
      await snapshot(path, 'file write');
      try {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, data);
      } catch (error) { throwVfsError({ error, syscall: 'open', path }); }
    },
    async readdir(path) {
      try { return await fs.readdir(path); }
      catch (error) { throwVfsError({ error, syscall: 'scandir', path }); }
    },
    async stat(path) {
      try {
        const s = await fs.stat(path);
        return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
      } catch (error) {
        if (nodeError({ error })?.code === 'ENOENT') return null;
        throwVfsError({ error, syscall: 'stat', path });
      }
    },
    async unlink(path) {
      await snapshot(path, 'file delete');
      try { await fs.rm(path, { recursive: true, force: true }); }
      catch (error) { throwVfsError({ error, syscall: 'unlink', path }); }
    },
    async mkdir(path, opts) {
      try { await fs.mkdir(path, { recursive: opts?.recursive ?? false }); }
      catch (error) { throwVfsError({ error, syscall: 'mkdir', path }); }
    },
    async exists(path) {
      try { await fs.stat(path); return true; }
      catch { return false; }
    },
  };
}
