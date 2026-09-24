/**
 * The fork's lineage row and the files a fork inherits. The copy itself streams: fork-transfer.ts reads the
 * source into bounded frames and fork-writer.ts lands them, since source and target may be different DOs
 * with no cross-DO SQL and one RPC argument is capped (`do.facet.rpc_bytes`). Spec: docs/WORKSPACES.md.
 */

import { KinuError } from '../obs/error';
import { isSystemManaged } from '../vfs/workspace-path';
import type { SqlExecutor } from '../types/primitives';
import { compareCodeUnits } from '../utils/text';
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

export interface ForkTreeStat {
  kind: 'file' | 'directory' | 'symlink';
  size: number;
  mode: number;
  mtimeMs: number;
}

/** Synchronous, so one walk is one instant. `revision(path)` exceeds an earlier `revision()` iff the path changed since (Nimbus `SqliteVFS.revision`). */
export interface ForkTreeReader {
  lstat(path: string): ForkTreeStat | null;
  readdir(path: string): string[];
  readlink(path: string): string;
  readRange(path: string, offset: number, length: number): Uint8Array;
  revision(path?: string): number;
}

export type ForkTreeEntry =
  /** `artifact`: `path` is relative to the artifact directory. */
  | { kind: 'file'; path: string; size: number; mode: number; mtimeMs: number; artifact: boolean }
  | { kind: 'directory'; path: string; mode: number; mtimeMs: number }
  | { kind: 'symlink'; path: string; target: string };

export type ForkFileEntry = Extract<ForkTreeEntry, { kind: 'file' }>;

export interface ForkSnapshot {
  /** SOUL.md, the tree (each directory after its contents), then payload files. */
  readonly entries: readonly ForkTreeEntry[];
  /** Throws if `file` changed since the snapshot. */
  read(file: ForkFileEntry, offset: number, length: number): Uint8Array;
}

/** Re-bootstrapped at v0 in the fork. */
const NOT_CARRIED_AT_ROOT: ReadonlySet<string> = new Set(['scaffold']);

/** SOUL.md, what the Files tab shows (minus the scaffold), and the conversation's payload files, in one synchronous walk. */
export function snapshotForkFiles(
  tree: ForkTreeReader, artifacts: readonly { relative: string; path: string }[],
): ForkSnapshot {
  const clock = tree.revision();
  const entries: ForkTreeEntry[] = [];
  const soul = tree.lstat(SOUL_PATH);

  if (soul?.kind === 'file') entries.push(fileEntry(SOUL_PATH, soul, false));

  // Post-order: a directory's mode and mtime land after its contents.
  const walk = (directory: string): void => {
    for (const name of tree.readdir(directory).sort(compareCodeUnits)) {
      if (isSystemManaged(name) || (directory === '' && (NOT_CARRIED_AT_ROOT.has(name) || name === SOUL_PATH))) continue;
      const path = directory === '' ? name : `${directory}/${name}`;
      const stat = tree.lstat(path);

      if (stat === null) throw new Error(`fork could not stat ${JSON.stringify(path)}, which its directory listed`);

      if (stat.kind === 'directory') {
        walk(path);
        entries.push({ kind: 'directory', path, mode: stat.mode, mtimeMs: stat.mtimeMs });
      } else if (stat.kind === 'symlink') {
        entries.push({ kind: 'symlink', path, target: tree.readlink(path) });
      } else {
        entries.push(fileEntry(path, stat, false));
      }
    }
  };

  walk('');
  const payloads = new Map<string, string>();

  for (const artifact of artifacts) {
    if (payloads.has(artifact.relative)) continue;
    payloads.set(artifact.relative, artifact.path);
    const stat = tree.lstat(artifact.path);

    if (stat?.kind !== 'file') {
      throw new KinuError('missing', `fork cannot carry payload ${JSON.stringify(artifact.path)}: the conversation references it and it is not a file`);
    }

    entries.push(fileEntry(artifact.relative, stat, true));
  }

  return {
    entries,
    read(file, offset, length) {
      const at = file.artifact ? payloads.get(file.path) ?? file.path : file.path;
      const bytes = tree.readRange(at, offset, length);

      // Same synchronous step as the read: no write lands between them.
      if (tree.revision(at) > clock) {
        throw new KinuError('unavailable', `${JSON.stringify(file.path)} changed while the fork was copying the workspace, `
          + 'so the copy would not be one snapshot and no fork was created. Fork again once whatever is writing it has stopped.');
      }

      if (bytes.byteLength !== length) {
        throw new Error(`fork read ${bytes.byteLength} bytes of ${JSON.stringify(file.path)} where ${length} were asked for`);
      }

      return bytes;
    },
  };
}

function fileEntry(path: string, stat: ForkTreeStat, artifact: boolean): ForkFileEntry {
  return { kind: 'file', path, size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, artifact };
}
