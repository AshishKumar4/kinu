import { normalizePath } from '@nimbus-sh/core/vfs/composite.js';

/** The canonical home directory for workspace-relative paths. */
export const WORKSPACE_ROOT = '/home/main';

/** Every agent's. */
export const SLATES_ROOT = '/slates';

/** What the owner uploads in a chat, under the names it came with: every agent's. */
export const UPLOADS_ROOT = '/uploads';

/**
 * The workspace's shared roots beside the homes, every agent's: the one list a host settles as group-shared, an archive
 * carries whole, a change-set reviews and a local archive stages.
 */
export const SHARED_ROOTS: readonly string[] = [SLATES_ROOT, UPLOADS_ROOT];

/** Platform state, not anyone's work: Nimbus runtimes, bindings and images; Kinu agent state. */
const SYSTEM_MANAGED_DIRECTORIES: ReadonlySet<string> = new Set(['.nimbus', '.kinu']);

export function isSystemManaged(name: string): boolean {
  return SYSTEM_MANAGED_DIRECTORIES.has(name);
}

/** A Linux machine's own top-level directories (FHS 3.0, ch. 3, with the /lib variants); `home` is the people's. */
const MACHINE_DIRECTORIES: ReadonlySet<string> = new Set([
  'bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv',
  'sys', 'tmp', 'usr', 'var',
]);

/**
 * What a file browser hides until asked, as a desktop's does: a dotfile anywhere, and a machine's own directories at its
 * root (`atMachineRoot`), where a workspace's places sit beside them. Below a root, a project's `bin` or `tmp` is its own.
 */
export function isHiddenEntry(name: string, atMachineRoot: boolean): boolean {
  return name.startsWith('.') || (atMachineRoot && MACHINE_DIRECTORIES.has(name));
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
