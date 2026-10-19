/**
 * A local workspace's files in the archive's one tree format, the store pages a cloud workspace writes: the own space
 * at the root and the folder under `local/`, as `vfs://` names them. Export stages the disk into a scratch store and
 * pages it; import publishes the restored store back to disk. Modes, times and symbolic links travel both ways.
 */
import { Database } from 'bun:sqlite';
import {
  chmodSync, cpSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { Effect } from 'effect';
import {
  FOLDER_SUBTREE, SESSION_UID, SHARED_ROOTS, workspaceArchiveStore, type ArchiveStoreSource, type WorkspaceBundle,
} from '@kinu.run/core';
import { createInlineWorkspace } from '@kinu.run/core/identity';
import { removeWhole } from '@kinu.run/core';
import { KinuError, settle, settleSync } from '@kinu.run/core/obs';

/** The own space's trees an archive carries (`identity/archive.ts`'s carried roots); the rest is never staged. */
const SPACE_TREES: readonly string[] = ['home', ...SHARED_ROOTS.map((root) => root.slice(1))];

/** The kernel: no file's mode hides it from the copy, and the copy can set any owner. */
type Kernel = ReturnType<SqliteVFS['as']>;

export interface LocalArchiveRoots {
  /** The database's directory. */
  readonly space: string;
  readonly folder: string;
}

export interface StagedLocalArchive {
  readonly store: ArchiveStoreSource;
  /** Deletes the scratch store. */
  close(): void;
}

/** `skip`: the archive being written. The roots are staged whole before the first page, so the export reads one instant. */
export async function stageLocalArchive(roots: LocalArchiveRoots, skip: string): Promise<StagedLocalArchive> {
  const scratch = mkdtempSync(join(tmpdir(), 'kinu-export-'));
  const db = new Database(join(scratch, 'store.db'), { create: true });

  const close = (): void => {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  };

  return settle(Effect.catchCause(Effect.gen(function* () {
    const bundle: WorkspaceBundle = createInlineWorkspace(db);
    const kernel = (yield* Effect.promise(() => bundle.session())).vfs.as(CRED_KERNEL);

    // The scratch store's own bootstrap is not this workspace's.
    for (const tree of SPACE_TREES) {
      if (kernel.statIfPresent(`/${tree}`, false) !== null) removeWhole(kernel, `/${tree}`);
    }

    for (const tree of SPACE_TREES) {
      if (existsSync(join(roots.space, tree))) yield* stage(kernel, join(roots.space, tree), `/${tree}`, skip);
    }

    if (existsSync(roots.folder)) yield* stage(kernel, roots.folder, FOLDER_SUBTREE, skip);

    return { store: workspaceArchiveStore(bundle), close };
  }), (failed) => Effect.sync(close).pipe(Effect.andThen(Effect.failCause(failed)))));
}

/** One disk entry and everything under it, owned by the session user; a directory's times are set once it is full. */
function stage(kernel: Kernel, disk: string, path: string, skip: string): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const stat = lstatSync(disk);
    const mode = stat.mode & 0o7777;

    if (stat.isDirectory()) {
      kernel.mkdir(path, { recursive: true, mode });

      for (const name of readdirSync(disk).sort()) {
        if (join(disk, name) !== skip) yield* stage(kernel, join(disk, name), `${path}/${name}`, skip);
      }
    } else if (stat.isFile()) {
      kernel.writeFile(path, readFileSync(disk), { mode });
    } else if (stat.isSymbolicLink()) {
      kernel.symlink(readlinkSync(disk), path);
    } else {
      return yield* new KinuError('unsupported', `A workspace archive keeps files, directories and links; ${disk} is none of them.`);
    }

    if (!stat.isSymbolicLink()) kernel.chmod(path, mode);
    kernel.chown(path, SESSION_UID, SESSION_UID, { followSymlinks: false });
    kernel.utimes(path, stat.atimeMs, stat.mtimeMs, { followSymlinks: false });
  });
}

/**
 * Moves a restored store's trees to disk: `/home` and `/slates` into the own space, `/local` into `folder`, each entry with
 * its mode, times and links; the store keeps none of them, since locally every file is a real one.
 */
export function publishStoreFiles(bundle: WorkspaceBundle, roots: LocalArchiveRoots): Promise<void> {
  return settle(Effect.gen(function* () {
    const kernel = (yield* Effect.promise(() => bundle.session())).vfs.as(CRED_KERNEL);

    const trees: ReadonlyArray<readonly [string, string]> = [
      ...SPACE_TREES.map((tree) => [`/${tree}`, join(roots.space, tree)] as const), [FOLDER_SUBTREE, roots.folder],
    ];

    // The archive's own roots, so no page lands beside the database.
    for (const [path, disk] of trees) {
      if (kernel.statIfPresent(path, false) === null) continue;
      publish(kernel, path, disk);
      removeWhole(kernel, path);
    }
  }));
}

function publish(kernel: Kernel, path: string, disk: string): void {
  const stat = kernel.lstat(path);

  if (stat.type === 'directory') {
    mkdirSync(disk, { recursive: true });

    for (const entry of kernel.readdir(path)) publish(kernel, `${path}/${entry.name}`, join(disk, entry.name));
    chmodSync(disk, stat.mode & 0o7777);
    utimesSync(disk, stat.atime / 1000, stat.mtime / 1000);
  } else if (stat.type === 'symlink') {
    symlinkSync(kernel.readlink(path), disk);
    lutimesSync(disk, stat.atime / 1000, stat.mtime / 1000);
  } else {
    writeFileSync(disk, kernel.readFile(path), { mode: stat.mode & 0o7777 });
    chmodSync(disk, stat.mode & 0o7777);
    utimesSync(disk, stat.atime / 1000, stat.mtime / 1000);
  }
}

/** Restored files join the folder; one it already holds with other bytes refuses the move before anything is written. */
export function moveIntoFolder(from: string, folder: string): void {
  return settleSync(Effect.gen(function* () {
    // A cloud archive restores no folder.
    if (!existsSync(from)) return;
    const clashes = clashing(from, folder, '');

    if (clashes.length > 0) {
      return yield* new KinuError('denied', `${folder} already holds ${clashes.join(', ')} with other contents; restore into a folder without them.`);
    }

    cpSync(from, folder, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }));
}

function clashing(from: string, folder: string, path: string): string[] {
  return readdirSync(join(from, path), { withFileTypes: true }).flatMap((entry) => {
    const named = path === '' ? entry.name : `${path}/${entry.name}`;
    const there = lstatSync(join(folder, named), { throwIfNoEntry: false });

    if (entry.isDirectory()) return there === undefined || there.isDirectory() ? clashing(from, folder, named) : [named];

    if (entry.isSymbolicLink()) {
      return there !== undefined && (!there.isSymbolicLink() || readlinkSync(join(folder, named)) !== readlinkSync(join(from, named))) ? [named] : [];
    }

    return there !== undefined && (!there.isFile() || !readFileSync(join(folder, named)).equals(readFileSync(join(from, named)))) ? [named] : [];
  });
}
