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

/** As a process in `cwd` names it. Not `resolveVfsPath`: it keeps a leading `..` (NIMBUS-ASKS). */
export function workspacePath(path: string, cwd: string): string {
  return normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`);
}
