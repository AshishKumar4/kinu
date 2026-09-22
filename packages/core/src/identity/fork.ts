/**
 * Workspace fork storage half, shared by every backend: copies the cut entry's ancestry, its context
 * revision, SOUL.md, memory, crafted tools and config (minus shell-approval rows); evolution state resets.
 * Read and write are separable because source and target may be different DOs with no cross-DO SQL;
 * the hosted wire is fork-transfer.ts, since one RPC argument is capped (`do.facet.rpc_bytes`). Spec: docs/WORKSPACES.md.
 */

import * as v from 'valibot';
import { walkRecursive } from '@kinu.run/agent-utils/vfs';
import type { SqlExecutor, VFS } from '../types/primitives';
import { SOUL_PATH } from './soul';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../config/store';
import { openWorkspaceMainActor } from './workspace-actors';
import {
  forkArtifactPath,
  forkConversationEntryPartRows,
  forkConversationEntryRow,
  forkSessionMessageRow,
  planForkConversation,
} from './fork-plan';
import { writeForkSnapshot, type ForkResult } from './fork-writer';
import type {
  ForkConfigRow,
  ForkCraftedToolRow,
  ForkFile,
  ForkMemoryChunkRow,
  ForkSnapshot,
} from './fork-rows';

export interface ForkOpts {
  /** Entry id in the source's `conversation_entries`; the fork carries its ancestry. Throws if not found. */
  untilMessageId: string;
  targetWorkspaceId: string;
  targetWorkspaceName: string;
  /** Source actor payload directory; carried rows reference it by absolute path. */
  sourceArtifactDirectory: string;
  /** Target actor payload directory; every carried reference is re-rooted here. */
  targetArtifactDirectory: string;
  now?: number;
}

export interface ForkSnapshotSource {
  sql: SqlExecutor;
  vfs: VFS;
  untilMessageId: string;
  /** Source actor payload directory; carried references are made relative to it. */
  artifactDirectory: string;
}

/** Materialize everything the fork write needs from the source. Throws if `untilMessageId`
 *  is not an entry of the source's chat session. */
export async function snapshotWorkspaceForFork(source: ForkSnapshotSource): Promise<ForkSnapshot> {
  const actorId = openWorkspaceMainActor(source.sql).actorId;

  const plan = planForkConversation({
    sql: source.sql, actorId, untilMessageId: source.untilMessageId, artifactDirectory: source.artifactDirectory,
  });

  const identity = source.sql<{ id: string; name: string }>`
    SELECT id, name FROM workspace_identity LIMIT 1
  `;

  // Scaffold excluded so the fork re-bootstraps v0 fresh.
  const files = await readForkFiles(source.vfs);
  const artifacts = await readForkArtifacts(source.vfs, source.artifactDirectory, plan.artifacts);

  const craftedTools = source.sql<ForkCraftedToolRow>`
    SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
  `;

  // Shell-approval authority rows are withheld here, at the snapshot: an owner's decision about one
  // workspace must not let a child run commands without asking.
  const agentConfig = source.sql<ForkConfigRow>`SELECT key, value FROM actor_config WHERE actor_id = ${actorId}`
    .filter((row) => !SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key));

  // FTS content table; carried only to avoid reindexing (a fork without chunks rebuilds on its next write).
  const memoryChunks = source.sql<ForkMemoryChunkRow>`
    SELECT id, path, start_line, end_line, hash, text, updated_at FROM memory_chunks
  `;

  return {
    source: {
      workspaceId: identity[0]?.id ?? '',
      workspaceName: identity[0]?.name ?? '',
    },
    cut: { messageId: plan.cut.entryId, createdAtMs: plan.cut.recordedAt },
    sessionMessages: plan.messageIds.map((messageId) => forkSessionMessageRow(source.sql, actorId, messageId, source.artifactDirectory)),
    conversationEntries: plan.entryIds.map(
      (entryId) => forkConversationEntryRow(source.sql, actorId, entryId, source.artifactDirectory),
    ),
    conversationEntryParts: plan.entryIds.flatMap(
      (entryId) => forkConversationEntryPartRows(source.sql, actorId, entryId),
    ),
    contextMembers: [...plan.members],
    files,
    artifacts,
    memoryChunks,
    craftedTools,
    agentConfig,
  };
}

export interface WorkspaceStore {
  readonly sql: SqlExecutor;
  readonly vfs: VFS;
}

/** Read a source workspace and land it in a target, both open in the same process. */
export async function forkWorkspaceStorage(
  source: WorkspaceStore,
  target: WorkspaceStore,
  opts: ForkOpts,
): Promise<ForkResult> {
  const snapshot = await snapshotWorkspaceForFork({
    sql: source.sql, vfs: source.vfs, untilMessageId: opts.untilMessageId,
    artifactDirectory: opts.sourceArtifactDirectory,
  });

  return writeForkSnapshot(target.sql, target.vfs, snapshot, {
    workspaceId: opts.targetWorkspaceId,
    workspaceName: opts.targetWorkspaceName,
    artifactDirectory: opts.targetArtifactDirectory,
    now: opts.now,
  });
}

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

/** Workspace files a fork inherits, read whole (in-process shape). */
async function readForkFiles(vfs: VFS): Promise<ForkFile[]> {
  const out: ForkFile[] = [];

  for await (const file of forkFilePaths(vfs)) {
    if (file.artifact) continue;
    out.push({ path: file.path, content: v.parse(v.string(), await vfs.readFile(file.path, { encoding: 'utf8' })) });
  }

  return out;
}

/** Payload files the carried rows reference, read whole and carried by relative path. */
async function readForkArtifacts(
  vfs: VFS, artifactDirectory: string, artifacts: readonly string[],
): Promise<ForkFile[]> {
  const out: ForkFile[] = [];

  for (const relative of artifacts) {
    const path = forkArtifactPath(relative, artifactDirectory);
    out.push({ path: relative, content: v.parse(v.string(), await vfs.readFile(path, { encoding: 'utf8' })) });
  }

  return out;
}
