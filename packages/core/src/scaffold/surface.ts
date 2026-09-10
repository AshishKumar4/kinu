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
import type { ActorHandle } from '../identity/actor-handle';
import { getCurrentScaffoldVersion } from './shadow';

export interface ScaffoldSurfaceOpts {
  vfs: VFS;
  sql: SqlExecutor;
  /** Whose pointer this surface resolves. The `.vN` files are shared physical
   *  storage, but which version is CURRENT is per-actor, so a surface bound to
   *  the wrong actor would execute a peer's program. */
  actor: ActorHandle;
  path: string;
}

export async function readScaffoldFileText(vfs: VFS, target: string): Promise<string> {
  const content = await vfs.readFile(target, { encoding: 'utf8' });

  return content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
}

export function createScaffoldSurface({ vfs, sql, actor, path }: ScaffoldSurfaceOpts) {
  const versionedPath = (version: number) => `${path}.v${version}`;

  return {
    path,
    exists: async (): Promise<boolean> => {
      if (await vfs.exists(path)) return true;
      const current = getCurrentScaffoldVersion(sql, actor);

      return current !== null && (await vfs.exists(versionedPath(current)));
    },
    read: async (): Promise<string> => {
      const current = getCurrentScaffoldVersion(sql, actor);

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
    version: async (): Promise<number> => getCurrentScaffoldVersion(sql, actor) ?? 0,
  };
}
