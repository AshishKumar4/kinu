/**
 * Workspace fork — the storage half, shared by every backend.
 *
 * Forks a source workspace's SQLite state into a target workspace's (a fork is
 * a NEW workspace by a new name). The semantics are "clean-slate conversation
 * only":
 *
 *   Copy:   SOUL.md, the cut entry's ancestry in the canonical conversation
 *           store (`conversation_entries` + the `session_messages` those
 *           entries and the restored working context reference), the payload
 *           files those rows point at, memory/* VFS rows + memory_chunks,
 *           crafted_tools, actor_config EXCEPT the shell-approval authority
 *           rows — see the snapshot below
 *   Reset:  search_nodes, scaffold_versions, task_history, craft quality,
 *           fibers, evolution_events, executor_output, activity_log,
 *           agent_tasks, scaffold/* VFS rows
 *   Rewrite: workspace_identity (new id/name/created_at)
 *   Insert: fork_lineage (single row)
 *
 * WHAT A FORK OWES THE MODEL. The public chain and the working context are two
 * different selections over the same messages: an entry pruned out of the
 * context still belongs to the transcript, and a context member (a tool call
 * and its result) need not appear in the transcript at all. So the fork carries
 * BOTH — the ancestry as `conversation_entries`, and the cut entry's context
 * revision as ONE fresh context on the target whose membership is what that
 * revision selected. Carrying only one of them would land a fork that either
 * shows history the model cannot read or reads history the operator cannot see.
 *
 * The read and the write are separable on purpose. A fork often crosses a
 * process boundary — on Cloudflare the source and the target are two different
 * Durable Objects and there is no cross-DO SQL — so the source materializes a
 * {@link ForkSnapshot} and ships it. That snapshot IS the source view: the copy
 * is defined once here, over the query set core owns, rather than a second
 * hand-maintained transcription of it living in whichever backend has to send
 * it across.
 *
 * On that boundary the snapshot does not cross as one value: one serialized
 * RPC argument is capped (`do.facet.rpc_bytes`) and a workspace's history is
 * not. `identity/fork-transfer.ts` owns that wire — bounded batches of rows and
 * bounded ranges of files, staged straight into the target's own storage. No
 * total size is refused; a bigger workspace is more frames.
 *
 * Backend-agnostic: only SqlExecutor tagged-template queries, no DO-specific
 * APIs. The CF backend drives the write inside a transactionSync() for
 * atomicity; tests drive both halves against two bun:sqlite handles.
 *
 * Formal spec + rationale: docs/WORKSPACES.md.
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
  /** Entry id from source's `conversation_entries` (session `default`); the
   *  fork carries that entry's ancestry. Throws if not found. */
  untilMessageId: string;
  /** New target workspace's id (usually `ctx.id.toString()` on the fork DO). */
  targetWorkspaceId: string;
  /** New target workspace's human name. */
  targetWorkspaceName: string;
  /** Where the SOURCE actor's payload files live. Carried rows reference them
   *  by absolute path, and a fork has to read them. */
  sourceArtifactDirectory: string;
  /** Where the TARGET actor's payload files live. Every carried reference is
   *  re-rooted here. */
  targetArtifactDirectory: string;
  /** Optional clock override for tests. Defaults to Date.now(). */
  now?: number;
}

/** What the in-process snapshot reads its source through. */
export interface ForkSnapshotSource {
  sql: SqlExecutor;
  vfs: VFS;
  untilMessageId: string;
  /** Where the source actor's payload files live. Carried references are made
   *  relative to it, and the payload files are read from it. */
  artifactDirectory: string;
}

/**
 * Materialize everything the fork write will need from the source workspace.
 *
 * Throws if `untilMessageId` is not an entry of the source's chat session — the
 * one failure worth surfacing before a target workspace is created.
 */
export async function snapshotWorkspaceForFork(source: ForkSnapshotSource): Promise<ForkSnapshot> {
  const actorId = openWorkspaceMainActor(source.sql).actorId;

  const plan = planForkConversation({
    sql: source.sql, actorId, untilMessageId: source.untilMessageId, artifactDirectory: source.artifactDirectory,
  });

  const identity = source.sql<{ id: string; name: string }>`
    SELECT id, name FROM workspace_identity LIMIT 1
  `;

  // The scaffold is deliberately excluded so the fork re-bootstraps v0 fresh.
  const files = await readForkFiles(source.vfs);
  const artifacts = await readForkArtifacts(source.vfs, source.artifactDirectory, plan.artifacts);

  const craftedTools = source.sql<ForkCraftedToolRow>`
    SELECT name, description, params, code, scope, created_at, updated_at FROM crafted_tools
  `;

  // Every config row EXCEPT the ones the shell-approval gate reads as live
  // authorization. A remembered "always" and a permissive mode are decisions the
  // owner made about ONE workspace's history; copied into a child they let it
  // run matching commands without ever asking. Withheld at the SNAPSHOT rather
  // than at the write, so the authority never enters the value that crosses
  // between workspaces at all.
  const agentConfig = source.sql<ForkConfigRow>`SELECT key, value FROM actor_config WHERE actor_id = ${actorId}`
    .filter((row) => !SHELL_APPROVAL_AUTHORITY_KEYS.includes(row.key));

  // The FTS content table (agent-utils MemoryStore), created for every
  // workspace by initWorkspaceSchema. Carrying it is an optimization — the text
  // is in the memory/*.md FILES above, and a fork with no chunks reindexes via
  // FTS5 'rebuild' on its next write. The framed transfer has no total
  // snapshot-size cap, so retaining `memory_chunks` avoids reindexing without
  // competing for a snapshot budget.
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

/** Read a source workspace and land it in a target, in one call — the shape a
 *  backend uses when both databases are open in the same process. */
export async function forkWorkspaceStorage(
  source: SqlExecutor,
  sourceVfs: VFS,
  target: SqlExecutor,
  targetVfs: VFS,
  opts: ForkOpts,
): Promise<ForkResult> {
  const snapshot = await snapshotWorkspaceForFork({
    sql: source, vfs: sourceVfs, untilMessageId: opts.untilMessageId,
    artifactDirectory: opts.sourceArtifactDirectory,
  });

  return writeForkSnapshot(target, targetVfs, snapshot, {
    workspaceId: opts.targetWorkspaceId,
    workspaceName: opts.targetWorkspaceName,
    artifactDirectory: opts.targetArtifactDirectory,
    now: opts.now,
  });
}

/** Shape of what getForkLineage returns (null when not a fork). */
export interface ForkLineageRow {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceMessageId: string;
  sourceMessageCreatedAt: number;
  forkedAt: number;
}

/** Read the single-row fork_lineage. Returns null when not a fork.
 *
 *  `fork_lineage` is created by initAllTables on every workspace, and an empty
 *  result already says "not a fork" — so this read is uncaught. A catch would
 *  have no condition to handle, only the ability to report a broken read as a
 *  workspace with no parent. */
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

/** One file a fork carries, and which root its path is relative to. */
export interface ForkFilePath {
  path: string;
  /** A payload file, relative to the artifact directory that owns it, rather
   *  than a workspace path. */
  artifact: boolean;
}

/**
 * The paths a fork inherits, in the order it carries them: SOUL.md, everything
 * under `memory/`, then the payload files the carried rows reference.
 *
 * A directory walk rather than a table scan for the workspace half — the fork
 * carries what the agent can see, so a store that chunks or compresses
 * differently cannot change what a fork means. The scaffold is deliberately
 * absent so a fork re-bootstraps v0 fresh. The payload half is not walkable:
 * only the carried rows say which payload files belong to this cut, so they
 * arrive as the plan's list.
 *
 * Paths and not contents, so the streaming sender in
 * `identity/fork-transfer.ts` can declare how many files are coming and then
 * read them one at a time. It is the same walk either way: which files a fork
 * carries is decided here, once.
 */
export async function* forkFilePaths(
  vfs: VFS, artifacts: readonly string[] = [],
): AsyncGenerator<ForkFilePath> {
  const carried: ForkFilePath[] = [];

  if (await vfs.exists(SOUL_PATH)) carried.push({ path: SOUL_PATH, artifact: false });

  if (await vfs.exists('memory')) {
    // The one walk every plane shares, files only. A fork carries the whole
    // memory tree whatever its size: the walker's bounds are runaway guards for
    // other callers, and a database-backed tree has no loop to run away into,
    // so neither is set here and neither can trip.
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

/** The workspace files a fork inherits, read whole — the in-process shape, over
 *  the one walk {@link forkFilePaths} owns. */
async function readForkFiles(vfs: VFS): Promise<ForkFile[]> {
  const out: ForkFile[] = [];

  for await (const file of forkFilePaths(vfs)) {
    if (file.artifact) continue;
    out.push({ path: file.path, content: v.parse(v.string(), await vfs.readFile(file.path, { encoding: 'utf8' })) });
  }

  return out;
}

/** The payload files the carried rows reference, read whole from the source
 *  artifact directory and carried by their relative path. */
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
