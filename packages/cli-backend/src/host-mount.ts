import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The host filesystem as a file plane, via node:fs. Writes snapshot into the
 * bound shell's shadow-git checkpoints, so /undo covers them.
 */

import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileCheckpoints, FileReach, MountedVfs } from '@kinu.run/core';
import { NIMBUS_WORKSPACE_ROOT, SLATES_ROOT, WORKSPACE_ROOT, workspacePath } from '@kinu.run/core';
import { isVfsError, syscallError, toVfsError, type VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import { settle, tolerateAsync } from '@kinu.run/core/obs';

function onHost<A>(syscall: string, path: string, run: () => Promise<A>): Effect.Effect<A, VfsError> {
  return Effect.tryPromise({ try: run, catch: (error) => toVfsError(error, syscall, path) }).pipe(
    Effect.catch((failure) => (isVfsError(failure) ? Effect.fail(failure) : Effect.die(failure))),
  );
}

interface HostFiles {
  readFile(path: string): Effect.Effect<Uint8Array, VfsError>;
  writeFile(path: string, data: string | Uint8Array): Effect.Effect<void, VfsError>;
  readdir(path: string): Effect.Effect<Awaited<ReturnType<VFS['readdir']>>, VfsError>;
  stat(path: string, options?: { readonly follow?: boolean }): Effect.Effect<Awaited<ReturnType<VFS['stat']>>, VfsError>;
  unlink(path: string): Effect.Effect<void, VfsError>;
  mkdir(path: string, opts?: { readonly recursive?: boolean }): Effect.Effect<void, VfsError>;
}

function createHostFiles(root: string, checkpoints: FileCheckpoints | undefined): HostFiles {
  const snapshot = (path: string, reason: string): Effect.Effect<void> => {
    if (!checkpoints) return Effect.void;
    const workdir = checkpoints.workdirForPath(path);

    return Effect.promise(() => checkpoints.ensureCheckpoint(withinRoot(root, workdir) ? workdir : root, reason));
  };

  return {
    readFile: (path) => onHost('open', path, async () => new Uint8Array(await fs.readFile(path))),
    writeFile: (path, data) => Effect.andThen(snapshot(path, 'file write'), onHost('open', path, async () => {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, data);
    })),
    readdir: (path) => onHost('scandir', path, async () => (await fs.readdir(path, { withFileTypes: true })).map((entry) => {
      if (entry.isSymbolicLink()) return { name: entry.name, type: 'symlink' as const };

      return { name: entry.name, type: entry.isDirectory() ? 'directory' as const : 'file' as const };
    })),
    stat: (path, options) => onHost(options?.follow === false ? 'lstat' : 'stat', path, async () => {
      const stat = await tolerateAsync(() => options?.follow === false ? fs.lstat(path) : fs.stat(path), 'enoent');

      if (stat === undefined) return null;
      const type = stat.isSymbolicLink() ? 'symlink' as const : 'file' as const;

      return { size: stat.size, mtimeMs: stat.mtimeMs, type: stat.isDirectory() ? 'directory' : type };
    }),
    unlink: (path) => Effect.andThen(snapshot(path, 'file delete'), onHost('rm', path, () => fs.rm(path, { recursive: true, force: true }))),
    mkdir: (path, opts) => onHost('mkdir', path, async () => { await fs.mkdir(path, { recursive: opts?.recursive ?? false }); }),
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
  const host = createHostFiles(root, checkpoints);
  const locate = cwdPlaneLocator(root);
  const hostPath = (path: string): string => locate(path).hostPath;

  const remove = (path: string): Effect.Effect<void, VfsError> => {
    const target = hostPath(path);

    if (target === root) {
      return Effect.fail(syscallError('EACCES', 'unlink', path, { detail: 'the workspace directory itself cannot be removed' }));
    }

    return host.unlink(target);
  };

  return {
    readFile: (path) => settle(host.readFile(hostPath(path))),
    writeFile: (path, data) => settle(host.writeFile(hostPath(path), data)),
    readdir: (path) => settle(host.readdir(hostPath(path))),
    stat: (path, options) => settle(host.stat(hostPath(path), options)),
    unlink: (path) => settle(remove(path)),
    removeRecursive: (path) => settle(remove(path)),
    mkdir: (path, opts) => settle(host.mkdir(hostPath(path), opts)),
  };
}


function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);

  if (distance === '') return true;

  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
