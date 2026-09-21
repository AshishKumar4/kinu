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
 * "Ancestry" and not "everything older than the cut" is the whole difference
 * between forking a tree and forking a list. A prefix cut cannot express a
 * second child of the same entry, and the public chain is a tree by
 * construction — `conversation_entries.parent_id`.
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
 * total size is refused; a bigger workspace is more frames. Both halves read
 * the rows through the readers below, so there is one transcription of the
 * copy however it travels.
 *
 * The target DB MUST already have been initialized (initWorkspaceSchema) — the
 * caller is responsible for that (typically via the boot path, which
 * auto-bootstraps a default identity that this helper then overwrites).
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
import { SOUL_PATH, summarizeSoul } from './soul';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../config/store';
import { CHAT_SESSION_ID } from './conversation-store';
import { ForkStagingState } from './fork-staging';
import { invalidateConversationSearchIndex } from '../memory/conversation-search';
import { openWorkspaceMainActor, WorkspaceActorDirectory } from './workspace-actors';
import { KinuError } from '../obs/error';

/** How deep a carried chain may be before the walk refuses it. A public chain
 *  is a tree whose depth is bounded by turns, not by rows; a walk without a
 *  bound is a loop waiting for corrupt parent edges. */
const FORK_CHAIN_MAX_DEPTH = 10_000;

/** The revision the target's fresh context is published at. The fork's context
 *  is a restoration of the cut revision's membership, not a continuation of the
 *  source's revision history, so it starts at one revision of its own. */
const FORK_CONTEXT_REVISION = 1;

/**
 * What a fork copies, as valibot schemas.
 *
 * These are the CANONICAL declaration. Every TypeScript type below is inferred
 * from them, and `identity/fork-transfer.ts` builds its frame union out of the
 * same row schemas — so the rows a fork reads, the rows it puts on a wire and
 * the rows it writes are one authority with no second transcription to drift.
 *
 * Everything is JSON-serializable, so a snapshot also survives a transport that
 * only carries structured clones.
 */

/** The source workspace's identity and the entry the fork is cut at — the
 *  fork's lineage parent, and its boundary. */
export const ForkSnapshotHeadSchema = v.object({
  source: v.object({ workspaceId: v.string(), workspaceName: v.string() }),
  cut: v.object({ messageId: v.string(), createdAtMs: v.number() }),
});

/**
 * One carried message identity.
 *
 * `request_id`, `output_slot` and `ingress_id` are deliberately absent: a
 * request is a source-side execution record that does not cross, and an ingress
 * id is the admission identity of a turn the fork never ran. The target row
 * carries null for all three.
 */
export const ForkSessionMessageRowSchema = v.object({
  message_id: v.string(),
  role: v.picklist(['system', 'user', 'assistant', 'tool']),
  native_content_kind: v.picklist(['string', 'parts']),
  origin: v.picklist(['input', 'output', 'edit', 'context_transform', 'render']),
  recorded_at: v.number(),
});

/** One part identity of one carried message. A tool result names the call it
 *  answers, and the closure that picks carried messages guarantees the call is
 *  carried too — so the reply edge survives the crossing. */
export const ForkMessagePartRowSchema = v.object({
  message_id: v.string(),
  part_no: v.number(),
  kind: v.string(),
  reply_to_message_id: v.nullable(v.string()),
  reply_to_part_no: v.nullable(v.number()),
  stream_order: v.nullable(v.number()),
});

/**
 * One immutable update of one carried message, up to that message's cutoff.
 *
 * `payload_path` crosses RELATIVE to the source actor's artifact directory and
 * is re-rooted under the target's, because an absolute path names a directory
 * that belongs to the workspace it came from.
 *
 * `seals` marks the update that IS the message's `sealed_sequence`. The seal
 * travels with the update rather than with the message identity because
 * `session_messages.sealed_sequence` references `message_updates`: a seal
 * declared on the identity row would name a row that has not crossed yet.
 */
export const ForkMessageUpdateRowSchema = v.object({
  message_id: v.string(),
  sequence: v.number(),
  part_no: v.nullable(v.number()),
  operation: v.picklist(['open', 'append', 'envelope-metadata', 'metadata', 'content-end', 'replace-content']),
  payload_json: v.nullable(v.string()),
  payload_path: v.nullable(v.string()),
  payload_digest: v.nullable(v.string()),
  seals: v.boolean(),
});

/**
 * One entry of the carried public chain, root first.
 *
 * `session_id` is not carried: the chain is by definition the chat session's,
 * and the write stamps it. The context columns are not carried either — they
 * name revisions of the SOURCE's context history, which does not cross; the
 * write points the cut entry at the fork's own fresh context instead.
 */
export const ForkConversationEntryRowSchema = v.object({
  id: v.string(),
  parent_id: v.nullable(v.string()),
  role: v.picklist(['user', 'assistant', 'system', 'tool']),
  turn_id: v.nullable(v.string()),
  run_id: v.nullable(v.string()),
  metadata_json: v.nullable(v.string()),
  metadata_path: v.nullable(v.string()),
  metadata_digest: v.nullable(v.string()),
  recorded_at: v.number(),
});

/** One part reference of one carried entry: which message, which part, and the
 *  cutoff the entry was recorded against. */
export const ForkConversationEntryPartRowSchema = v.object({
  entry_id: v.string(),
  position: v.number(),
  message_id: v.string(),
  part_no: v.number(),
  through_sequence: v.number(),
  text_start: v.nullable(v.number()),
  text_length: v.nullable(v.number()),
});

/** One member of the working context the cut entry recorded, at the revision it
 *  recorded. Positions are preserved: the membership IS the model's message
 *  order. */
export const ForkContextMemberRowSchema = v.object({
  entry_id: v.string(),
  position: v.number(),
  message_id: v.string(),
  through_sequence: v.number(),
});

/** One row of the FTS content table behind memory search. */
export const ForkMemoryChunkRowSchema = v.object({
  id: v.string(),
  path: v.string(),
  start_line: v.number(),
  end_line: v.number(),
  hash: v.string(),
  text: v.string(),
  updated_at: v.number(),
});

/** One crafted tool, snapshotted — the fork evolves it independently. */
export const ForkCraftedToolRowSchema = v.object({
  name: v.string(),
  description: v.string(),
  params: v.nullable(v.string()),
  code: v.string(),
  scope: v.string(),
  created_at: v.number(),
  updated_at: v.number(),
});

/** One actor_config row. The shell-approval authority keys never appear here:
 *  they are withheld at the READ, in {@link snapshotWorkspaceForFork}. */
export const ForkConfigRowSchema = v.object({ key: v.string(), value: v.string() });

/** One inherited file. A fork carries FILES, read through the workspace
 *  filesystem rather than lifted out of one storage engine's row encoding. */
export const ForkFileSchema = v.object({ path: v.string(), content: v.string() });

/**
 * The whole of what a fork copies, in one value.
 *
 * This is what the IN-PROCESS fork uses, where both databases are open in the
 * same process and there is no wire to bound. A hosted fork never materializes
 * it on either side — see `identity/fork-transfer.ts`.
 *
 * `artifacts` are the payload files the carried rows reference, by a path
 * relative to the artifact directory that owns them; `files` are workspace
 * paths. Two lists rather than one flagged list, because the two paths are read
 * against different roots and a single list would make that depend on a field.
 */
export const ForkSnapshotSchema = v.object({
  ...ForkSnapshotHeadSchema.entries,
  sessionMessages: v.array(ForkSessionMessageRowSchema),
  messageParts: v.array(ForkMessagePartRowSchema),
  messageUpdates: v.array(ForkMessageUpdateRowSchema),
  conversationEntries: v.array(ForkConversationEntryRowSchema),
  conversationEntryParts: v.array(ForkConversationEntryPartRowSchema),
  contextMembers: v.array(ForkContextMemberRowSchema),
  files: v.array(ForkFileSchema),
  artifacts: v.array(ForkFileSchema),
  memoryChunks: v.array(ForkMemoryChunkRowSchema),
  craftedTools: v.array(ForkCraftedToolRowSchema),
  agentConfig: v.array(ForkConfigRowSchema),
});

export type ForkSnapshotHead = v.InferOutput<typeof ForkSnapshotHeadSchema>;

export type ForkSnapshot = v.InferOutput<typeof ForkSnapshotSchema>;

export type ForkSessionMessageRow = v.InferOutput<typeof ForkSessionMessageRowSchema>;

export type ForkMessagePartRow = v.InferOutput<typeof ForkMessagePartRowSchema>;

export type ForkMessageUpdateRow = v.InferOutput<typeof ForkMessageUpdateRowSchema>;

export type ForkConversationEntryRow = v.InferOutput<typeof ForkConversationEntryRowSchema>;

export type ForkConversationEntryPartRow = v.InferOutput<typeof ForkConversationEntryPartRowSchema>;

export type ForkContextMemberRow = v.InferOutput<typeof ForkContextMemberRowSchema>;

export type ForkMemoryChunkRow = v.InferOutput<typeof ForkMemoryChunkRowSchema>;

export type ForkCraftedToolRow = v.InferOutput<typeof ForkCraftedToolRowSchema>;

export type ForkConfigRow = v.InferOutput<typeof ForkConfigRowSchema>;

export type ForkFile = v.InferOutput<typeof ForkFileSchema>;

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

export interface ForkResult {
  forkPointMs: number;
  messagesCopied: number;
  craftedToolsCopied: number;
}

/** One carried message and the cutoff every carried reference to it respects:
 *  the highest `through_sequence` any carried entry part or context member
 *  names for it. Updates past it do not cross, so no carried reference can
 *  point past what landed. */
export interface ForkCarriedMessage {
  readonly messageId: string;
  readonly cutoff: number;
}

/**
 * Which rows one cut selects, decided once.
 *
 * Both halves of the fork run this: the in-process snapshot materializes the
 * rows it names, and the wire streams them. It holds identities and cutoffs —
 * never row CONTENT — so the plan of an unbounded workspace is bounded by its
 * chain, and the content stays where the framing can bound it.
 */
export interface ForkConversationPlan {
  readonly cut: { readonly entryId: string; readonly recordedAt: number };
  /** The cut entry's ancestry, root first. */
  readonly entryIds: readonly string[];
  /** Carried messages in the source's own insertion order, so a tool result
   *  never precedes the call its part references. */
  readonly messages: readonly ForkCarriedMessage[];
  /** The membership of the cut entry's context revision, by position. Empty
   *  where no entry in the chain recorded a context. */
  readonly members: readonly ForkContextMemberRow[];
  /** Payload files the carried rows reference, relative to the source artifact
   *  directory, deduplicated. */
  readonly artifacts: readonly string[];
}

/** How many rows each conversation section carries. Declared by the source and
 *  checked against what the target took. */
export interface ForkConversationCounts {
  sessionMessages: number;
  messageParts: number;
  messageUpdates: number;
  conversationEntries: number;
  conversationEntryParts: number;
  contextMembers: number;
}

interface ForkChainEntryRow {
  id: string;
  parent_id: string | null;
  recorded_at: number;
  metadata_path: string | null;
  context_id: string | null;
  context_revision: number | null;
}

function assertArtifactSegments(relative: string, path: string, root: string): void {
  const traversal = relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');

  if (relative.startsWith('/') || traversal) {
    throw new Error(
      `fork cannot carry payload ${JSON.stringify(path)}: it does not name a file inside the artifact `
      + `directory ${JSON.stringify(root)}`,
    );
  }
}

/**
 * One payload path as the wire carries it: relative to the artifact directory
 * that owns it.
 *
 * A path outside that directory is REFUSED rather than carried. Payload
 * references are absolute, and an absolute path from another workspace's plane
 * would either be re-rooted into a file the fork does not have or copied
 * verbatim into a directory it does not own.
 */
export function forkArtifactRelativePath(path: string, artifactDirectory: string): string {
  // One trailing-separator rule for both directions, so `/a/b` and `/a/b/`
  // relativize and re-root identically.
  const root = artifactDirectory.endsWith('/') ? artifactDirectory.slice(0, -1) : artifactDirectory;
  const prefix = `${root}/`;

  if (!path.startsWith(prefix)) {
    throw new Error(
      `fork cannot carry payload ${JSON.stringify(path)}: it is outside the artifact directory `
      + `${JSON.stringify(root)}`,
    );
  }

  const relative = path.slice(prefix.length);
  assertArtifactSegments(relative, path, root);

  return relative;
}

/** The absolute payload path a carried relative path names under one artifact
 *  directory — the source read and the target write, one rule. */
export function forkArtifactPath(relative: string, artifactDirectory: string): string {
  const root = artifactDirectory.endsWith('/') ? artifactDirectory.slice(0, -1) : artifactDirectory;
  assertArtifactSegments(relative, relative, root);

  return `${root}/${relative}`;
}

/**
 * Which rows the cut at `untilMessageId` selects.
 *
 * Throws if the id is not an entry of the source's chat session — the one
 * failure worth surfacing before a target workspace is created, and the failure
 * the operator hits. The cut resolves against `conversation_entries` because
 * that is the tree the operator's id comes from.
 */
export function planForkConversation(input: {
  readonly sql: SqlExecutor;
  readonly actorId: string;
  readonly untilMessageId: string;
  readonly artifactDirectory: string;
}): ForkConversationPlan {
  const { sql, actorId, untilMessageId } = input;
  const chain: ForkChainEntryRow[] = [];
  const walked = new Set<string>();
  let at: string | null = untilMessageId;

  while (at !== null) {
    if (walked.has(at)) {
      throw new Error(`fork chain for entry ${JSON.stringify(untilMessageId)} revisits ${JSON.stringify(at)}`);
    }

    if (chain.length >= FORK_CHAIN_MAX_DEPTH) {
      throw new Error(`fork chain for entry ${JSON.stringify(untilMessageId)} is deeper than ${FORK_CHAIN_MAX_DEPTH} entries`);
    }

    walked.add(at);

    // Keyed on the actor at every hop: a workspace database holds every actor
    // it issued, and entry ids are minted per actor, so an unkeyed hop could
    // climb out of this conversation into a sibling's.
    const row: ForkChainEntryRow | undefined = sql<ForkChainEntryRow>`
      SELECT id, parent_id, recorded_at, metadata_path, context_id, context_revision
      FROM conversation_entries
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${at}
    `[0];

    if (row === undefined) {
      if (chain.length === 0) {
        throw new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`);
      }

      throw new Error(
        `fork chain for entry ${JSON.stringify(untilMessageId)} names a parent `
        + `${JSON.stringify(at)} the source does not have`,
      );
    }

    chain.push(row);
    at = row.parent_id;
  }

  chain.reverse();
  const cutEntry = chain[chain.length - 1];

  if (cutEntry === undefined) {
    throw new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`);
  }

  const context = [...chain].reverse().find((entry) => entry.context_id !== null && entry.context_revision !== null);

  // The membership AT that revision, not the live one: an entry pruned after
  // the cut is still what the cut's model context held.
  const members = context === undefined || context.context_id === null || context.context_revision === null
    ? []
    : sql<ForkContextMemberRow>`
        SELECT entry_id, position, message_id, through_sequence FROM context_memberships
        WHERE actor_id = ${actorId} AND context_id = ${context.context_id}
          AND from_revision <= ${context.context_revision}
          AND (to_revision IS NULL OR to_revision > ${context.context_revision})
        ORDER BY position
      `.map((row) => v.parse(ForkContextMemberRowSchema, row));

  const cutoffs = new Map<string, number>();

  const reference = (messageId: string, sequence: number): void => {
    const known = cutoffs.get(messageId);

    if (known === undefined || sequence > known) cutoffs.set(messageId, sequence);
  };

  for (const entry of chain) {
    for (const part of forkConversationEntryPartRows(sql, actorId, entry.id)) {
      reference(part.message_id, part.through_sequence);
    }
  }

  for (const member of members) reference(member.message_id, member.through_sequence);

  // A carried tool result is unreadable without the call it answers: the
  // reader resolves the result's toolCallId out of the call's own `open`
  // payload. So a referenced reply target is carried too, whether or not the
  // chain or the context named it.
  const pending = [...cutoffs.keys()];

  for (;;) {
    const messageId = pending.pop();

    if (messageId === undefined) break;

    for (const reply of sql<{ reply_to_message_id: string }>`
      SELECT DISTINCT reply_to_message_id FROM message_parts
      WHERE actor_id = ${actorId} AND message_id = ${messageId} AND reply_to_message_id IS NOT NULL
    `) {
      if (cutoffs.has(reply.reply_to_message_id)) continue;

      const head = sql<{ sealed_sequence: number | null; head_sequence: number | null }>`
        SELECT m.sealed_sequence,
               (SELECT MAX(u.sequence) FROM message_updates u
                 WHERE u.actor_id = m.actor_id AND u.message_id = m.message_id) AS head_sequence
        FROM session_messages m WHERE m.actor_id = ${actorId} AND m.message_id = ${reply.reply_to_message_id}
      `[0];

      const cutoff = head?.sealed_sequence ?? head?.head_sequence ?? null;

      if (cutoff === null) {
        throw new Error(
          `fork cannot carry message ${JSON.stringify(messageId)}: the call it answers `
          + `(${JSON.stringify(reply.reply_to_message_id)}) has no recorded content in the source`,
        );
      }

      cutoffs.set(reply.reply_to_message_id, cutoff);
      pending.push(reply.reply_to_message_id);
    }
  }

  const ordered = [...cutoffs].map(([messageId, cutoff]) => {
    const row = sql<{ seek: number }>`
      SELECT rowid AS seek FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
    `[0];

    if (row === undefined) {
      throw new Error(`fork carries a reference to message ${JSON.stringify(messageId)}, which the source does not have`);
    }

    return { messageId, cutoff, seek: row.seek };
  }).sort((left, right) => left.seek - right.seek)
    .map(({ messageId, cutoff }) => ({ messageId, cutoff }));

  const artifacts: string[] = [];
  const carried = new Set<string>();

  const carry = (path: string | null): void => {
    if (path === null) return;
    const relative = forkArtifactRelativePath(path, input.artifactDirectory);

    if (carried.has(relative)) return;
    carried.add(relative);
    artifacts.push(relative);
  };

  for (const entry of chain) carry(entry.metadata_path);

  for (const message of ordered) {
    for (const row of sql<{ payload_path: string }>`
      SELECT payload_path FROM message_updates
      WHERE actor_id = ${actorId} AND message_id = ${message.messageId}
        AND sequence <= ${message.cutoff} AND payload_path IS NOT NULL
      ORDER BY sequence
    `) carry(row.payload_path);
  }

  return {
    cut: { entryId: cutEntry.id, recordedAt: cutEntry.recorded_at },
    entryIds: chain.map((entry) => entry.id),
    messages: ordered,
    members,
    artifacts,
  };
}

/** One carried message's identity row. */
export function forkSessionMessageRow(
  sql: SqlExecutor, actorId: string, messageId: string,
): ForkSessionMessageRow {
  const row = sql<ForkSessionMessageRow>`
    SELECT message_id, role, native_content_kind, origin, recorded_at
    FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
  `[0];

  if (row === undefined) {
    throw new Error(`fork carries a reference to message ${JSON.stringify(messageId)}, which the source does not have`);
  }

  return v.parse(ForkSessionMessageRowSchema, row);
}

/** One carried message's part identities, by part number. */
export function forkMessagePartRows(
  sql: SqlExecutor, actorId: string, messageId: string,
): ForkMessagePartRow[] {
  return sql<ForkMessagePartRow>`
    SELECT message_id, part_no, kind, reply_to_message_id, reply_to_part_no, stream_order
    FROM message_parts WHERE actor_id = ${actorId} AND message_id = ${messageId} ORDER BY part_no
  `.map((row) => v.parse(ForkMessagePartRowSchema, row));
}

/** One carried message's updates up to its cutoff, with payload paths made
 *  relative and the seal marked on the update that carries it. */
export function forkMessageUpdateRows(
  sql: SqlExecutor, actorId: string, message: ForkCarriedMessage, artifactDirectory: string,
): ForkMessageUpdateRow[] {
  return sql<{
    message_id: string; sequence: number; part_no: number | null; operation: string;
    payload_json: string | null; payload_path: string | null; payload_digest: string | null;
    sealed_sequence: number | null;
  }>`
    SELECT u.message_id, u.sequence, u.part_no, u.operation, u.payload_json, u.payload_path, u.payload_digest,
           (SELECT m.sealed_sequence FROM session_messages m
             WHERE m.actor_id = u.actor_id AND m.message_id = u.message_id) AS sealed_sequence
    FROM message_updates u
    WHERE u.actor_id = ${actorId} AND u.message_id = ${message.messageId} AND u.sequence <= ${message.cutoff}
    ORDER BY u.sequence
  `.map((row) => v.parse(ForkMessageUpdateRowSchema, {
    message_id: row.message_id,
    sequence: row.sequence,
    part_no: row.part_no,
    operation: row.operation,
    payload_json: row.payload_json,
    payload_path: row.payload_path === null ? null : forkArtifactRelativePath(row.payload_path, artifactDirectory),
    payload_digest: row.payload_digest,
    seals: row.sealed_sequence === row.sequence,
  }));
}

/** One carried entry of the public chain. */
export function forkConversationEntryRow(
  sql: SqlExecutor, actorId: string, entryId: string, artifactDirectory: string,
): ForkConversationEntryRow {
  const row = sql<{
    id: string; parent_id: string | null; role: string; turn_id: string | null; run_id: string | null;
    metadata_json: string | null; metadata_path: string | null; metadata_digest: string | null; recorded_at: number;
  }>`
    SELECT id, parent_id, role, turn_id, run_id, metadata_json, metadata_path, metadata_digest, recorded_at
    FROM conversation_entries
    WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${entryId}
  `[0];

  if (row === undefined) {
    throw new Error(`fork carries entry ${JSON.stringify(entryId)}, which the source does not have`);
  }

  return v.parse(ForkConversationEntryRowSchema, {
    ...row,
    metadata_path: row.metadata_path === null ? null : forkArtifactRelativePath(row.metadata_path, artifactDirectory),
  });
}

/** One carried entry's part references, by position. */
export function forkConversationEntryPartRows(
  sql: SqlExecutor, actorId: string, entryId: string,
): ForkConversationEntryPartRow[] {
  return sql<ForkConversationEntryPartRow>`
    SELECT entry_id, position, message_id, part_no, through_sequence, text_start, text_length
    FROM conversation_entry_parts
    WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND entry_id = ${entryId}
    ORDER BY position
  `.map((row) => v.parse(ForkConversationEntryPartRowSchema, row));
}

/** What a plan will produce, per section, counted over the same predicates the
 *  readers select on — so a declaration and a stream cannot disagree. */
export function forkConversationCounts(
  sql: SqlExecutor, actorId: string, plan: ForkConversationPlan,
): ForkConversationCounts {
  let messageParts = 0;
  let messageUpdates = 0;

  for (const message of plan.messages) {
    messageParts += sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM message_parts WHERE actor_id = ${actorId} AND message_id = ${message.messageId}
    `[0]?.total ?? 0;

    messageUpdates += sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM message_updates
      WHERE actor_id = ${actorId} AND message_id = ${message.messageId} AND sequence <= ${message.cutoff}
    `[0]?.total ?? 0;
  }

  let conversationEntryParts = 0;

  for (const entryId of plan.entryIds) {
    conversationEntryParts += sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM conversation_entry_parts
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND entry_id = ${entryId}
    `[0]?.total ?? 0;
  }

  return {
    sessionMessages: plan.messages.length,
    messageParts,
    messageUpdates,
    conversationEntries: plan.entryIds.length,
    conversationEntryParts,
    contextMembers: plan.members.length,
  };
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
    sessionMessages: plan.messages.map((message) => forkSessionMessageRow(source.sql, actorId, message.messageId)),
    messageParts: plan.messages.flatMap((message) => forkMessagePartRows(source.sql, actorId, message.messageId)),
    messageUpdates: plan.messages.flatMap(
      (message) => forkMessageUpdateRows(source.sql, actorId, message, source.artifactDirectory),
    ),
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

/** Where a fork lands, and how. */
export interface ForkWriteTarget {
  workspaceId: string;
  workspaceName: string;
  /** Where the TARGET actor's payload files live. Carried payload references
   *  and carried payload FILES are re-rooted here, so the fork reads its own
   *  plane rather than the workspace it came from. */
  artifactDirectory: string;
  now?: number;
  /** Hosted workspaces establish their owner before the external VFS copy;
   *  carry it through the identity rewrite so the row and file namespace
   *  cannot diverge. Local backends omit it. */
  ownerUserId?: string;
  /** Hosted workspaces use their owner-only filesystem writer for SOUL.md;
   *  every other inherited file remains an ordinary workspace write. */
  writeSoulFile?: (content: string) => Promise<void>;
  /**
   * Runs the PUBLICATION atomically.
   *
   * Staged rows and files are written outside it and cannot be inside it: a
   * host transaction is synchronous, and the filesystem is not. What has to be
   * atomic is the moment the target BECOMES the fork — identity, lineage,
   * marker, display name — because that is the only state anything else
   * observes. Everything before it is staging in a workspace nothing can reach.
   */
  transaction?: (rows: () => void) => void;
}

/** How much a writer has taken. The wire checks this against what the source
 *  declared before it publishes. */
export interface ForkStagedCounts {
  agentConfig: number;
  craftedTools: number;
  memoryChunks: number;
  sessionMessages: number;
  messageParts: number;
  messageUpdates: number;
  conversationEntries: number;
  conversationEntryParts: number;
  contextMembers: number;
  files: number;
}

/**
 * The fork write, as stage-then-publish.
 *
 * A hosted fork arrives as bounded batches over a wire (see
 * `identity/fork-transfer.ts`), so the write cannot be one call over one value.
 * It is {@link ForkTargetWriter.begin}, a `stage` call per batch, then
 * {@link ForkTargetWriter.publish} — and the target is not a fork until
 * `publish` runs. Before it there is no lineage, no fork marker, no mission and
 * no display name, so `readForkLineage` answers null and nothing downstream
 * treats the workspace as forked.
 *
 * THE STAGE ORDER IS THE FOREIGN-KEY ORDER. Message identities precede their
 * parts, parts precede the updates that reference them, entries precede their
 * part references, and the context membership lands last — so each statement
 * commits against rows that already exist. Nothing here relies on a deferred
 * constraint, because a hosted transfer stages one frame per RPC and has no
 * transaction spanning the sections.
 *
 * The in-process fork drives the same methods over a whole snapshot; see
 * {@link writeForkSnapshot}. There is one write, driven two ways.
 */
export class ForkTargetWriter {
  private readonly now: number;
  /**
   * Everything this write remembers about the transfer in progress.
   *
   * A hosted fork's frames arrive on several activations of one Durable Object,
   * so the accounting, the head and the mission are read back out of the target
   * rather than held in fields — see {@link ForkStagingState}. Readable because
   * the wire's receiver owns its own columns of the same row and there is one
   * accessor onto it, not two.
   */
  readonly staging: ForkStagingState;

  constructor(
    private readonly target: SqlExecutor,
    private readonly targetVfs: VFS,
    private readonly opts: ForkWriteTarget,
  ) {
    this.now = opts.now ?? Date.now();
    this.staging = new ForkStagingState(target);
  }

  /**
   * The target's own main actor.
   *
   * Resolved on demand rather than captured in the constructor: {@link begin}
   * is what CREATES this actor on a target that had no identity yet, so a field
   * read at construction would name an actor that does not exist.
   */
  private get actorId(): string {
    return openWorkspaceMainActor(this.target).actorId;
  }

  /** The target-side destination of one carried payload file. The receiver
   *  resolves an artifact frame's relative path through this, so the staging
   *  list, the sink and the SQL references all name one path. */
  artifactPath(relative: string): string {
    return forkArtifactPath(relative, this.opts.artifactDirectory);
  }

  /**
   * Record which fork this is, and reset what this write has taken.
   *
   * One row, one statement. The destructive half is {@link clearStagedRows},
   * and the two are separate because they belong at different moments:
   * accounting has to be reset before the first FILE lands, and the rows a
   * previous attempt left have to be deleted where the caller's transaction can
   * still roll the deletion back.
   */
  begin(head: ForkSnapshotHead): void {
    const current = this.target<{ id: string; owner_user_id: string }>`SELECT id, owner_user_id FROM workspace_identity`[0];

    if (!current) {
      void this.target`INSERT INTO workspace_identity(id,name,owner_user_id,created_at) VALUES (${this.opts.workspaceId},${this.opts.workspaceName},${this.opts.ownerUserId ?? ''},${this.now})`;
      new WorkspaceActorDirectory(this.target, { workspaceId: this.opts.workspaceId, ownerUserId: this.opts.ownerUserId ?? '' }).createMain({ name: this.opts.workspaceName });
    } else {
      if (current.id !== this.opts.workspaceId) throw new KinuError('denied', 'The fork target does not match its durable workspace identity.');
      openWorkspaceMainActor(this.target);
    }

    this.staging.begin(head);
  }

  /**
   * Delete every row this write owns, so a retry self-heals: an abandoned
   * staging state from an earlier attempt is gone before a row of this one
   * lands, and nothing has to detect that it was there.
   *
   * Children before parents, and the two edges that point FORWARD — a message's
   * seal into its updates, a part's reply into another part — are released
   * first, so the deletion needs no deferred constraint either.
   *
   * `workspace_identity` is deliberately NOT cleared. On a hosted target the
   * owner row is the precondition for the target's own file plane — the Nimbus
   * namespace is derived from it — so it exists before staging and is rewritten
   * in {@link ForkTargetWriter.publishRows}, the moment the target becomes a
   * fork.
   */
  clearStagedRows(): void {
    const actorId = this.actorId;
    void this.target`DELETE FROM crafted_tools`;
    void this.target`DELETE FROM memory_chunks`;
    void this.target`DELETE FROM actor_config WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM fork_lineage`;
    void this.target`DELETE FROM conversation_heads WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM conversation_entry_parts WHERE actor_id = ${actorId}`;
    // The chain is a tree of rows referencing each other, and one DELETE removes
    // them in storage order: a parent can go before its child. Releasing the
    // edges first is what makes the deletion legal without a deferred check.
    void this.target`UPDATE conversation_entries SET parent_id = ${null} WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM conversation_entries WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM context_memberships WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM actor_context_selection WHERE actor_id = ${actorId}`;
    void this.target`UPDATE actor_contexts SET fork_context_id = ${null}, fork_revision = ${null} WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM context_revisions WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM actor_contexts WHERE actor_id = ${actorId}`;
    void this.target`UPDATE session_messages SET sealed_sequence = ${null} WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM message_updates WHERE actor_id = ${actorId}`;
    void this.target`UPDATE message_parts SET reply_to_message_id = ${null}, reply_to_part_no = ${null} WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM message_parts WHERE actor_id = ${actorId}`;
    void this.target`DELETE FROM session_messages WHERE actor_id = ${actorId}`;
  }

  stageAgentConfig(rows: readonly ForkConfigRow[]): void {
    const config = openWorkspaceMainActor(this.target).config;

    for (const row of rows) config.set(row.key, row.value);
    this.staging.count({ agentConfig: rows.length });
  }

  stageCraftedTools(rows: readonly ForkCraftedToolRow[]): void {
    for (const t of rows) {
      void this.target`
        INSERT OR REPLACE INTO crafted_tools
        (name, description, params, code, scope, created_at, updated_at)
        VALUES (${t.name}, ${t.description}, ${t.params}, ${t.code}, ${t.scope}, ${t.created_at}, ${t.updated_at})
      `;
    }

    this.staging.count({ craftedTools: rows.length });
  }

  /** The FTS content table behind memory search. Part of every workspace's
   *  schema, so a failure here means the fork lost the parent's memory index,
   *  not that there was nothing to copy. */
  stageMemoryChunks(rows: readonly ForkMemoryChunkRow[]): void {
    for (const c of rows) {
      void this.target`
        INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, updated_at)
        VALUES (${c.id}, ${c.path}, ${c.start_line}, ${c.end_line}, ${c.hash}, ${c.text}, ${c.updated_at})
      `;
    }

    this.staging.count({ memoryChunks: rows.length });
  }

  /** Carried message identities, under THIS target's actor. The execution
   *  identity of the source turn does not cross: no request, no output slot, no
   *  ingress id, and no seal until the update that seals it has landed. */
  stageSessionMessages(rows: readonly ForkSessionMessageRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO session_messages
        (actor_id, message_id, role, native_content_kind, origin, request_id, output_slot, ingress_id, sealed_sequence, recorded_at)
        VALUES (${actorId}, ${row.message_id}, ${row.role}, ${row.native_content_kind}, ${row.origin},
                ${null}, ${null}, ${null}, ${null}, ${row.recorded_at})
      `;
    }

    this.staging.count({ sessionMessages: rows.length });
  }

  stageMessageParts(rows: readonly ForkMessagePartRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO message_parts
        (actor_id, message_id, part_no, kind, reply_to_message_id, reply_to_part_no, stream_order)
        VALUES (${actorId}, ${row.message_id}, ${row.part_no}, ${row.kind},
                ${row.reply_to_message_id}, ${row.reply_to_part_no}, ${row.stream_order})
      `;
    }

    this.staging.count({ messageParts: rows.length });
  }

  /** Carried updates, with each payload reference re-rooted under the target's
   *  artifact directory and each seal applied the moment the update it names
   *  exists. */
  stageMessageUpdates(rows: readonly ForkMessageUpdateRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO message_updates
        (actor_id, message_id, sequence, part_no, operation, payload_json, payload_path, payload_digest)
        VALUES (${actorId}, ${row.message_id}, ${row.sequence}, ${row.part_no}, ${row.operation},
                ${row.payload_json},
                ${row.payload_path === null ? null : this.artifactPath(row.payload_path)},
                ${row.payload_digest})
      `;

      if (!row.seals) continue;
      void this.target`
        UPDATE session_messages SET sealed_sequence = ${row.sequence}
        WHERE actor_id = ${actorId} AND message_id = ${row.message_id}
      `;
    }

    this.staging.count({ messageUpdates: rows.length });
  }

  /** The public chain, root first — the tree carried verbatim under this
   *  target's actor. The context columns stay null here; the publication points
   *  the cut entry at the fork's own context. */
  stageConversationEntries(rows: readonly ForkConversationEntryRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO conversation_entries
        (actor_id, session_id, id, parent_id, role, turn_id, run_id,
         metadata_json, metadata_path, metadata_digest, recorded_at, context_id, context_revision)
        VALUES (${actorId}, ${CHAT_SESSION_ID}, ${row.id}, ${row.parent_id}, ${row.role},
                ${row.turn_id}, ${row.run_id}, ${row.metadata_json},
                ${row.metadata_path === null ? null : this.artifactPath(row.metadata_path)},
                ${row.metadata_digest}, ${row.recorded_at}, ${null}, ${null})
      `;
    }

    this.staging.count({ conversationEntries: rows.length });
  }

  stageConversationEntryParts(rows: readonly ForkConversationEntryPartRow[]): void {
    const actorId = this.actorId;

    for (const row of rows) {
      void this.target`
        INSERT INTO conversation_entry_parts
        (actor_id, session_id, entry_id, position, message_id, part_no, through_sequence, text_start, text_length)
        VALUES (${actorId}, ${CHAT_SESSION_ID}, ${row.entry_id}, ${row.position}, ${row.message_id},
                ${row.part_no}, ${row.through_sequence}, ${row.text_start}, ${row.text_length})
      `;
    }

    this.staging.count({ conversationEntryParts: rows.length });
  }

  /** The restored working context: one revision of one fresh context, whose
   *  membership is what the cut entry's revision selected, in its positions. */
  stageContextMembers(rows: readonly ForkContextMemberRow[]): void {
    const actorId = this.actorId;
    const contextId = this.forkContext(actorId);

    for (const row of rows) {
      void this.target`
        INSERT INTO context_memberships
        (actor_id, context_id, entry_id, from_revision, to_revision, position, message_id, through_sequence)
        VALUES (${actorId}, ${contextId}, ${row.entry_id}, ${FORK_CONTEXT_REVISION}, ${null},
                ${row.position}, ${row.message_id}, ${row.through_sequence})
      `;
    }

    this.staging.count({ contextMembers: rows.length });
  }

  /**
   * One inherited file, whole.
   *
   * Whole rather than ranged because {@link VFS} has no append — `writeFile` is
   * the only write there is. So the caller assembles ONE file at a time and the
   * peak is that file, never the snapshot. SOUL.md also yields the fork mission
   * here, taken while the content is in hand rather than by reading the file
   * back at publish.
   *
   * `artifact` names a carried payload file, whose path is relative to the
   * artifact directory that owns it — the same flag the wire's file frame
   * carries, so one staging path serves both kinds.
   */
  async stageFile(path: string, content: string, artifact = false): Promise<void> {
    const destination = artifact ? this.artifactPath(path) : path;
    this.staging.addFile(destination);
    const dir = destination.slice(0, destination.lastIndexOf('/'));

    if (dir) await this.targetVfs.mkdir(dir, { recursive: true });

    if (!artifact && destination === SOUL_PATH) this.staging.mission(summarizeSoul(content));

    if (!artifact && destination === SOUL_PATH && this.opts.writeSoulFile) await this.opts.writeSoulFile(content);
    else await this.targetVfs.writeFile(destination, content);
    this.staging.count({ files: 1 });
  }

  /**
   * Record an inherited file that a fork-specific native sink already published.
   *
   * The streamed receiver never materializes ordinary files merely to hand them
   * back to this writer. SOUL is deliberately excluded: its protected writer
   * returns the mission after it has accepted the file.
   */
  stageCommittedFile(path: string, mission?: string): void {
    if (path === SOUL_PATH) {
      if (mission === undefined) throw new Error('fork transfer committed SOUL.md without its protected write');
      this.staging.mission(mission);
    }

    this.staging.addFile(path);
    this.staging.count({ files: 1 });
  }

  /**
   * Remove the exact files a prior unpublished transfer staged.
   *
   * The receiver calls this before a replacement `begin`. The list is the
   * target's own `fork_staged_files` rows, so it survives the activation that
   * wrote them: an abandoned attempt's files are removed by the transfer that
   * replaces it, whichever isolate that one runs in.
   */
  async clearStagedFiles(): Promise<void> {
    for (const path of this.staging.files()) {
      if (await this.targetVfs.exists(path)) await this.targetVfs.unlink(path);
    }

    this.staging.dropFiles();
  }

  /** How much has been taken, for the completeness check the wire performs
   *  before it publishes. Read from the target, so it counts what LANDED rather
   *  than what one activation happened to see. */
  get staged(): ForkStagedCounts {
    return this.staging.read()?.staged ?? {
      agentConfig: 0, craftedTools: 0, memoryChunks: 0,
      sessionMessages: 0, messageParts: 0, messageUpdates: 0,
      conversationEntries: 0, conversationEntryParts: 0, contextMembers: 0,
      files: 0,
    };
  }

  /** The fork this target has ALREADY published, if it has. The wire answers a
   *  re-delivered frame with this rather than refusing one that is already
   *  correct — including on an activation that never saw the commit. */
  get published(): ForkResult | null {
    const staged = this.staging.read();

    return staged === null || !staged.published || staged.head === null
      ? null
      : forkResultOf(staged.head, staged.staged);
  }

  /** Publish, atomically. Everything staged becomes a fork here and nowhere
   *  else. */
  async publish(): Promise<ForkResult> {
    if (!this.opts.transaction) return this.publishRows();
    let result: ForkResult | null = null;
    this.opts.transaction(() => { result = this.publishRows(); });

    if (result === null) throw new Error('fork publication transaction produced no result');

    return result;
  }

  /**
   * The publication, as one synchronous unit — what a caller wraps in a host
   * transaction. Public because the in-process write puts the staging AND the
   * publication inside one transaction, which is what makes a mid-write failure
   * there leave no fork at all.
   */
  publishRows(): ForkResult {
    const staged = this.staging.read();
    const head = staged?.head ?? null;

    if (staged === null || head === null) {
      throw new Error('fork publication attempted before the transfer declared its head');
    }

    const forkPointMs = head.cut.createdAtMs;
    const actorId = this.actorId;

    // 1. Identity: new id, new name, fresh created_at. The owner carries through
    //    so the row and the file namespace cannot diverge.
    void this.target`DELETE FROM workspace_identity`;

    if (this.opts.ownerUserId) {
      void this.target`
        INSERT INTO workspace_identity (id, name, owner_user_id, created_at)
        VALUES (${this.opts.workspaceId}, ${this.opts.workspaceName}, ${this.opts.ownerUserId}, ${this.now})
      `;
    } else {
      void this.target`
        INSERT INTO workspace_identity (id, name, created_at)
        VALUES (${this.opts.workspaceId}, ${this.opts.workspaceName}, ${this.now})
      `;
    }

    void this.target`UPDATE workspace_identity SET mission = ${staged.mission}`;

    // 2. The derived search index keyed on the OLD rows is stale by
    //    construction — purged and reseeded at equal counts is exactly what its
    //    rowid watermark cannot see. Invalidate deterministically; the next
    //    search rebuilds.
    invalidateConversationSearchIndex(this.target);

    // 3. display_name, so the UI shows the fork rather than the bootstrap.
    openWorkspaceMainActor(this.target).config.setDisplayName(this.opts.workspaceName);

    // 4. Lineage — single row, and the thing that makes this workspace a fork.
    void this.target`
      INSERT INTO fork_lineage
      (id, source_workspace_id, source_workspace_name, source_message_id, source_message_created_at, forked_at)
      VALUES
      (1, ${head.source.workspaceId}, ${head.source.workspaceName},
       ${head.cut.messageId}, ${forkPointMs}, ${this.now})
    `;

    // 5. The working context this fork starts from. Always present: an actor
    //    without a selected context has nothing to read, and a fork whose cut
    //    recorded no context starts from an empty one rather than from none.
    const contextId = this.forkContext(actorId);

    const cut = this.target<{ id: string }>`
      SELECT id FROM conversation_entries
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
    `[0]?.id ?? null;

    if (cut !== null) {
      // The cut entry names the fork's context, so a fork taken AT this
      // boundary later restores the same membership rather than walking past it.
      void this.target`
        UPDATE conversation_entries SET context_id = ${contextId}, context_revision = ${FORK_CONTEXT_REVISION}
        WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${head.cut.messageId}
      `;

    }

    // 6. The fork marker: one system-role entry parented on the cut point, so
    //    the chat shows a visible boundary between inherited history and the
    //    fork's own future turns. It is a node of the public chain and nothing
    //    else — it is deliberately not a context member, because a copy the
    //    model never reads is not context, it is a row.
    const syntheticText =
      `You were forked from workspace "${head.source.workspaceName}" at message ${head.cut.messageId} on `
      + `${new Date(this.now).toISOString()}. The conversation above happened before the fork. `
      + `Your current tool set and memory are authoritative; ignore any tools or context `
      + `referenced before the fork that you don't see in your active tool list.`;

    const markerId = `fork-marker-${this.opts.workspaceId.slice(0, 8)}-${this.now}`;
    this.writeForkMarker(actorId, markerId, cut, syntheticText, forkPointMs + 1);
    // The marker is the chain's end: the fork's first turn chains from it.
    void this.target`INSERT INTO conversation_heads (actor_id, session_id, entry_id) VALUES (${actorId}, ${CHAT_SESSION_ID}, ${markerId})`;

    // The staged files are the fork's files now, so the cleanup list is spent.
    // The transfer row is NOT: it is what answers a frame re-delivered after the
    // source lost the reply, and it is dropped by the next `begin`.
    this.staging.dropFiles();
    this.staging.markPublished();

    return forkResultOf(head, staged.staged);
  }

  /**
   * The marker, as canonical rows: one message with one text part, sealed at
   * its last update, and one entry referencing that part.
   *
   * Written through SQL rather than through the session stores because the
   * publication is synchronous by contract — a host transaction cannot await —
   * and the marker's text is small enough to be an inline payload, so nothing
   * here needs the filesystem.
   */
  private writeForkMarker(
    actorId: string, markerId: string, parentId: string | null, text: string, recordedAt: number,
  ): void {
    void this.target`
      INSERT INTO session_messages
      (actor_id, message_id, role, native_content_kind, origin, request_id, output_slot, ingress_id, sealed_sequence, recorded_at)
      VALUES (${actorId}, ${markerId}, ${'system'}, ${'string'}, ${'edit'}, ${null}, ${null}, ${null}, ${null}, ${recordedAt})
    `;

    void this.target`
      INSERT INTO message_parts (actor_id, message_id, part_no, kind, reply_to_message_id, reply_to_part_no, stream_order)
      VALUES (${actorId}, ${markerId}, ${0}, ${'text'}, ${null}, ${null}, ${null})
    `;

    // The update sequence a string-content message is published with: its
    // envelope, its one part's descriptor, then that part's text.
    const updates: readonly { part: number | null; operation: string; payload: string }[] = [
      { part: null, operation: 'envelope-metadata', payload: JSON.stringify({}) },
      { part: 0, operation: 'open', payload: JSON.stringify({ type: 'text' }) },
      { part: 0, operation: 'append', payload: JSON.stringify(text) },
    ];

    for (const [sequence, update] of updates.entries()) {
      void this.target`
        INSERT INTO message_updates
        (actor_id, message_id, sequence, part_no, operation, payload_json, payload_path, payload_digest)
        VALUES (${actorId}, ${markerId}, ${sequence}, ${update.part}, ${update.operation},
                ${update.payload}, ${null}, ${null})
      `;
    }

    const sealed = updates.length - 1;
    void this.target`
      UPDATE session_messages SET sealed_sequence = ${sealed}
      WHERE actor_id = ${actorId} AND message_id = ${markerId}
    `;

    void this.target`
      INSERT INTO conversation_entries
      (actor_id, session_id, id, parent_id, role, turn_id, run_id,
       metadata_json, metadata_path, metadata_digest, recorded_at, context_id, context_revision)
      VALUES (${actorId}, ${CHAT_SESSION_ID}, ${markerId}, ${parentId}, ${'system'}, ${null}, ${null},
              ${null}, ${null}, ${null}, ${recordedAt}, ${null}, ${null})
    `;

    void this.target`
      INSERT INTO conversation_entry_parts
      (actor_id, session_id, entry_id, position, message_id, part_no, through_sequence, text_start, text_length)
      VALUES (${actorId}, ${CHAT_SESSION_ID}, ${markerId}, ${0}, ${markerId}, ${0}, ${sealed}, ${null}, ${null})
    `;
  }

  /**
   * The fork's own context, created once and read back afterwards.
   *
   * Read back rather than remembered in a field: the membership arrives on one
   * activation and the publication may run on another, and both have to name
   * the same context. An existing selection that predates this transfer is
   * adopted and given this revision, so a target whose boot initialized a
   * context does not end up with two.
   */
  private forkContext(actorId: string): string {
    const selected = this.target<{ context_id: string }>`
      SELECT context_id FROM actor_context_selection WHERE actor_id = ${actorId}
    `[0]?.context_id;

    const contextId = selected ?? crypto.randomUUID();

    if (selected === undefined) {
      void this.target`
        INSERT INTO actor_contexts (actor_id, context_id, fork_context_id, fork_revision)
        VALUES (${actorId}, ${contextId}, ${null}, ${null})
      `;
    }

    const revision = this.target<{ revision: number }>`
      SELECT revision FROM context_revisions
      WHERE actor_id = ${actorId} AND context_id = ${contextId} AND revision = ${FORK_CONTEXT_REVISION}
    `[0];

    if (revision === undefined) {
      void this.target`
        INSERT INTO context_revisions (actor_id, context_id, revision, author, cause, turn_id, proposal_id, recorded_at)
        VALUES (${actorId}, ${contextId}, ${FORK_CONTEXT_REVISION}, ${actorId}, ${'fork'}, ${null}, ${null}, ${this.now})
      `;
    }

    if (selected === undefined) {
      void this.target`INSERT INTO actor_context_selection (actor_id, context_id) VALUES (${actorId}, ${contextId})`;
    }

    return contextId;
  }
}

/** One transfer's result, from the state the target stored. The wire returns it
 *  at the publication and again for every frame re-delivered afterwards, so it
 *  is derived in ONE place from ONE authority. */
function forkResultOf(head: ForkSnapshotHead, counts: ForkStagedCounts): ForkResult {
  return {
    forkPointMs: head.cut.createdAtMs,
    messagesCopied: counts.conversationEntries,
    craftedToolsCopied: counts.craftedTools,
  };
}

/**
 * Land a whole snapshot in the target workspace — the in-process fork, where
 * both databases are open at once and there is no wire to bound.
 *
 * The same {@link ForkTargetWriter} the streamed fork drives, in one call. Files
 * go first and outside any transaction the caller holds, because a host
 * transaction is synchronous and the filesystem is not; the staging and the
 * publication then go inside ONE transaction, so a mid-write failure here
 * leaves no fork rather than a half-copied one.
 */
export async function writeForkSnapshot(
  target: SqlExecutor,
  targetVfs: VFS,
  snapshot: ForkSnapshot,
  opts: ForkWriteTarget,
): Promise<ForkResult> {
  const writer = new ForkTargetWriter(target, targetVfs, opts);
  // The head and the counters are established before the first staged FILE, so
  // a file records its mission and its count against THIS transfer. The row
  // deletion stays inside the caller's transaction below, where a failed
  // publication rolls it back with everything else.
  writer.begin({ source: snapshot.source, cut: snapshot.cut });

  for (const file of snapshot.files) await writer.stageFile(file.path, file.content);

  for (const artifact of snapshot.artifacts) await writer.stageFile(artifact.path, artifact.content, true);

  const rows = (): ForkResult => {
    writer.clearStagedRows();
    writer.stageAgentConfig(snapshot.agentConfig);
    writer.stageCraftedTools(snapshot.craftedTools);
    writer.stageMemoryChunks(snapshot.memoryChunks);
    writer.stageSessionMessages(snapshot.sessionMessages);
    writer.stageMessageParts(snapshot.messageParts);
    writer.stageMessageUpdates(snapshot.messageUpdates);
    writer.stageConversationEntries(snapshot.conversationEntries);
    writer.stageConversationEntryParts(snapshot.conversationEntryParts);
    writer.stageContextMembers(snapshot.contextMembers);

    return writer.publishRows();
  };

  let result: ForkResult | null = null;

  if (opts.transaction) opts.transaction(() => { result = rows(); });
  else result = rows();

  if (result === null) throw new Error('fork write transaction produced no result');

  return result;
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
