/**
 * The host filesystem as a file plane, via node:fs. Writes snapshot into the
 * bound shell's shadow-git checkpoints, so /undo covers them.
 */

import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileCheckpoints, FileReach, MountedVfs, VFS } from '@kinu.run/core';
import { LEGACY_WORKSPACE_ROOT, SLATES_ROOT, WORKSPACE_ROOT } from '@kinu.run/core';
import { toVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { tolerateAsync } from '@kinu.run/core/obs';

function throwVfsError(input: { error: unknown; path: string }): never {
  throw toVfsError(input.error, input.path);
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
      } catch (error) { throwVfsError({ error, path }) }
    },
    async writeFile(path, data) {
      await snapshot(path, 'file write');

      try {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, data);
      } catch (error) { throwVfsError({ error, path }) }
    },
    async readdir(path) {
      try { return await fs.readdir(path); }
      catch (error) { throwVfsError({ error, path }) }
    },
    async stat(path) {
      try {
        const s = await tolerateAsync(() => fs.stat(path), 'enoent');

        return s === undefined ? null : { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
      } catch (error) { throwVfsError({ error, path }) }
    },
    async unlink(path) {
      await snapshot(path, 'file delete');

      try { await fs.rm(path, { recursive: true, force: true }); }
      catch (error) { throwVfsError({ error, path }) }
    },
    async mkdir(path, opts) {
      try { await fs.mkdir(path, { recursive: opts?.recursive ?? false }); }
      catch (error) { throwVfsError({ error, path }) }
    },
    async exists(path) {
      return await tolerateAsync(() => fs.stat(path), 'enoent') !== undefined;
    },
  };
}

/** Relative paths and aliases (`/workspace`, `/home/main`, `/`, `/slates`) stay in the tree, or EACCES; any other
 *  absolute path is that host path. Not a sandbox. */
function cwdPlaneLocator(cwd: string): (path: string) => { readonly hostPath: string; readonly outside: boolean } {
  const root = resolve(cwd);

  return (path) => {
    const direct = isAbsolute(path) ? resolve(path) : resolve(root, path || '.');

    // A real path inside the directory wins over every alias.
    if (withinRoot(root, direct)) return { hostPath: direct, outside: false };
    const inner = isAbsolute(path) ? planeRootRelative(path) : null;

    if (inner === null && isAbsolute(path)) return { hostPath: direct, outside: true };
    const mapped = inner === null ? null : resolve(root, inner || '.');

    if (mapped !== null && withinRoot(root, mapped)) return { hostPath: mapped, outside: false };

    throw new VfsError('EACCES', `path escapes the workspace directory ${root}: ${path}; name a file outside it by its absolute path`, path);
  };
}

/** The file gate's reach: `cwd` under `table`'s mounts, or the in-SQLite plane (null). */
export function directoryFileReach(cwd: string | null, table: MountedVfs | null): FileReach {
  const userRoots = () => table?.userRoots() ?? [];

  if (cwd === null) return { userRoots, locate: null, parksWrites: false };
  const locate = cwdPlaneLocator(cwd);

  // A mounted path is its mount's; the CLI asks, so nothing parks.
  return { userRoots, locate: (path) => ((table?.mountOf(path) ?? null) === null ? locate(path) : { hostPath: path, outside: false }), parksWrites: false };
}

/** The working directory as the file plane ({@link cwdPlaneLocator}). */
export function createCwdPlaneVFS(cwd: string, checkpoints: FileCheckpoints | undefined): VFS {
  const host = createHostMountVFS(resolve(cwd), checkpoints);
  const locate = cwdPlaneLocator(cwd);
  const hostPath = (path: string): string => locate(path).hostPath;

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

/** One table, so a new spelling cannot be honoured by only some operations: each root and the directory it names. */
const PLANE_ROOTS: readonly (readonly [root: string, directory: string])[] = [
  ['/', ''], [WORKSPACE_ROOT, ''], [LEGACY_WORKSPACE_ROOT, ''], ['/workspace', ''],
  // The workspace's slates are the project's own.
  [SLATES_ROOT, 'slates'],
];

function planeRootRelative(path: string): string | null {
  for (const [planeRoot, directory] of PLANE_ROOTS) {
    if (path === planeRoot) return directory;

    // `/` names the root only: `/etc/passwd` is never `<cwd>/etc/passwd`.
    if (planeRoot !== '/' && path.startsWith(`${planeRoot}/`)) {
      const inner = path.slice(planeRoot.length + 1);

      return directory === '' ? inner : `${directory}/${inner}`;
    }
  }

  return null;
}

function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);

  if (distance === '') return true;

  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
