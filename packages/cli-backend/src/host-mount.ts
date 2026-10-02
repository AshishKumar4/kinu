import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The host filesystem as a file plane, via node:fs. Writes snapshot into the
 * bound shell's shadow-git checkpoints, so /undo covers them.
 */

import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileCheckpoints, FileReach, MountedVfs } from '@kinu.run/core';
import { NIMBUS_WORKSPACE_ROOT, SLATES_ROOT, WORKSPACE_ROOT, workspacePath } from '@kinu.run/core';
import { syscallError, toVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { tolerateAsync } from '@kinu.run/core/obs';

function throwVfsError(input: { error: unknown; syscall: string; path: string }): never {
  throw toVfsError(input.error, input.syscall, input.path);
}

function createHostMountVFS(root: string, checkpoints: FileCheckpoints | undefined): VFS {
  const snapshot = async (path: string, reason: string): Promise<void> => {
    if (!checkpoints) return;
    const workdir = checkpoints.workdirForPath(path);
    await checkpoints.ensureCheckpoint(withinRoot(root, workdir) ? workdir : root, reason);
  };

  return {
    async readFile(path) {
      try {
        return new Uint8Array(await fs.readFile(path));
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
      try {
        return (await fs.readdir(path, { withFileTypes: true })).map((entry) => {
          if (entry.isSymbolicLink()) return { name: entry.name, type: 'symlink' as const };

          return { name: entry.name, type: entry.isDirectory() ? 'directory' as const : 'file' as const };
        });
      }
      catch (error) { throwVfsError({ error, syscall: 'scandir', path }); }
    },
    async stat(path, options) {
      try {
        const stat = await tolerateAsync(() => options?.follow === false ? fs.lstat(path) : fs.stat(path), 'enoent');

        if (stat === undefined) return null;
        const type = stat.isSymbolicLink() ? 'symlink' as const : 'file' as const;

        return { size: stat.size, mtimeMs: stat.mtimeMs, type: stat.isDirectory() ? 'directory' : type };
      } catch (error) { throwVfsError({ error, syscall: options?.follow === false ? 'lstat' : 'stat', path }); }
    },
    async unlink(path) {
      await snapshot(path, 'file delete');

      try { await fs.rm(path, { recursive: true, force: true }); }
      catch (error) { throwVfsError({ error, syscall: 'rm', path }); }
    },
    async mkdir(path, opts) {
      try { await fs.mkdir(path, { recursive: opts?.recursive ?? false }); }
      catch (error) { throwVfsError({ error, syscall: 'mkdir', path }); }
    },
  };
}

/** The native directory wins. The workspace's home (either name) and `/slates` resolve as POSIX resolves them and map
 *  into it; any other path names the host, outside the directory, where the approval gate decides. */
function cwdPlaneLocator(cwd: string): (path: string) => { readonly hostPath: string; readonly outside: boolean } {
  const root = resolve(cwd);

  return (path) => {
    const direct = isAbsolute(path) ? resolve(path) : resolve(root, path || '.');

    if (isAbsolute(path) && withinRoot(root, direct)) return { hostPath: direct, outside: false };
    const named = workspacePath(path, WORKSPACE_ROOT);
    const home = [WORKSPACE_ROOT, NIMBUS_WORKSPACE_ROOT].find((at) => named === at || named.startsWith(`${at}/`));

    if (named === '/') return { hostPath: root, outside: false };

    if (home !== undefined) return { hostPath: resolve(root, `.${named.slice(home.length)}`), outside: false };

    if (named === SLATES_ROOT || named.startsWith(`${SLATES_ROOT}/`)) return { hostPath: resolve(root, `.${named}`), outside: false };

    return { hostPath: direct, outside: true };
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
  const root = resolve(cwd);
  const host = createHostMountVFS(root, checkpoints);
  const locate = cwdPlaneLocator(root);
  const hostPath = (path: string): string => locate(path).hostPath;

  const remove = (path: string) => {
    const target = hostPath(path);

    if (target === root) {
      throwVfsError({
        error: syscallError('EACCES', 'unlink', path, { detail: 'the workspace directory itself cannot be removed' }),
        syscall: 'unlink',
        path,
      });
    }

    return host.unlink(target);
  };

  return {
    readFile: (path) => host.readFile(hostPath(path)),
    writeFile: (path, data) => host.writeFile(hostPath(path), data),
    readdir: (path) => host.readdir(hostPath(path)),
    stat: (path, options) => host.stat(hostPath(path), options),
    unlink: remove,
    removeRecursive: remove,
    mkdir: (path, opts) => host.mkdir(hostPath(path), opts),
  };
}


function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);

  if (distance === '') return true;

  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
