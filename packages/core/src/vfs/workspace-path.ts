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

function boundedRoot(segments: readonly string[], length: number): string | undefined {
  if (length > 2) return undefined;

  const prefix = length === 1 ? `/${segments[0]}` : `/${segments[0]}/${segments[1]}`;

  return prefix === WORKSPACE_ROOT || prefix === NIMBUS_WORKSPACE_ROOT || prefix === SLATES_ROOT ? prefix : undefined;
}

export function workspacePath(path: string): string {
  const segments = (path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`).split('/');
  let root: string | undefined;
  let boundary = 0;
  let kept = 0;
  let parentsBeforeRoot = false;

  // Compact only segments already read.
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;

    if (root !== undefined && segment === '..') {
      if (kept === boundary) return settleSync(Effect.fail(new VfsError('EACCES', `path escapes ${root}`, path)));

      kept--;
      continue;
    }

    if (segment === '..') parentsBeforeRoot = true;

    segments[kept++] = segment;

    if (root === undefined) {
      root = boundedRoot(segments, kept);

      if (root !== undefined) boundary = kept;
    }
  }

  segments.length = kept;

  const canonical = `/${segments.join('/')}`;

  if (parentsBeforeRoot) {
    let resolved = 0;

    for (const segment of segments) {
      if (segment === '..') {
        if (resolved > 0) resolved--;

        continue;
      }

      segments[resolved++] = segment;

      const reached = boundedRoot(segments, resolved);

      if (reached !== undefined) {
        return settleSync(Effect.fail(new VfsError('EACCES', `path reaches ${reached} through a parent segment`, path)));
      }
    }
  }

  return root === NIMBUS_WORKSPACE_ROOT && kept > boundary ? `${WORKSPACE_ROOT}${canonical.slice(root.length)}` : canonical;
}

/** Scopes follow the link; inode names do not. */
export function workspaceScopePath(path: string): string {
  const canonical = workspacePath(path);

  return canonical === NIMBUS_WORKSPACE_ROOT ? WORKSPACE_ROOT : canonical;
}
