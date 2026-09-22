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
  ForkSessionMessageRowSchema,
  type ForkContextMemberRow,
  type ForkConversationEntryPartRow,
  type ForkConversationEntryRow,
  type ForkSessionMessageRow,
} from './fork-rows';

/** How deep a carried chain may be before the walk refuses it. A public chain
 *  is a tree whose depth is bounded by turns, not by rows; a walk without a
 *  bound is a loop waiting for corrupt parent edges. */
const FORK_CHAIN_MAX_DEPTH = 10_000;

/**
 * Which rows one cut selects, decided once.
 *
 * Both halves of the fork run this: the in-process snapshot materializes the
 * rows it names, and the wire streams them. It holds identities — never row
 * CONTENT — so the plan of an unbounded workspace is bounded by its chain, and
 * the content stays where the framing can bound it.
 */
export interface ForkConversationPlan {
  readonly cut: { readonly entryId: string; readonly recordedAt: number };
  /** The cut entry's ancestry, root first. */
  readonly entryIds: readonly string[];
  /** Carried message ids in the source's own insertion order. */
  readonly messageIds: readonly string[];
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
        SELECT entry_id, position, message_id FROM context_memberships
        WHERE actor_id = ${actorId} AND context_id = ${context.context_id}
          AND from_revision <= ${context.context_revision}
          AND (to_revision IS NULL OR to_revision > ${context.context_revision})
        ORDER BY position
      `.map((row) => v.parse(ForkContextMemberRowSchema, row));

  const referenced = new Set<string>();

  for (const entry of chain) {
    for (const part of forkConversationEntryPartRows(sql, actorId, entry.id)) referenced.add(part.message_id);
  }

  for (const member of members) referenced.add(member.message_id);

  const ordered = [...referenced].map((messageId) => {
    const row = sql<{ seek: number; sealed_at: number | null }>`
      SELECT rowid AS seek, sealed_at FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
    `[0];

    if (row === undefined) {
      throw new Error(`fork carries a reference to message ${JSON.stringify(messageId)}, which the source does not have`);
    }

    // An open message is still being streamed by a turn: a fork requires an
    // idle source, and its stream rows do not cross.
    if (row.sealed_at === null) {
      throw new Error(`fork cannot carry message ${JSON.stringify(messageId)}: it is still open in the source`);
    }

    return { messageId, seek: row.seek };
  }).sort((left, right) => left.seek - right.seek)
    .map(({ messageId }) => messageId);

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

  for (const messageId of ordered) {
    carry(sql<{ content_path: string | null }>`
      SELECT content_path FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
    `[0]?.content_path ?? null);
  }

  return {
    cut: { entryId: cutEntry.id, recordedAt: cutEntry.recorded_at },
    entryIds: chain.map((entry) => entry.id),
    messageIds: ordered,
    members,
    artifacts,
  };
}

/** One carried message, whole, with its content path made relative. */
export function forkSessionMessageRow(
  sql: SqlExecutor, actorId: string, messageId: string, artifactDirectory: string,
): ForkSessionMessageRow {
  const row = sql<{
    message_id: string; role: string; native_content_kind: string; origin: string; recorded_at: number;
    envelope_json: string; sealed_at: number | null; content_json: string | null; content_path: string | null; content_digest: string | null;
  }>`
    SELECT message_id, role, native_content_kind, origin, recorded_at, envelope_json, sealed_at, content_json, content_path, content_digest
    FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
  `[0];

  if (row === undefined) {
    throw new Error(`fork carries a reference to message ${JSON.stringify(messageId)}, which the source does not have`);
  }

  if (row.sealed_at === null) {
    throw new Error(`fork cannot carry message ${JSON.stringify(messageId)}: it is still open in the source`);
  }

  return v.parse(ForkSessionMessageRowSchema, {
    ...row,
    sealed_at: row.sealed_at,
    content_path: row.content_path === null ? null : forkArtifactRelativePath(row.content_path, artifactDirectory),
  });
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
    SELECT entry_id, position, message_id, part_no, text_start, text_length
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
  let conversationEntryParts = 0;

  for (const entryId of plan.entryIds) {
    conversationEntryParts += sql<{ total: number }>`
      SELECT COUNT(*) AS total FROM conversation_entry_parts
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND entry_id = ${entryId}
    `[0]?.total ?? 0;
  }

  return {
    sessionMessages: plan.messageIds.length,
    conversationEntries: plan.entryIds.length,
    conversationEntryParts,
    contextMembers: plan.members.length,
  };
}
