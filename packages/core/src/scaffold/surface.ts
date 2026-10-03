import { exists, readText, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * `.vN` files are canonical, the `status='current'` row is the pointer, and the
 * live file is a rebuildable view. Mutations write source before metadata and
 * refresh the view after the pointer commits.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { getCurrentScaffoldVersion } from './versions';

export interface ScaffoldSurfaceOpts {
  vfs: VFS;
  sql: SqlExecutor;
  /** The current pointer is per-actor; a wrongly bound surface would run a peer's program. */
  actor: ActorHandle;
  path: string;
}

export function createScaffoldSurface({ vfs, sql, actor, path }: ScaffoldSurfaceOpts) {
  const versionedPath = (version: number) => `${path}.v${version}`;

  return {
    path,
    exists: async (): Promise<boolean> => {
      if (await exists(vfs, path)) return true;
      const current = getCurrentScaffoldVersion(sql, actor);

      return current !== null && (await exists(vfs, versionedPath(current)));
    },
    read: async (): Promise<string> => {
      const current = getCurrentScaffoldVersion(sql, actor);

      if (current !== null && (await exists(vfs, versionedPath(current)))) {
        return readText(vfs, versionedPath(current));
      }

      return readText(vfs, path);
    },
    write: async (code: string): Promise<void> => {
      const slash = path.lastIndexOf('/');

      if (slash > 0) await vfs.mkdir(path.slice(0, slash), { recursive: true });
      await writeText(vfs, path, code);
    },
    version: async (): Promise<number> => getCurrentScaffoldVersion(sql, actor) ?? 0,
  };
}
