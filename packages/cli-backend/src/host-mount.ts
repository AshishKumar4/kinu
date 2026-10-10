import type { VFS, VfsDirentType } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The host filesystem as a file plane, via node:fs. Writes snapshot into the
 * bound shell's shadow-git checkpoints, so /undo covers them.
 */

import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Effect } from 'effect';
import type { CheckpointFiles, FileCheckpoints, FileReach, MountedVfs, PathPlanes, VfsDigestWrite, VfsMount, WriteObserver } from '@kinu.run/core';
import { agentHome, FOLDER_SUBTREE, MAIN_AGENT, sha256Hex, withMountTable, workspacePath } from '@kinu.run/core';
import { CompositeVFS } from '@nimbus-sh/core/vfs/composite.js';
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

type HostFiles = VFS & Required<Pick<VFS, 'readRange' | 'rmdir' | 'rename' | 'readlink'>> & Required<Pick<CheckpointFiles, 'writeFileIfDigest'>>;

/**
 * Each path's compare-through-rename, one at a time in this process: every head's plane over the machine shares this
 * table, so two of them cannot both pass a compare and the later rename lose the first write. Keyed by the path's real
 * directory, so a link to it is the same file.
 */
const replacing = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(path: string, run: () => Promise<T>): Promise<T> {
  const directory = await tolerateAsync(() => fs.realpath(dirname(path)), 'enoent') ?? dirname(path);
  const key = join(directory, basename(path));
  const before = replacing.get(key);

  const mine = (async () => {
    await before;

    return run();
  })();

  // What the next one waits on: this one settled, whether it landed or failed.
  const settled = Promise.allSettled([mine]);

  replacing.set(key, settled);

  try {
    return await mine;
  } finally {
    if (replacing.get(key) === settled) replacing.delete(key);
  }
}

/**
 * `data` at `path` only if its bytes still hash to `expected` (null: only if none is there), replaced through a temp file
 * and a rename. The compare and the rename run back to back in this process; this host gives no lock against another
 * process's write in that instant, and a reader never sees half a file.
 */
function replaceIfDigest(path: string, data: Uint8Array, expected: string | null): Promise<VfsDigestWrite> {
  return oneAtATime(path, () => replaceNow(path, data, expected));
}

async function replaceNow(path: string, data: Uint8Array, expected: string | null): Promise<VfsDigestWrite> {
  const held = await tolerateAsync(() => fs.readFile(path), 'enoent');
  const found = held === undefined ? null : sha256Hex(held);

  if (found !== expected) return { ok: false, sha256: found };
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.kinu-write`);

  try {
    await fs.writeFile(temporary, data);

    // A replaced file keeps its mode whole: a creation mode is cut by the umask, so it is set after.
    if (held !== undefined) await fs.chmod(temporary, (await fs.stat(path)).mode & 0o7777);
    await fs.rename(temporary, path);
  } finally {
    // Renamed, it is gone already; a failed write or rename leaves none behind.
    await fs.rm(temporary, { force: true });
  }

  return { ok: true, sha256: sha256Hex(data) };
}

async function hostIo<T>(syscall: string, path: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) { throwVfsError({ error, syscall, path }); }
}

function createHostMountVFS(root: string, checkpoints: FileCheckpoints | undefined): HostFiles {
  const snapshot = async (path: string, reason: string): Promise<void> => {
    if (!checkpoints) return;
    const workdir = checkpoints.workdirForPath(path);
    await checkpoints.ensureCheckpoint(withinRoot(root, workdir) ? workdir : root, reason);
  };

  return {
    readFile: (path) => hostIo('open', path, async () => new Uint8Array(await fs.readFile(path))),
    async writeFile(path, data) {
      await snapshot(path, 'file write');
      await hostIo('open', path, async () => {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, data);
      });
    },
    async writeFileIfDigest(path, data, expected) {
      await snapshot(path, 'file write');

      return await hostIo('open', path, () => replaceIfDigest(path, data, expected));
    },
    readdir: (path) => hostIo('scandir', path, async () => (await fs.readdir(path, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, type: hostDirentType(entry) }))),
    stat: (path, options) => hostIo(options?.follow === false ? 'lstat' : 'stat', path, async () => {
      const stat = await tolerateAsync(() => options?.follow === false ? fs.lstat(path) : fs.stat(path), 'enoent');

      if (stat === undefined) return null;
      const type = stat.isSymbolicLink() ? 'symlink' as const : 'file' as const;
      // A FIFO, socket or device says what it is in its mode's format bits, as Nimbus reads a device's.
      const special = stat.isFile() || stat.isDirectory() || stat.isSymbolicLink() ? {} : { mode: stat.mode };

      return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, type: stat.isDirectory() ? 'directory' : type, ...special };
    }),
    async unlink(path) {
      await snapshot(path, 'file delete');
      await hostIo('unlink', path, () => fs.unlink(path));
    },
    async rmdir(path) {
      await snapshot(path, 'file delete');
      await hostIo('rmdir', path, () => fs.rmdir(path));
    },
    async rename(from, to) {
      await snapshot(from, 'file move');
      await snapshot(to, 'file move');
      await hostIo('rename', from, () => fs.rename(from, to));
    },
    readlink: (path) => hostIo('readlink', path, () => fs.readlink(path)),
    mkdir: (path, opts) => hostIo('mkdir', path, async () => { await fs.mkdir(path, { recursive: opts?.recursive ?? false }); }),
    readRange: (path, offset, length) => hostIo('read', path, async () => {
      const handle = await fs.open(path, 'r');

      try {
        const out = new Uint8Array(length);
        const { bytesRead } = await handle.read(out, 0, length, offset);

        return out.subarray(0, bytesRead);
      } finally { await handle.close(); }
    }),
  };
}

/** Real files under `root`, named from `/`. */
function rootedFiles(root: string, files: HostFiles): HostFiles {
  const at = (path: string): string => join(root, workspacePath(path, '/'));

  return {
    readFile: (path) => files.readFile(at(path)),
    writeFile: (path, data) => files.writeFile(at(path), data),
    writeFileIfDigest: (path, data, expected) => files.writeFileIfDigest(at(path), data, expected),
    readdir: (path) => files.readdir(at(path)),
    stat: (path, options) => files.stat(at(path), options),
    unlink: (path) => files.unlink(at(path)),
    rmdir: (path) => files.rmdir(at(path)),
    rename: (from, to) => files.rename(at(from), at(to)),
    readlink: (path) => files.readlink(at(path)),
    mkdir: (path, opts) => files.mkdir(at(path), opts),
    readRange: (path, offset, length) => files.readRange(at(path), offset, length),
  };
}

/** An agent's home in the space as real files; a relative path is the home's. */
export function agentHomeFiles(space: string, agent: string): HostFiles {
  const home = join(space, agentHome(agent));

  return rootedFiles(home, createHostMountVFS(home, undefined));
}

/** The space named from its root, as `vfs://` names it. */
export function spaceFiles(space: string): HostFiles {
  return rootedFiles(space, createHostMountVFS(space, undefined));
}

/** `<space>/local` links the folder, as `vfs://local` names it. */
const FOLDER_LINK = FOLDER_SUBTREE.slice(1);

function linkFolder(space: string, folder: string): void {
  const at = join(space, FOLDER_LINK);
  const entry = lstatSync(at, { throwIfNoEntry: false });

  // Anything but a link there is someone's own.
  if (entry !== undefined && (!entry.isSymbolicLink() || readlinkSync(at) === folder)) return;
  mkdirSync(space, { recursive: true });
  rmSync(at, { force: true });
  symlinkSync(folder, at);
}

/** Read-only to the file tool: the memory tool and the loop's writer change them. */
const READ_ONLY_STATE = ['memory', 'scaffold', '.kinu/agents'];

export interface LocalFilePlane {
  readonly folder: string;
  readonly space: string;
  readonly views: readonly VfsMount[];
  readonly checkpoints: FileCheckpoints | undefined;
  /** Hears a write that lands on the host past the namespace (a digest-checked one); the namespace's own it hears itself. */
  readonly observer?: WriteObserver;
}

/** `composite`, not `namespace`: `withMountTable` reads a `namespace` member as the opener of a mounted namespace. */
export type LocalPlane = MountedVfs & { readonly composite: CompositeVFS };

/** The machine's files as its shell names them; only the folder is snapshotted. */
export function localFilePlane(input: LocalFilePlane): LocalPlane {
  linkFolder(input.space, input.folder);
  // The host's own links are the namespace's to follow, as the kernel's are, so no link reaches past a mount's rule.
  const namespace = new CompositeVFS(createHostMountVFS(input.folder, input.checkpoints));
  namespace.mount(input.space, spaceFiles(input.space));

  for (const dir of READ_ONLY_STATE) {
    const at = join(input.space, agentHome(MAIN_AGENT), dir);
    // A mount point is a directory, and the home above it one the space holds, so a path through it is the space's.
    mkdirSync(at, { recursive: true });
    namespace.mount(at, rootedFiles(at, createHostMountVFS(at, undefined)), { readOnly: true });
  }

  const views = input.views.map((view) => ({ ...view, at: join(input.space, view.name) }));

  for (const view of views) {
    namespace.mount(view.at, () => view.files(), {
      resolvesPaths: true, absentReason: () => view.absentReason(), ...(view.readOnly === true && { readOnly: true }),
    });
  }

  const files = withMountTable({
    namespace: async () => namespace, home: input.folder, writesParents: true, ...(input.observer !== undefined && { observer: input.observer }),
  }, views);

  const removable = (path: string, syscall: string): Effect.Effect<string, VfsError> => (workspacePath(path, input.folder) === input.folder
    ? Effect.fail(syscallError('EACCES', syscall, path, { detail: 'the workspace\'s folder cannot be removed' }))
    : Effect.succeed(path));

  return {
    ...files,
    composite: namespace,
    unlink: (path) => settle(Effect.flatMap(removable(path, 'unlink'), (at) => Effect.promise(async () => files.unlink(at)))),
    removeRecursive: (path) => settle(Effect.flatMap(removable(path, 'rm'), (at) => Effect.promise(async () => files.removeRecursive(at)))),
    rename: (from, to) => settle(Effect.flatMap(Effect.all([removable(from, 'rename'), removable(to, 'rename')]), ([a, b]) => Effect.promise(async () => files.rename(a, b)))),
  };
}

/**
 * The folder and the own space are the agent's; past them, the user is asked. The gate hands over the path the
 * namespace resolved, its links followed as node:fs follows them; a root is matched as named and as its real path,
 * since a mount point (the space) keeps its name while the folder's links resolve.
 */
export function localFileReach(input: Pick<LocalFilePlane, 'folder' | 'space'>, planes: PathPlanes, plane: Pick<LocalPlane, 'resolve'>): FileReach {
  const roots = [input.folder, input.space].flatMap((root) => [root, tolerate(() => realpathSync(root), 'enoent') ?? root]);

  return {
    planes,
    resolve: (path, follow) => plane.resolve(path, { follow }),
    userRoots: () => [],
    locate: (path) => ({ hostPath: path, outside: !roots.some((root) => withinRoot(root, path)) }),
    parksWrites: false,
  };
}

function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);

  if (distance === '') return true;

  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
