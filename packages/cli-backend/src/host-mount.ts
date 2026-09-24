/**
 * The host filesystem as a file plane, via node:fs. Writes snapshot into the
 * bound shell's shadow-git checkpoints, so /undo covers them.
 */

import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileCheckpoints, VFS, VfsErrorCode } from '@kinu.run/core';
import { ERRNO, LEGACY_WORKSPACE_ROOT, makeVfsError, WORKSPACE_ROOT } from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';

const nodeErrorSchema = v.object({
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});

function isVfsErrorCode(code: string): code is VfsErrorCode {
  return code in ERRNO;
}

/** node:fs errno → core VfsError. Codes core does not model (EMFILE, ELOOP, …)
 *  pass through untranslated. */
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

function createHostMountVFS(root: string, checkpoints: FileCheckpoints | undefined): VFS {
  const snapshot = async (path: string, reason: string): Promise<void> => {
    if (!checkpoints) return;
    const workdir = checkpoints.workdirForPath(path);
    await checkpoints.ensureCheckpoint(withinRoot(root, workdir) ? workdir : root, reason);
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
        const s = await tolerateAsync(() => fs.stat(path), 'enoent');

        return s === undefined ? null : { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
      } catch (error) { throwVfsError({ error, syscall: 'stat', path }); }
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
      return await tolerateAsync(() => fs.stat(path), 'enoent') !== undefined;
    },
  };
}

/**
 * The working directory as the workspace file plane; agent state stays in
 * `agentStateVfs`. Accepts relative paths, plane-root aliases (`/workspace`,
 * `/home/main`, `/`) and real absolute paths inside the tree; anything else is
 * EACCES. A lexical guard against path confusion, not a sandbox.
 */
export function createCwdPlaneVFS(cwd: string, checkpoints: FileCheckpoints | undefined): VFS {
  const root = resolve(cwd);
  const host = createHostMountVFS(root, checkpoints);

  const hostPath = (path: string): string => {
    const direct = isAbsolute(path) ? resolve(path) : resolve(root, path || '.');

    // A real path inside the directory wins over every alias.
    if (withinRoot(root, direct)) return direct;
    const inner = isAbsolute(path) ? planeRootRelative(path) : null;

    if (inner !== null) {
      const mapped = resolve(root, inner || '.');

      if (withinRoot(root, mapped)) return mapped;
    }

    throw makeVfsError('EACCES', `path escapes the workspace directory ${root}: ${path}`, path);
  };

  return {
    readFile: (path, opts) => host.readFile(hostPath(path), opts),
    writeFile: (path, data) => host.writeFile(hostPath(path), data),
    readdir: (path) => host.readdir(hostPath(path)),
    stat: (path) => host.stat(hostPath(path)),
    unlink: (path) => host.unlink(hostPath(path)),
    mkdir: (path, opts) => host.mkdir(hostPath(path), opts),
    exists: (path) => host.exists(hostPath(path)),
  };
}

/** One table, so a new spelling cannot be honoured by only some operations. */
const PLANE_ROOTS: readonly string[] = ['/', WORKSPACE_ROOT, LEGACY_WORKSPACE_ROOT, '/workspace'];

function planeRootRelative(path: string): string | null {
  for (const planeRoot of PLANE_ROOTS) {
    if (path === planeRoot) return '';

    // `/` names the root only: `/etc/passwd` is never `<cwd>/etc/passwd`.
    if (planeRoot !== '/' && path.startsWith(`${planeRoot}/`)) return path.slice(planeRoot.length + 1);
  }

  return null;
}

function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);

  if (distance === '') return true;

  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
