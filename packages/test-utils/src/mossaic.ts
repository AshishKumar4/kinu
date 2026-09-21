/**
 * An in-memory Mossaic: tenants kept apart by id, the SDK's error codes on the
 * SDK's `code` field, symlinks and folders as the real tenant lists them. It
 * stands in for `createVFS(env, { tenant })` under `bun test` and behind the
 * component gallery's Drive frame in a browser, so it reaches nothing but the
 * core types. The real client is driven under workerd by
 * packages/cf-backend/tests/workerd/shared-drive.test.ts.
 */
import type { MossaicClient, MossaicChild, MossaicStat } from '@kinu.run/core';

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
  const folders = new Map<string, Set<string>>();
  const touched = new Map<string, number>();

  const tenant = (id: string): MossaicClient => {
    const files = stores.get(id) ?? new Map<string, Uint8Array>();
    const symlinks = links.get(id) ?? new Map<string, string>();
    const dirs = folders.get(id) ?? new Set<string>(['/']);

    stores.set(id, files);
    links.set(id, symlinks);
    folders.set(id, dirs);

    const isDir = (p: string): boolean => dirs.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`));

    /** A write touches the entry and, as on a real filesystem, every folder above it. */
    const stamp = (p: string): void => {
      const at = Date.now();

      for (let key = p; key !== ''; key = key.slice(0, key.lastIndexOf('/'))) touched.set(`${id}:${key}`, at);
      touched.set(`${id}:/`, at);
    };

    const statOf = (p: string): MossaicStat => {
      const bytes = files.get(p);

      // Unstamped is unknown (0), the same absence the product renders as no
      // age; a stand-in epoch would read as decades old in every listing.
      const mtimeMs = touched.get(`${id}:${p}`) ?? 0;

      if (bytes !== undefined) return { type: 'file', size: bytes.byteLength, mtimeMs };

      if (symlinks.has(p)) return { type: 'symlink', size: 0, mtimeMs };

      if (isDir(p)) return { type: 'dir', size: 0, mtimeMs };
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
      async writeFile(p, data) {
        files.set(p, data instanceof Uint8Array ? data : new TextEncoder().encode(data));
        stamp(p);
      },
      async readdir(p) { return children(p).map((c) => c.name); },
      async stat(p) { return statOf(p); },
      async exists(p) { return files.has(p) || symlinks.has(p) || isDir(p); },
      async unlink(p) { if (!files.delete(p) && !symlinks.delete(p)) throw new FakeMossaicError('ENOENT', p); },
      async mkdir(p, opts) {
        if (files.has(p)) throw new FakeMossaicError('EEXIST', p);
        const parent = p.slice(0, p.lastIndexOf('/')) || '/';

        if (opts?.recursive !== true && !isDir(parent)) throw new FakeMossaicError('ENOENT', parent);
        dirs.add(p);
        stamp(p);
      },
      async rmdir(p) { dirs.delete(p); },
      async removeRecursive(p) {
        for (const key of Array.from(files.keys())) if (key === p || key.startsWith(`${p}/`)) files.delete(key);

        for (const key of Array.from(symlinks.keys())) if (key === p || key.startsWith(`${p}/`)) symlinks.delete(key);

        for (const dir of Array.from(dirs)) if (dir === p || dir.startsWith(`${p}/`)) dirs.delete(dir);
      },
      async rename(src, dst) {
        const bytes = files.get(src);

        if (bytes !== undefined) {
          files.delete(src);
          files.set(dst, bytes);
          stamp(dst);

          return;
        }

        const target = symlinks.get(src);

        if (target !== undefined) {
          symlinks.delete(src);
          symlinks.set(dst, target);
          stamp(dst);

          return;
        }

        if (!isDir(src)) throw new FakeMossaicError('ENOENT', src);

        for (const [key, value] of Array.from(files)) {
          if (key.startsWith(`${src}/`)) {
            files.delete(key);
            files.set(`${dst}${key.slice(src.length)}`, value);
          }
        }

        for (const dir of Array.from(dirs)) {
          if (dir === src || dir.startsWith(`${src}/`)) {
            dirs.delete(dir);
            dirs.add(`${dst}${dir.slice(src.length)}`);
          }
        }

        stamp(dst);
      },
      async symlink(target, p) {
        symlinks.set(p, target);
        stamp(p);
      },
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

