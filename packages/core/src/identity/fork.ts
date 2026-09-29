/** The fork's lineage row and the files a fork inherits, which fork-transfer.ts streams. Spec: docs/WORKSPACES.md. */

import type { VfsExportChunk, VfsExportPage } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { isSystemManaged } from '../vfs/workspace-path';
import type { SqlExecutor } from '../types/primitives';
import { SOUL_PATH } from './soul';

export interface ForkLineageRow {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceMessageId: string;
  sourceMessageCreatedAt: number;
  forkedAt: number;
}

/** Read the single-row fork_lineage; null when not a fork. */
export function readForkLineage(sql: SqlExecutor): ForkLineageRow | null {
  const rows = sql<{
    source_workspace_id: string; source_workspace_name: string;
    source_message_id: string; source_message_created_at: number;
    forked_at: number;
  }>`SELECT source_workspace_id, source_workspace_name, source_message_id,
            source_message_created_at, forked_at
     FROM fork_lineage WHERE id = 1 LIMIT 1`;

  const r = rows[0];

  if (!r) return null;

  return {
    sourceWorkspaceId: r.source_workspace_id,
    sourceWorkspaceName: r.source_workspace_name,
    sourceMessageId: r.source_message_id,
    sourceMessageCreatedAt: r.source_message_created_at,
    forkedAt: r.forked_at,
  };
}

/** A fork's pin on its source's files is named `fork:<transfer id>`. */
export const FORK_PIN_PREFIX = 'fork:';

/**
 * The source's files at one instant, a Nimbus snapshot pinned for one transfer. Paths are absolute store paths,
 * read as the kernel, so no file's mode hides it from the copy.
 */
export interface ForkPinnedFiles {
  /** The names directly under `path`. */
  readdir(path: string): string[];
  /** What `path` is, a symbolic link not followed; null when it is not there. */
  kind(path: string): 'file' | 'directory' | 'symlink' | null;
  readFile(path: string): Uint8Array;
  /** One page of the subtree at `root` (a file root is one row), continuing after `after`. */
  exportPage(root: string, after: string | null): VfsExportPage;
  /** The bytes of chunks by hash, up to `maxBytes` (at least one chunk); `rest` is what did not fit. */
  exportChunks(hashes: readonly string[], maxBytes: number): { chunks: VfsExportChunk[]; rest: string[] };
  /** Drops the pin: the source's store keeps no history for it. */
  release(): Promise<void>;
}

/** Opened once per transfer. */
export interface ForkFileSource {
  pin(name: string): Promise<ForkPinnedFiles>;
}

/** Re-bootstrapped at v0 in the fork, or published through its own protected write. */
const NOT_CARRIED: ReadonlySet<string> = new Set(['scaffold', SOUL_PATH]);

/**
 * Whether a name directly under the home crosses as a tree of its own. The home's own platform directories (Nimbus's
 * runtimes, Kinu's agent state) are the target's to make; the same names deeper in a project are the owner's data.
 */
export function forkCarries(name: string): boolean {
  return !NOT_CARRIED.has(name) && !isSystemManaged(name);
}
