import type { Awaitable, VFS, VfsDirent } from '@nimbus-sh/core/vfs/vfs.js';
/** `/agent`: the agent's memory, SOUL.md and scaffold, read-only, where the file plane is a directory. */

import { Effect } from 'effect';

import type { VfsMount } from './mounts';
import { isVfsError, syscallError, type VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { settle } from '../obs/effect';
import { toKinuError, type KinuError } from '../obs/error';
import { MEMORY_PATH } from '../memory/note';
import { SOUL_PATH } from '../identity/soul';
import { actorStateRoot } from '../identity/workspace-actors';
import { WORKSPACE_ROOT } from './workspace-path';

const AGENT_VIEW = '/agent';

const MEMORY_DIR = MEMORY_PATH.slice(0, MEMORY_PATH.indexOf('/'));

/**
 * The workspace tree's agent state: what an agent view shows, for the root and every hire (whose scaffolds sit under
 * their state roots). A local workspace keeps it in its database; the rest of its tree is files on disk.
 */
export const AGENT_STATE_PATHS: readonly string[] = [MEMORY_DIR, SOUL_PATH, 'scaffold', actorStateRoot('').replace(/\/$/u, '')]
  .map((name) => `${WORKSPACE_ROOT}/${name}`);

export function isAgentStatePath(path: string): boolean {
  const absolute = `/${path.replace(/^\/+/u, '')}`;

  return AGENT_STATE_PATHS.some((root) => absolute === root || absolute.startsWith(`${root}/`));
}

export function agentViewMount(state: VFS, scaffoldDir: string): VfsMount {
  const roots = new Map([[MEMORY_DIR, MEMORY_DIR], [SOUL_PATH, SOUL_PATH], ['scaffold', scaffoldDir]]);

  /** null: the view's root; undefined: a name it does not show. */
  const sourceOf = (path: string): string | null | undefined => {
    const [name, ...rest] = path.split('/').filter((segment) => segment !== '');

    if (name === undefined) return null;
    const root = roots.get(name);

    return root === undefined || rest.length === 0 ? root : `${root}/${rest.join('/')}`;
  };

  const shown = (path: string, syscall: string): Effect.Effect<string | null, VfsError> => {
    const source = sourceOf(path);

    return source === undefined
      ? Effect.fail(syscallError('ENOENT', syscall, `${AGENT_VIEW}${path}`))
      : Effect.succeed(source);
  };

  const fromState = <A>(doing: string, run: () => Awaitable<A>): Effect.Effect<A, KinuError | VfsError> => Effect.tryPromise({
    try: async () => run(),
    catch: (cause) => (isVfsError(cause)
      ? cause
      : toKinuError({ doing, cause, otherwise: 'io' })),
  });

  const readOnly = (path: string, syscall: string): Effect.Effect<never, VfsError> => Effect.fail(syscallError('EROFS', syscall, `${AGENT_VIEW}${path}`, {
    detail: `${AGENT_VIEW} is a read-only view: memory changes through the memory tool, SOUL.md through the owner, `
      + 'the scaffold through self-modification',
  }));

  const present = async (): Promise<VfsDirent[]> => {
    const entries: VfsDirent[] = [];

    for (const [name, root] of roots) {
      const stat = await state.stat(root, { follow: false });

      if (stat !== null) entries.push({ name, type: stat.type, stat });
    }

    return entries;
  };

  const files: VFS = {
    readFile: (path) => settle(Effect.flatMap(shown(path, 'open'), (source) => (source === null
      ? Effect.fail(syscallError('EISDIR', 'read', AGENT_VIEW))
      : fromState(`reading ${AGENT_VIEW}${path}`, () => state.readFile(source))))),
    readdir: (path) => settle(Effect.flatMap(shown(path, 'scandir'), (source) =>
      fromState(`listing ${AGENT_VIEW}${path}`, () => (source === null ? present() : state.readdir(source))))),
    async stat(path, options) {
      const source = sourceOf(path);

      if (source === undefined) return null;

      return source === null ? { size: 0, mtimeMs: 0, type: 'directory' } : state.stat(source, options);
    },
    writeFile: (path) => settle(readOnly(path, 'open')),
    unlink: (path) => settle(readOnly(path, 'unlink')),
    mkdir: (path) => settle(readOnly(path, 'mkdir')),
  };

  return {
    name: AGENT_VIEW.slice(1), files: () => files, absentReason: () => 'the agent view is always mounted', filesOwner: 'agent', readOnly: true,
    storeView: true,
  };
}
