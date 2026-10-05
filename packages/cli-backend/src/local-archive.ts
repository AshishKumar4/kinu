/** A local workspace's files as one archive tree, as `vfs://` names them: the own space at the root, the folder under `local/`. */
import type { Dirent } from 'node:fs';
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { Effect } from 'effect';
import {
  AGENT_STATE_PATHS, SLATES_ROOT, archiveFileTree, isAgentStatePath,
  type ArchiveFileEntry, type ArchiveFileSource, type ArchiveFileTarget,
} from '@kinu.run/core';
import { KinuError, settle, settleSync } from '@kinu.run/core/obs';

const FOLDER = 'local';

/** Its sidecars (`-wal`, `-shm`) start with it. */
const DATABASE = 'agent.db';

export interface LocalArchiveRoots {
  /** The database's directory. */
  readonly space: string;
  readonly folder: string;
}

function entryType(entry: Dirent): string {
  if (entry.isDirectory()) return 'directory';

  if (entry.isFile()) return 'file';

  return entry.isSymbolicLink() ? 'symlink' : 'special';
}

/** `skip`: the archive being written. */
export function localArchiveSource(roots: LocalArchiveRoots, skip: string): ArchiveFileSource {
  const tree = (root: string, kept: (name: string, at: string) => boolean): ArchiveFileSource => archiveFileTree({
    readdir: async (path) => (await fs.readdir(join(root, path), { withFileTypes: true }))
      .filter((entry) => join(root, path, entry.name) !== skip && kept(entry.name, path))
      .map((entry) => ({ name: entry.name, type: entryType(entry) })),
    readFile: (path) => fs.readFile(join(root, path)),
  });

  const own = tree(roots.space, (name, at) => at !== '' || (name !== FOLDER && !name.startsWith(DATABASE)));
  const folder = tree(roots.folder, () => true);

  return {
    listEntries: async (): Promise<ArchiveFileEntry[]> => [
      ...await own.listEntries(),
      { path: FOLDER, type: 'directory' },
      ...(await folder.listEntries()).map((entry) => ({ path: `${FOLDER}/${entry.path}`, type: entry.type })),
    ],
    readFile: (path) => (path.startsWith(`${FOLDER}/`) ? folder.readFile(path.slice(FOLDER.length + 1)) : own.readFile(path)),
  };
}

export function localArchiveTarget(roots: LocalArchiveRoots): ArchiveFileTarget {
  const at = (path: string): Effect.Effect<string, KinuError> => {
    const [first = '', ...rest] = path.split('/');

    if (first.startsWith(DATABASE)) return Effect.fail(new KinuError('bad_input', `This archive names the workspace database (${path}) as one of its files.`));

    return Effect.succeed(first === FOLDER ? join(roots.folder, ...rest) : join(roots.space, path));
  };

  return {
    writeFile: (path, data) => settle(Effect.flatMap(at(path), (target) => Effect.promise(() => fs.writeFile(target, data)))),
    mkdir: (path, opts) => settle(Effect.flatMap(at(path), (target) => Effect.promise(async () => {
      await fs.mkdir(target, { recursive: opts?.recursive ?? false });
    }))),
  };
}

/** Moves a restored store's files to `target`, except agent state, which stays. */
export function publishStoreFiles(store: VFS & Required<Pick<VFS, 'removeRecursive'>>, target: ArchiveFileTarget): Promise<void> {
  const holdsState = (path: string): boolean => AGENT_STATE_PATHS.some((root) => root.startsWith(`${path}/`));

  const move = (path: string): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    for (const entry of yield* Effect.promise(async () => store.readdir(path))) {
      const child = `${path}/${entry.name}`;

      if (isAgentStatePath(child)) continue;

      if (entry.type === 'file') {
        const data = yield* Effect.promise(async () => store.readFile(child));
        yield* Effect.promise(() => target.writeFile(child.slice(1), data));
        yield* Effect.promise(async () => store.unlink(child));
      } else if (entry.type === 'directory') {
        yield* Effect.promise(() => target.mkdir(child.slice(1), { recursive: true }));
        yield* move(child);

        if (!holdsState(child)) yield* Effect.promise(async () => store.removeRecursive(child));
      } else {
        return yield* new KinuError('unsupported', `A local workspace keeps files and directories; this archive's ${child} is a ${entry.type}.`);
      }
    }
  });

  return settle(Effect.forEach(['/home', SLATES_ROOT], (root) => Effect.flatMap(
    Effect.promise(async () => store.stat(root)),
    (stat) => (stat === null ? Effect.void : move(root)),
  ), { discard: true }));
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

    cpSync(from, folder, { recursive: true, force: true });
    rmSync(from, { recursive: true, force: true });
  }));
}

function clashing(from: string, folder: string, path: string): string[] {
  return readdirSync(join(from, path), { withFileTypes: true }).flatMap((entry) => {
    const named = path === '' ? entry.name : `${path}/${entry.name}`;
    const there = lstatSync(join(folder, named), { throwIfNoEntry: false });

    if (entry.isDirectory()) return there === undefined || there.isDirectory() ? clashing(from, folder, named) : [named];

    return there !== undefined && (!there.isFile() || !readFileSync(join(folder, named)).equals(readFileSync(join(from, named)))) ? [named] : [];
  });
}
