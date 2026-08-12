/**
 * The emulated shell's view of the workspace file plane.
 *
 * `@proteus/agent-utils`'s POSIX shell emulator (createShell) takes that
 * package's Node-shaped VFS — the SqliteFS interface — and every backend used
 * to hand it the raw SqliteFS. That made `workspace.exec` (and `run` on its
 * default runtime) address a DIFFERENT filesystem from `workspace.readFile`,
 * `workspace.readdir` and the native `file` tool, which all address the
 * CompositeVFS: one namespace, two planes, no way to tell them apart.
 *
 * The split is total on a fork. A head's parent files arrive as the
 * `/workspace` MOUNT, so `workspace.readdir('/workspace')` lists the repo
 * while `run "ls -la /workspace"` reported ENOENT against the head's own
 * empty private scratch — and a head that believes the second one concludes
 * the repo is not there and gives up. That is a real measured failure, not a
 * hypothetical.
 *
 * This adapter closes it: the shell runs over the composite, so every mount
 * (`/local`, `/sandbox`, `/nimbus`, `/pc`, a head's `/workspace`) is
 * greppable by the same path the file tools use, and `ls /` IS the mount
 * table. Relative paths resolve against the composite cwd exactly as they do
 * for `workspace.readFile`.
 *
 * The methods the shell never calls (symlinks, chmod, lstat, rmdir) raise
 * EPERM rather than pretending — the plane has no such concepts. `mv` and
 * `rm -r` are the plane's own (CompositeVFS.rename / removeRecursive), because
 * both are decisions about which mount owns the path.
 */

import type { CompositeVFS } from './composite.js';
import type { VFS as ShellVFS, VFSStat } from '@proteus/agent-utils/vfs';
import { makeVfsError } from './errno.js';

function statView(size: number, mtimeMs: number, isDir: boolean): VFSStat {
  const mode = isDir ? 0o040755 : 0o100644;
  const mtime = new Date(mtimeMs);
  return {
    type: isDir ? 'dir' : 'file',
    mode, size, mtimeMs,
    dev: 0, ino: 0, uid: 0, gid: 0,
    ctime: mtime, mtime, ctimeMs: mtimeMs,
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
  };
}

/**
 * The agent-utils VFS the shell emulator wants, over the core VFS the rest of
 * the workspace addresses. Pass the CompositeVFS: the shell then sees exactly
 * what `workspace.readFile` and the `file` tool see.
 */
export function shellFsOverVfs(vfs: CompositeVFS): ShellVFS {
  const unsupported = (op: string, path: string): never => {
    throw makeVfsError('EPERM', `${op} is not supported on the workspace file plane, ${op} '${path}'`, path);
  };

  const adapter: ShellVFS = {
    // isomorphic-git's Node-fs shape; nothing in the shell reads it, but the
    // interface is the SqliteFS one and it is self-referential there too.
    get promises(): ShellVFS { return adapter; },

    readFile: (path, options) => vfs.readFile(path, options),
    writeFile: (path, data) => vfs.writeFile(path, data),
    write: (path, data) => vfs.writeFile(path, data),
    readdir: (path) => vfs.readdir(path),
    mkdir: (path, options) => vfs.mkdir(path, options as { recursive?: boolean } | undefined),
    unlink: (path) => vfs.unlink(path),
    exists: (path) => vfs.exists(path),

    /** The core contract stats a missing path as `null`; the shell's callers
     *  (ls, tree, find, grep, stat) expect the Node throw. */
    async stat(path: string): Promise<VFSStat> {
      const st = await vfs.stat(path);
      if (!st) throw makeVfsError('ENOENT', `no such file or directory, stat '${path}'`, path);
      return statView(st.size, st.mtimeMs, st.isDir);
    },

    /** No symlinks on this plane, so lstat IS stat. */
    lstat(path: string): Promise<VFSStat> { return adapter.stat(path); },

    // `mv` and `rm -r` are the plane's, so the mount owning the path decides
    // how they happen (see CompositeVFS).
    rename: (oldPath, newPath) => vfs.rename(oldPath, newPath),
    removeRecursive: (path) => vfs.removeRecursive(path),

    rmdir: (path) => unsupported('rmdir', path),
    symlink: (_target, path) => unsupported('symlink', path),
    readlink: (path) => unsupported('readlink', path),
    chmod: (path) => unsupported('chmod', path),
  };

  return adapter;
}
