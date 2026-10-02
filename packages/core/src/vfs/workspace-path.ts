import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';

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

/** Home/slate paths are bounded; other absolute namespaces keep their own `..` rule. */
export function workspacePath(path: string): string {
  const segments = (path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`).split('/');
  let root: string | undefined;
  let boundary = 0;
  let kept = 0;

  // Compact left: no raw segment ahead of this cursor is rewritten.
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;

    if (root !== undefined && segment === '..') {
      if (kept === boundary) return settleSync(Effect.fail(new VfsError('EACCES', `path escapes ${root}`, path)));

      kept--;
      continue;
    }

    segments[kept++] = segment;

    if (root === undefined && kept <= 2) {
      const prefix = kept === 1 ? `/${segment}` : `/${segments[0]}/${segment}`;

      if (prefix === WORKSPACE_ROOT || prefix === NIMBUS_WORKSPACE_ROOT || prefix === SLATES_ROOT) {
        root = prefix;
        boundary = kept;
      }
    }
  }

  segments.length = kept;

  const canonical = `/${segments.join('/')}`;

  return root === NIMBUS_WORKSPACE_ROOT && kept > boundary ? `${WORKSPACE_ROOT}${canonical.slice(root.length)}` : canonical;
}

/** Scopes follow the bare link; file operations keep its name. */
export function workspaceScopePath(path: string): string {
  const canonical = workspacePath(path);

  return canonical === NIMBUS_WORKSPACE_ROOT ? WORKSPACE_ROOT : canonical;
}
