/** The canonical home directory for workspace-relative paths. */
export const WORKSPACE_ROOT = '/home/main';

export const LEGACY_WORKSPACE_ROOT = '/home/user';

/** Resolve a path the way a workspace process starting in {@link WORKSPACE_ROOT} would. */
export function workspacePath(path: string): string {
  if (path.startsWith('/')) return path;
  const clean = path.replace(/^\.\//, '');

  return clean === '' || clean === '.' ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${clean}`;
}

export function canonicalWorkspacePath(path: string): string {
  if (path === LEGACY_WORKSPACE_ROOT) return WORKSPACE_ROOT;

  return path.startsWith(`${LEGACY_WORKSPACE_ROOT}/`)
    ? `${WORKSPACE_ROOT}${path.slice(LEGACY_WORKSPACE_ROOT.length)}`
    : path;
}
