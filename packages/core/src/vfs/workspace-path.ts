import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';

/** The canonical home directory for workspace-relative paths. */
export const WORKSPACE_ROOT = '/home/main';

/** Nimbus 0.13.1 PATH/XDG/passwd still use this (2026-10-01). Delete when they derive from HOME. */
export const NIMBUS_WORKSPACE_ROOT = '/home/user';

/** Every agent's. */
export const SLATES_ROOT = '/slates';

/** Platform state, not anyone's work: Nimbus runtimes, bindings and images; Kinu agent state. */
const SYSTEM_MANAGED_DIRECTORIES: ReadonlySet<string> = new Set(['.nimbus', '.kinu']);

export function isSystemManaged(name: string): boolean {
  return SYSTEM_MANAGED_DIRECTORIES.has(name);
}

const PATH_ROOTS: readonly string[] = [WORKSPACE_ROOT, NIMBUS_WORKSPACE_ROOT, SLATES_ROOT];

/** Home/slate paths are bounded; other absolute namespaces keep their own `..` rule. */
export function workspacePath(path: string): string {
  const absolute = (path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`)
    .replace(/\/+/g, '/').replace(/\/\.(?=\/|$)/g, '').replace(/\/$/, '') || '/';

  const root = PATH_ROOTS.find((candidate) => absolute === candidate || absolute.startsWith(`${candidate}/`));

  if (root === undefined) return absolute;

  let depth = 0;

  for (const segment of absolute.slice(root.length + 1).split('/')) {
    if (segment === '' || segment === '.') continue;

    if (segment === '..') {
      if (depth === 0) return settleSync(Effect.fail(new VfsError('EACCES', `path escapes ${root}`, path)));

      depth--;
    } else depth++;
  }

  const canonical = `/${normalizeVfsPath(absolute)}`;

  return root === NIMBUS_WORKSPACE_ROOT ? `${WORKSPACE_ROOT}${canonical.slice(root.length)}` : canonical;
}
