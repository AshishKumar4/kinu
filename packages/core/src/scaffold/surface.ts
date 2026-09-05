/**
 * The one `Identity['scaffold']` surface: `.vN` files are the canonical
 * source of every version, the `scaffold_versions.status='current'` row is
 * the single current pointer, and the live file is a rebuildable view.
 *
 * `read()` — what execution runs — resolves the current pointer's version
 * file and only falls back to the live view when no archive file exists yet
 * (a workspace between deploy and its first activation bootstrap). Every
 * mutation path writes source files before metadata and refreshes the view
 * after the pointer commits, so a crash between those steps leaves a stale
 * view that the next activation heals without ever changing what runs.
 */

import type { SqlExecutor, VFS } from '../types/primitives';
import { getCurrentScaffoldVersion } from './shadow';

export interface ScaffoldSurfaceOpts {
  vfs: VFS;
  sql: SqlExecutor;
  path: string;
}

export async function readScaffoldFileText(vfs: VFS, target: string): Promise<string> {
  const content = await vfs.readFile(target, { encoding: 'utf8' });
  return content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
}

export function createScaffoldSurface({ vfs, sql, path }: ScaffoldSurfaceOpts) {
  const versionedPath = (version: number) => `${path}.v${version}`;
  return {
    path,
    exists: async (): Promise<boolean> => {
      if (await vfs.exists(path)) return true;
      const current = getCurrentScaffoldVersion(sql);
      return current !== null && (await vfs.exists(versionedPath(current)));
    },
    read: async (): Promise<string> => {
      const current = getCurrentScaffoldVersion(sql);
      if (current !== null && (await vfs.exists(versionedPath(current)))) {
        return readScaffoldFileText(vfs, versionedPath(current));
      }
      return readScaffoldFileText(vfs, path);
    },
    write: async (code: string): Promise<void> => {
      const slash = path.lastIndexOf('/');
      if (slash > 0) await vfs.mkdir(path.slice(0, slash), { recursive: true });
      await vfs.writeFile(path, code);
    },
    version: async (): Promise<number> => getCurrentScaffoldVersion(sql) ?? 0,
  };
}
