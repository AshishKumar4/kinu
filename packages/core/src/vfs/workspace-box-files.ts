import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { NimbusSandboxHandle } from '../execution/nimbus';
import { tolerate } from '../obs/index';

/** ENOENT, by `code`, is absence; any other failure throws. */
function absentAsNull<T>(read: () => T): T | null {
  return tolerate(read, 'enoent') ?? null;
}

export function workspaceBoxFiles(open: () => Promise<SqliteVFS>, cred: VfsCred = CRED_SESSION_USER): NimbusSandboxHandle['files'] {
  const view = async (): Promise<CredentialedVfs> => (await open()).as(cred);

  return {
    as: (agent) => workspaceBoxFiles(open, agent),
    async read(path) {
      const vfs = await view();

      return absentAsNull(() => vfs.readFileString(path));
    },
    async readBytes(path) {
      const vfs = await view();

      return absentAsNull(() => vfs.readFile(path));
    },
    async readRange(path, offset, length) {
      const vfs = await view();

      return absentAsNull(() => vfs.readRange(path, offset, length));
    },
    async write(path, content) {
      const vfs = await view();
      const cut = path.lastIndexOf('/');

      if (cut > 0) {
        const parent = path.slice(0, cut);

        if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
      }

      vfs.writeFile(path, content);
    },
    async stat(path) {
      const vfs = await view();

      return absentAsNull(() => {
        const stat = vfs.stat(path);

        return { type: stat.type, size: stat.size, mtime: stat.mtime };
      });
    },
    async lstat(path) {
      const vfs = await view();

      return absentAsNull(() => {
        const stat = vfs.lstat(path);

        return { type: stat.type, size: stat.size, mtime: stat.mtime, mode: stat.mode };
      });
    },
    async readlink(path) {
      const vfs = await view();

      return absentAsNull(() => vfs.readlink(path));
    },
    async rename(from, to) { (await view()).rename(from, to); },
    async chmod(path, mode) { (await view()).chmod(path, mode); },
    async list(path) {
      return (await view()).readdir(path ?? '/').map((entry) => ({ name: entry.name, type: entry.type }));
    },
    async exists(path) { return (await view()).exists(path); },
    async mkdir(path) { (await view()).mkdir(path, { recursive: true }); },
    async delete(path, options) {
      const vfs = await view();

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
    },
  };
}
