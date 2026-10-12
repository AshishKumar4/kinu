import { normalizePath } from '@nimbus-sh/core/vfs/composite.js';

/** The canonical home directory for workspace-relative paths. */
export const WORKSPACE_ROOT = '/home/main';

/** Every agent's. */
export const SLATES_ROOT = '/slates';

/** Platform state, not anyone's work: Nimbus runtimes, bindings and images; Kinu agent state. */
const SYSTEM_MANAGED_DIRECTORIES: ReadonlySet<string> = new Set(['.nimbus', '.kinu']);

export function isSystemManaged(name: string): boolean {
  return SYSTEM_MANAGED_DIRECTORIES.has(name);
}

/** Relative, with no empty, `.` or `..` segment. */
export function isTreeRelativePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * As a process in `cwd` names it, from `/`, spelled as written: every `.` and `..` is left to the namespace's walk,
 * which takes `..` after a link, as open(2) does. An empty path is `cwd`. What a file operation is handed.
 */
export function walkedPath(path: string, cwd: string): string {
  if (path === '') return cwd;

  return path.startsWith('/') ? path : `${cwd === '/' ? '' : cwd}/${path}`;
}

/**
 * {@link walkedPath} collapsed by its spelling: a key or a name, never a path to operate on, since a link's `..` is not
 * where the walk lands. Not `resolveVfsPath`, which answers without the leading `/`.
 */
export function workspacePath(path: string, cwd: string): string {
  return normalizePath(walkedPath(path, cwd));
}
