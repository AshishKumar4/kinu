import { exists, readText, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * `.vN` files are canonical and the `status='current'` row is the pointer: the loop an actor runs is the current
 * version's file, and nothing else holds a copy of it.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { getCurrentScaffoldVersion } from './versions';

export interface ScaffoldSurfaceOpts {
  vfs: VFS;
  sql: SqlExecutor;
  /** The current pointer is per-actor; a wrongly bound surface would run a peer's program. */
  actor: Pick<ActorHandle, 'actorId' | 'assertCurrent'>;
  path: string;
}

export function createScaffoldSurface({ vfs, sql, actor, path }: ScaffoldSurfaceOpts) {
  const versionedPath = (version: number) => `${path}.v${version}`;

  return {
    path,
    /** An actor no version row names runs v0. */
    exists: async (): Promise<boolean> => exists(vfs, versionedPath(getCurrentScaffoldVersion(sql, actor) ?? 0)),
    /** Throws for an actor no loop was seeded for: the turn falls back to the built-in loop and says so. */
    read: async (): Promise<string> => readText(vfs, versionedPath(getCurrentScaffoldVersion(sql, actor) ?? 0)),
    version: async (): Promise<number> => getCurrentScaffoldVersion(sql, actor) ?? 0,
  };
}
