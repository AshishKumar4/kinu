/**
 * Workspace fork — which rows one cut selects, and the readers that materialize
 * them.
 *
 * The in-process snapshot in `identity/fork.ts` and the wire in
 * `identity/fork-transfer.ts` are the two halves. Both halves read the rows
 * through the readers below, so there is one transcription of the copy however
 * it travels.
 *
 * "Ancestry" and not "everything older than the cut" is the whole difference
 * between forking a tree and forking a list. A prefix cut cannot express a
 * second child of the same entry, and the public chain is a tree by
 * construction — `conversation_entries.parent_id`.
 */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import {
  ForkContextMemberRowSchema,
  ForkConversationEntryPartRowSchema,
  ForkConversationEntryRowSchema,
  ForkMessagePartRowSchema,
  ForkMessageUpdateRowSchema,
  ForkSessionMessageRowSchema,
  type ForkContextMemberRow,
  type ForkConversationEntryPartRow,
  type ForkConversationEntryRow,
  type ForkMessagePartRow,
  type ForkMessageUpdateRow,
  type ForkSessionMessageRow,
} from './fork-rows';

/** How deep a carried chain may be before the walk refuses it. A public chain
 *  is a tree whose depth is bounded by turns, not by rows; a walk without a
 *  bound is a loop waiting for corrupt parent edges. */
const FORK_CHAIN_MAX_DEPTH = 10_000;

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
function forkArtifactRelativePath(path: string, artifactDirectory: string): string {
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
