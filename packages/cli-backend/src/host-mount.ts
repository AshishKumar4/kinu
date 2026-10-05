import type { VFS, VfsDirentType } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The host filesystem as a file plane, via node:fs. Writes snapshot into the
 * bound shell's shadow-git checkpoints, so /undo covers them.
 */

import { lstatSync, readlinkSync, realpathSync, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import type { FileCheckpoints, FileReach, MountedVfs, PathPlanes, VfsMount } from '@kinu.run/core';
import { SLATES_ROOT, WORKSPACE_ROOT, withMountTable, workspacePath } from '@kinu.run/core';
import { syscallError, toVfsError, type VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { settle, tolerate, tolerateAsync } from '@kinu.run/core/obs';

/** `file` is a regular file only (Nimbus 0.15); Nimbus stats what a listing calls `unknown`. */
function hostDirentType(entry: Dirent): VfsDirentType {
  if (entry.isSymbolicLink()) return 'symlink';

  if (entry.isDirectory()) return 'directory';

  if (entry.isFile()) return 'file';

  if (entry.isFIFO()) return 'fifo';

  if (entry.isSocket()) return 'socket';

  if (entry.isBlockDevice()) return 'block';

  return entry.isCharacterDevice() ? 'character' : 'unknown';
}

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
        return (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, type: hostDirentType(entry) }));
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

/** `own`: the own-space path a path names, or null; `real`: where it is on this machine. */
interface LocalPaths {
  readonly own: (path: string) => string | null;
  readonly real: (path: string) => string;
}

/** Core's own-space paths (`/home/main`, `/slates`, a view's root) land in `space` as on the cloud; a relative one in the folder. */
function localPaths(folder: string, space: string, views: readonly string[]): LocalPaths {
  const aliases = [WORKSPACE_ROOT, SLATES_ROOT, ...views.map((name) => `/${name}`)];
  const absolute = (path: string): string => workspacePath(path, folder);

  const own = (path: string): string | null => {
    const at = absolute(path);

    if (at === space || at.startsWith(`${space}/`)) return at.slice(space.length) || '/';

    return aliases.some((alias) => at === alias || at.startsWith(`${alias}/`)) ? at : null;
  };

  const real = (path: string): string => {
    const named = own(path);

    return named === null ? absolute(path) : join(space, named);
  };

  return { own, real };
}

/** Real files under `root`, named from `/`. */
function rootedFiles(root: string, files: VFS): VFS {
  const at = (path: string): string => join(root, workspacePath(path, '/'));

  return {
    readFile: (path) => files.readFile(at(path)),
    writeFile: (path, data) => files.writeFile(at(path), data),
    readdir: (path) => files.readdir(at(path)),
    stat: (path, options) => files.stat(at(path), options),
    unlink: (path) => files.unlink(at(path)),
    mkdir: (path, opts) => files.mkdir(at(path), opts),
  };
}

export interface LocalFilePlane {
  readonly folder: string;
  readonly space: string;
  /** Mounted on the own space as on the cloud. */
  readonly views: readonly VfsMount[];
  readonly checkpoints: FileCheckpoints | undefined;
}

/** Every real path of the machine, the own space served as the cloud serves its own. Only the folder is snapshotted. */
export function localFilePlane(input: LocalFilePlane): MountedVfs {
  const machine = withMountTable(createHostMountVFS(input.folder, input.checkpoints), []);
  const own = withMountTable(rootedFiles(input.space, createHostMountVFS(input.space, undefined)), input.views);
  const paths = localPaths(input.folder, input.space, input.views.map((view) => view.name));

  const route = (path: string): { readonly files: MountedVfs; readonly path: string } => {
    const named = paths.own(path);

    return named === null ? { files: machine, path: paths.real(path) } : { files: own, path: named };
  };

  const on = <T>(path: string, op: (files: MountedVfs, at: string) => T): T => {
    const at = route(path);

    return op(at.files, at.path);
  };

  const removable = (path: string, syscall: string): Effect.Effect<{ readonly files: MountedVfs; readonly path: string }, VfsError> => {
    const at = route(path);

    return (at.files === own ? at.path === '/' : at.path === input.folder)
      ? Effect.fail(syscallError('EACCES', syscall, path, { detail: 'the workspace\'s own directory and its folder cannot be removed' }))
      : Effect.succeed(at);
  };

  return {
    mountOf: (path) => on(path, (files, at) => (files === own ? own.mountOf(at) : null)),
    mountPoints: () => own.mountPoints(),
    mounts: () => own.mounts(),
    userRoots: () => own.userRoots().flatMap((root) => [root, join(input.space, root)]),
    readFile: (path) => on(path, (files, at) => files.readFile(at)),
    readRange: (path, offset, length) => on(path, (files, at) => files.readRange(at, offset, length)),
    writeFile: (path, data) => on(path, (files, at) => files.writeFile(at, data)),
    writeFileWithReport: async (path, data) => {
      await on(path, (files, at) => files.writeFile(at, data));

      return null;
    },
    readdir: (path) => on(path, (files, at) => files.readdir(at)),
    stat: (path, options) => on(path, (files, at) => files.stat(at, options)),
    mkdir: (path, opts) => on(path, (files, at) => files.mkdir(at, opts)),
    unlink: (path) => settle(Effect.flatMap(removable(path, 'unlink'), (at) => Effect.promise(async () => at.files.unlink(at.path)))),
    removeRecursive: (path) => settle(Effect.flatMap(removable(path, 'rm'), (at) => Effect.promise(async () => at.files.removeRecursive(at.path)))),
    rename: (from, to) => settle(Effect.flatMap(Effect.all([removable(from, 'rename'), removable(to, 'rename')]), ([a, b]) => {
      const viewed = [a, b].some((at) => at.files === own && own.mountOf(at.path) !== null);

      return Effect.promise(async () => (viewed ? own.rename(a.files === own ? a.path : from, b.files === own ? b.path : to) : machine.rename(paths.real(from), paths.real(to))));
    })),
  };
}

/** The folder and the own space are the agent's; past them, the user is asked. A link in either is judged by where it points. */
export function localFileReach(input: Pick<LocalFilePlane, 'folder' | 'space' | 'views'>, planes: PathPlanes): FileReach {
  const paths = localPaths(input.folder, input.space, input.views.map((view) => view.name));

  return {
    planes,
    userRoots: () => [],
    locate: (path, op) => {
      // A removal acts on the entry itself, so its own name is not followed.
      const hostPath = op === 'delete' ? join(landing(dirname(paths.real(path))), basename(paths.real(path))) : landing(paths.real(path));

      return { hostPath, outside: ![input.folder, input.space].some((root) => withinRoot(landing(root), hostPath)) };
    },
    parksWrites: false,
  };
}

/** Where `path` lands on this machine: its links followed, as node:fs follows them, and what is not there yet as named. */
function landing(path: string): string {
  const real = tolerate(() => realpathSync(path), 'enoent');

  if (real !== undefined) return real;

  // A dangling link is written where it points; anything else missing lands under its nearest existing parent.
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) return landing(resolve(dirname(path), readlinkSync(path)));

  return dirname(path) === path ? path : join(landing(dirname(path)), basename(path));
}

function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);

  if (distance === '') return true;

  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
