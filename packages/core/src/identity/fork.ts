/**
 * The fork's lineage row and the files a fork inherits. The copy itself streams: fork-transfer.ts reads the
 * source into bounded frames and fork-writer.ts lands them, since source and target may be different DOs
 * with no cross-DO SQL and one RPC argument is capped (`do.facet.rpc_bytes`). Spec: docs/WORKSPACES.md.
 */

import { walkRecursive } from '@kinu.run/agent-utils/vfs';
import type { SqlExecutor, VFS } from '../types/primitives';
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

export interface ForkFilePath {
  path: string;
  /** A payload file, relative to its owning artifact directory rather than a workspace path. */
  artifact: boolean;
}

/**
 * Paths a fork inherits, in order: SOUL.md, `memory/` (a directory walk, so storage encoding cannot change
 * what a fork means), then the plan's payload files. No scaffold, so the fork re-bootstraps v0.
 */
export async function* forkFilePaths(
  vfs: VFS, artifacts: readonly string[] = [],
): AsyncGenerator<ForkFilePath> {
  const carried: ForkFilePath[] = [];

  if (await vfs.exists(SOUL_PATH)) carried.push({ path: SOUL_PATH, artifact: false });

  if (await vfs.exists('memory')) {
    // The walker's bounds guard other callers; a fork carries the whole memory tree, so none is set.
    const walk = await walkRecursive(vfs, 'memory', Infinity, Infinity);

    for (const entry of walk.entries) {
      if (!entry.stat.isDir) carried.push({ path: entry.path, artifact: false });
    }
  }

  for (const artifact of artifacts) carried.push({ path: artifact, artifact: true });
  const seen = new Set<string>();

  for (const file of carried) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    yield file;
  }
}
