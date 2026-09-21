/**
 * An in-memory Mossaic: tenants kept apart by id, the SDK's error codes on the
 * SDK's `code` field, symlinks and folders as the real tenant lists them. It
 * stands in for `createVFS(env, { tenant })` under `bun test`; the real client
 * is driven under workerd by packages/cf-backend/tests/workerd/shared-drive.test.ts.
 */
import type { MossaicClient, MossaicChild, MossaicStat } from '../src/vfs/mossaic-vfs';

/** What Mossaic's SDK throws: an Error carrying one of its own codes. */
export class FakeMossaicError extends Error {
  constructor(readonly code: string, path: string) {
    super(`${code}: ${path}`);
  }
}

export interface FakeMossaic {
  tenant: (id: string) => MossaicClient;
  stores: Map<string, Map<string, Uint8Array>>;
}

/** One tenant's files, keyed by tenant id. The fake never consults a path to
 *  decide visibility — only the tenant it was created for. */
export function fakeMossaic(): FakeMossaic {
  const stores = new Map<string, Map<string, Uint8Array>>();
  const links = new Map<string, Map<string, string>>();

  const tenant = (id: string): MossaicClient => {
    const files = stores.get(id) ?? new Map<string, Uint8Array>();
    const symlinks = links.get(id) ?? new Map<string, string>();

    stores.set(id, files);
    links.set(id, symlinks);
    const dirs = new Set<string>(['/']);

    const isDir = (p: string): boolean => dirs.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`));

    const statOf = (p: string): MossaicStat => {
      const bytes = files.get(p);

      if (bytes !== undefined) return { type: 'file', size: bytes.byteLength, mtimeMs: 1 };

      if (symlinks.has(p)) return { type: 'symlink', size: 0, mtimeMs: 1 };

      if (isDir(p)) return { type: 'dir', size: 0, mtimeMs: 1 };
      throw new FakeMossaicError('ENOENT', p);
    };

    const children = (p: string): MossaicChild[] => {
      const prefix = p === '/' ? '/' : `${p}/`;
      const names = new Set<string>();

      for (const key of [...files.keys(), ...symlinks.keys(), ...dirs]) {
        if (key !== p && key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]!);
      }

      return [...names].map((name) => {
        const full = `${prefix}${name}`;
        const stat = statOf(full);

        return { kind: stat.type === 'dir' ? 'folder' : stat.type === 'file' ? 'file' : 'symlink', name, stat };
      });
    };

    return {
      async readFile(p) {
        const bytes = files.get(p);

        if (bytes === undefined) throw new FakeMossaicError(isDir(p) ? 'EISDIR' : 'ENOENT', p);

        return bytes;
      },
      async writeFile(p, data) { files.set(p, data instanceof Uint8Array ? data : new TextEncoder().encode(data)); },
      async readdir(p) { return children(p).map((c) => c.name); },
      async stat(p) { return statOf(p); },
      async exists(p) { return files.has(p) || symlinks.has(p) || isDir(p); },
      async unlink(p) { if (!files.delete(p) && !symlinks.delete(p)) throw new FakeMossaicError('ENOENT', p); },
      async mkdir(p) { dirs.add(p); },
      async rmdir(p) { dirs.delete(p); },
      async removeRecursive(p) {
        for (const key of files.keys()) if (key === p || key.startsWith(`${p}/`)) files.delete(key);
        dirs.delete(p);
      },
      async rename(src, dst) {
        const bytes = files.get(src);

        if (bytes === undefined) throw new FakeMossaicError('ENOENT', src);
        files.delete(src);
        files.set(dst, bytes);
      },
      async symlink(target, p) { symlinks.set(p, target); },
      async readlink(p) {
        const target = symlinks.get(p);

        if (target === undefined) throw new FakeMossaicError('EINVAL', p);

        return target;
      },
      async listChildren(p) { return { entries: children(p) }; },
    };
  };

  return { tenant, stores };
}

