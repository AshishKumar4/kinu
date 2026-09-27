/** `/agent`: the agent's memory, SOUL.md and scaffold, read-only, where the file plane is a directory. */

import type { VFS } from '../types/primitives';
import type { VfsMount } from './mounts';
import { makeVfsError } from './errno';
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

  const shown = (path: string): string | null => {
    const source = sourceOf(path);

    if (source === undefined) throw makeVfsError('ENOENT', `no such file or directory, '${AGENT_VIEW}${path}'`, `${AGENT_VIEW}${path}`);

    return source;
  };

  const readOnly = (path: string) => makeVfsError(
    'EROFS',
    `${AGENT_VIEW} is a read-only view: memory changes through the memory tool, SOUL.md through the owner, `
      + 'the scaffold through self-modification',
    `${AGENT_VIEW}${path}`,
  );

  const present = async (): Promise<string[]> => {
    const names: string[] = [];

    for (const [name, root] of roots) if (await state.exists(root)) names.push(name);

    return names;
  };

  const files: VFS = {
    async readFile(path, opts) {
      const source = shown(path);

      if (source === null) throw makeVfsError('EISDIR', `illegal operation on a directory, read '${AGENT_VIEW}'`, AGENT_VIEW);

      return state.readFile(source, opts);
    },
    async readdir(path) {
      const source = shown(path);

      return source === null ? present() : state.readdir(source);
    },
    async stat(path) {
      const source = sourceOf(path);

      if (source === undefined) return null;

      return source === null ? { size: 0, mtimeMs: 0, isDir: true } : state.stat(source);
    },
    async exists(path) {
      const source = sourceOf(path);

      return source !== undefined && (source === null || state.exists(source));
    },
    async writeFile(path) { throw readOnly(path); },
    async unlink(path) { throw readOnly(path); },
    async mkdir(path) { throw readOnly(path); },
  };

  return { name: AGENT_VIEW.slice(1), files: () => files, absentReason: () => 'the agent view is always mounted', filesOwner: 'agent', readOnly: true };
}
