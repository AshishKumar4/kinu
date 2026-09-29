import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { NimbusSandboxHandle } from '../execution/nimbus';
import { tolerate } from '../obs/index';
import { atVfsPath } from './errno';

/** ENOENT, by `code`, is absence; any other failure throws. */
function absentAsNull<T>(read: () => T): T | null {
  return tolerate(read, 'enoent') ?? null;
}

export function workspaceBoxFiles(open: () => Promise<SqliteVFS>, cred: VfsCred = CRED_SESSION_USER): NimbusSandboxHandle['files'] {
  // SqliteVFS itself still throws plain Error objects carrying errno; the file port exposes Nimbus's VfsError.
  const operate = <T>(path: string, syscall: string, action: (files: CredentialedVfs) => T): Promise<T> =>
    atVfsPath(path, syscall, async () => action((await open()).as(cred)));

  return {
    as: (agent) => workspaceBoxFiles(open, agent),
    read: (path) => operate(path, 'read', (vfs) => absentAsNull(() => vfs.readFileString(path))),
    readBytes: (path) => operate(path, 'read', (vfs) => absentAsNull(() => vfs.readFile(path))),
    readRange: (path, offset, length) => operate(path, 'read', (vfs) => absentAsNull(() => vfs.readRange(path, offset, length))),
    write: (path, content) => operate(path, 'write', (vfs) => {
      const cut = path.lastIndexOf('/');

      if (cut > 0) {
        const parent = path.slice(0, cut);

        if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
      }

      vfs.writeFile(path, content);
    }),
    stat: (path) => operate(path, 'stat', (vfs) => absentAsNull(() => {
      const stat = vfs.stat(path);

      return { type: stat.type, size: stat.size, mtime: stat.mtime };
    })),
    lstat: (path) => operate(path, 'lstat', (vfs) => absentAsNull(() => {
      const stat = vfs.lstat(path);

      return { type: stat.type, size: stat.size, mtime: stat.mtime, mode: stat.mode };
    })),
    readlink: (path) => operate(path, 'readlink', (vfs) => absentAsNull(() => vfs.readlink(path))),
    rename: (from, to) => operate(from, 'rename', (vfs) => vfs.rename(from, to)),
    chmod: (path, mode) => operate(path, 'chmod', (vfs) => vfs.chmod(path, mode)),
    list: (path) => operate(path ?? '/', 'readdir', (vfs) => vfs.readdir(path ?? '/').map((entry) => ({ name: entry.name, type: entry.type }))),
    exists: (path) => operate(path, 'stat', (vfs) => vfs.exists(path)),
    mkdir: (path) => operate(path, 'mkdir', (vfs) => vfs.mkdir(path, { recursive: true })),
    delete: (path, options) => operate(path, 'unlink', (vfs) => {
      if (options?.recursive) {
        vfs.removeRecursive(path);

        return;
      }

      // `rmdir` refuses a populated directory.
      if (vfs.isDirectory(path)) {
        vfs.rmdir(path);

        return;
      }

      vfs.unlink(path);
    }),
  };
}
