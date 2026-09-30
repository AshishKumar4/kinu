/** `/agent`: the agent's memory, SOUL.md and scaffold, read-only, where the file plane is a directory. */

import { Effect } from 'effect';
import type { VFS } from '../types/primitives';
import type { VfsMount } from './mounts';
import { isVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { settle } from '../obs/effect';
import { toKinuError, type KinuError } from '../obs/error';
import { MEMORY_PATH } from '../memory/note';
import { SOUL_PATH } from '../identity/soul';

const AGENT_VIEW = '/agent';

const MEMORY_DIR = MEMORY_PATH.slice(0, MEMORY_PATH.indexOf('/'));

export function agentViewMount(state: VFS, scaffoldDir: string): VfsMount {
  const roots = new Map([[MEMORY_DIR, MEMORY_DIR], [SOUL_PATH, SOUL_PATH], ['scaffold', scaffoldDir]]);

  /** null: the view's root; undefined: a name it does not show. */
  const sourceOf = (path: string): string | null | undefined => {
    const [name, ...rest] = path.split('/').filter((segment) => segment !== '');

    if (name === undefined) return null;
    const root = roots.get(name);

    return root === undefined || rest.length === 0 ? root : `${root}/${rest.join('/')}`;
  };

  const shown = (path: string): Effect.Effect<string | null, VfsError> => {
    const source = sourceOf(path);

    return source === undefined
      ? Effect.fail(new VfsError('ENOENT', 'no such file or directory', `${AGENT_VIEW}${path}`))
      : Effect.succeed(source);
  };

  const fromState = <A>(doing: string, run: () => Promise<A>): Effect.Effect<A, KinuError | VfsError> => Effect.tryPromise({
    try: run,
    catch: (cause) => (isVfsError(cause)
      ? cause
      : toKinuError({ doing, cause, otherwise: 'io' })),
  });

  const readOnly = (path: string): Effect.Effect<never, VfsError> => Effect.fail(new VfsError('EROFS',
  `${AGENT_VIEW} is a read-only view: memory changes through the memory tool, SOUL.md through the owner, `
    + 'the scaffold through self-modification',
  `${AGENT_VIEW}${path}`,));

  const present = async (): Promise<string[]> => {
    const names: string[] = [];

    for (const [name, root] of roots) if (await state.exists(root)) names.push(name);

    return names;
  };

  const files: VFS = {
    readFile: (path, opts) => settle(Effect.flatMap(shown(path), (source) => (source === null
      ? Effect.fail(new VfsError('EISDIR', 'illegal operation on a directory, read', AGENT_VIEW))
      : fromState(`reading ${AGENT_VIEW}${path}`, () => state.readFile(source, opts))))),
    readdir: (path) => settle(Effect.flatMap(shown(path), (source) =>
      fromState(`listing ${AGENT_VIEW}${path}`, () => (source === null ? present() : state.readdir(source))))),
    async stat(path) {
      const source = sourceOf(path);

      if (source === undefined) return null;

      return source === null ? { size: 0, mtimeMs: 0, isDir: true } : state.stat(source);
    },
    async exists(path) {
      const source = sourceOf(path);

      return source !== undefined && (source === null || state.exists(source));
    },
    writeFile: (path) => settle(readOnly(path)),
    unlink: (path) => settle(readOnly(path)),
    mkdir: (path) => settle(readOnly(path)),
  };

  return {
    name: AGENT_VIEW.slice(1), files: () => files, absentReason: () => 'the agent view is always mounted', filesOwner: 'agent', readOnly: true,
    storeView: true,
  };
}
