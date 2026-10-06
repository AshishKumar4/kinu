/**
 * Workspace fork: which rows one cut selects (every entry up to the cut's position),
 * and the readers both the in-process snapshot and the wire use.
 */

import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { isTreeRelativePath, workspacePath, WORKSPACE_ROOT } from '../vfs/workspace-path';
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

/** Max carried chain depth; a walk without a bound loops on corrupt parent edges. */
const FORK_CHAIN_MAX_DEPTH = 10_000;

/** Which rows one cut selects, decided once. Holds identities, never row content,
 *  so the plan is bounded by the chain. */
export interface ForkConversationPlan {
  readonly cut: { readonly entryId: string; readonly recordedAt: number };
  readonly entryIds: readonly string[];
  readonly messageIds: readonly string[];
  /** Membership of the cut entry's context revision, by position; empty if no entry recorded one. */
  readonly members: readonly ForkContextMemberRow[];
  /** Referenced payload files, relative to the source artifact directory, deduplicated. */
  readonly artifacts: readonly string[];
}

/** Rows per conversation section, declared by the source and checked against what the target took. */
export interface ForkConversationCounts {
  sessionMessages: number;
  conversationEntries: number;
  conversationEntryParts: number;
  contextMembers: number;
}

interface ForkChainEntryRow {
  id: string;
  position: number;
  recorded_at: number;
  metadata_path: string | null;
  context_id: string | null;
  context_revision: number | null;
}

function artifactSegments(relative: string, path: string, root: string): Effect.Effect<string> {
  return !isTreeRelativePath(relative)
    ? Effect.die(new Error(
      `fork cannot carry payload ${JSON.stringify(path)}: it does not name a file inside the artifact `
      + `directory ${JSON.stringify(root)}`,
    ))
    : Effect.succeed(relative);
}

/** One payload path relative to its owning artifact directory. A path outside it is refused:
 *  carrying another workspace's absolute path would re-root or escape into a directory the fork does not own. */
function forkArtifactRelativePath(stored: string, artifactDirectory: string): Effect.Effect<string> {
  const root = workspacePath(artifactDirectory, WORKSPACE_ROOT);
  const prefix = `${root}/`;

  // Refuse raw segments before normalization can erase traversal.
  return Effect.flatMap(artifactSegments(stored.startsWith('/') ? stored.slice(1) : stored, stored, root), () => {
    const path = workspacePath(stored, WORKSPACE_ROOT);

    return stored.startsWith('/') && path.startsWith(prefix)
      ? Effect.succeed(path.slice(prefix.length))
      : Effect.die(new Error(
        `fork cannot carry payload ${JSON.stringify(path)}: it is outside the artifact directory `
        + `${JSON.stringify(root)}`,
      ));
  });
}

/** Absolute payload path for a carried relative path under one artifact directory. */
export function forkArtifactPath(relative: string, artifactDirectory: string): string {
  const root = workspacePath(artifactDirectory, WORKSPACE_ROOT);

  return settleSync(Effect.map(artifactSegments(relative, relative, root), () => `${root}/${relative}`));
}

/** Which rows the cut at `untilMessageId` selects. Throws if the id is not an entry
 *  of the source's chat session, before any target is created. */
export function planForkConversation(input: {
  readonly sql: SqlExecutor;
  readonly actorId: string;
  readonly untilMessageId: string;
  readonly artifactDirectory: string;
}): ForkConversationPlan {
  return settleSync(Effect.gen(function* () {
    const { sql, actorId, untilMessageId } = input;

    const cut = sql<{ position: number }>`
      SELECT position FROM conversation_entries WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${untilMessageId}
    `[0];

    if (cut === undefined) {
      return yield* Effect.die(new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`));
    }

    if (cut.position >= FORK_CHAIN_MAX_DEPTH) {
      return yield* Effect.die(new Error(`fork chain for entry ${JSON.stringify(untilMessageId)} is deeper than ${FORK_CHAIN_MAX_DEPTH} entries`));
    }

    // Keyed on the actor: entry ids are per actor, so an unkeyed read could reach a sibling's chat.
    const chain = sql<ForkChainEntryRow>`
      SELECT id, position, recorded_at, metadata_path, context_id, context_revision
      FROM conversation_entries
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND position <= ${cut.position}
      ORDER BY position
    `;

    const cutEntry = chain[chain.length - 1];

    if (cutEntry === undefined) {
      return yield* Effect.die(new Error(`fork point not found: message id "${untilMessageId}" does not exist in source`));
    }

    const context = [...chain].reverse().find((entry) => entry.context_id !== null && entry.context_revision !== null);

    // Membership at that revision, not live: an entry pruned after the cut was still in its context.
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

    const seeks: { messageId: string; seek: number }[] = [];

    for (const messageId of referenced) {
      const row = sql<{ seek: number; sealed_at: number | null }>`
        SELECT rowid AS seek, sealed_at FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
      `[0];

      if (row === undefined) {
        return yield* Effect.die(new Error(`fork carries a reference to message ${JSON.stringify(messageId)}, which the source does not have`));
      }

      if (row.sealed_at === null) {
        return yield* Effect.die(new Error(`fork cannot carry message ${JSON.stringify(messageId)}: it is still open in the source`));
      }

      seeks.push({ messageId, seek: row.seek });
    }

    const ordered = seeks.sort((left, right) => left.seek - right.seek).map(({ messageId }) => messageId);

    const paths = [
      ...chain.map((entry) => entry.metadata_path),
      ...ordered.map((messageId) => sql<{ content_path: string | null }>`
        SELECT content_path FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
      `[0]?.content_path ?? null),
    ];

    const carried = new Set<string>();

    for (const path of paths) {
      if (path !== null) carried.add(yield* forkArtifactRelativePath(path, input.artifactDirectory));
    }

    const artifacts = [...carried];

    return {
      cut: { entryId: cutEntry.id, recordedAt: cutEntry.recorded_at },
      entryIds: chain.map((entry) => entry.id),
      messageIds: ordered,
      members,
      artifacts,
    };
  }));
}

/** One carried message with its content path made relative. */
export function forkSessionMessageRow(
  sql: SqlExecutor, actorId: string, messageId: string, artifactDirectory: string,
): ForkSessionMessageRow {
  return settleSync(Effect.gen(function* () {
    const row = sql<{
      message_id: string; role: string; native_content_kind: string; origin: string;
      envelope_json: string; sealed_at: number | null; content_json: string | null; content_path: string | null; content_digest: string | null;
    }>`
      SELECT message_id, role, native_content_kind, origin, envelope_json, sealed_at, content_json, content_path, content_digest
      FROM session_messages WHERE actor_id = ${actorId} AND message_id = ${messageId}
    `[0];

    if (row === undefined) {
      return yield* Effect.die(new Error(`fork carries a reference to message ${JSON.stringify(messageId)}, which the source does not have`));
    }

    if (row.sealed_at === null) {
      return yield* Effect.die(new Error(`fork cannot carry message ${JSON.stringify(messageId)}: it is still open in the source`));
    }

    return v.parse(ForkSessionMessageRowSchema, {
      ...row,
      sealed_at: row.sealed_at,
      content_path: row.content_path === null ? null : yield* forkArtifactRelativePath(row.content_path, artifactDirectory),
    });
  }));
}

export function forkConversationEntryRow(
  sql: SqlExecutor, actorId: string, entryId: string, artifactDirectory: string,
): ForkConversationEntryRow {
  return settleSync(Effect.gen(function* () {
    const row = sql<{
      id: string; position: number; role: string; turn_id: string | null; run_id: string | null;
      metadata_json: string | null; metadata_path: string | null; metadata_digest: string | null; recorded_at: number;
    }>`
      SELECT id, position, role, turn_id, run_id, metadata_json, metadata_path, metadata_digest, recorded_at
      FROM conversation_entries
      WHERE actor_id = ${actorId} AND session_id = ${CHAT_SESSION_ID} AND id = ${entryId}
    `[0];

    if (row === undefined) {
      return yield* Effect.die(new Error(`fork carries entry ${JSON.stringify(entryId)}, which the source does not have`));
    }

    return v.parse(ForkConversationEntryRowSchema, {
      ...row,
      metadata_path: row.metadata_path === null ? null : yield* forkArtifactRelativePath(row.metadata_path, artifactDirectory),
    });
  }));
}

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

/** Per-section counts over the readers' own predicates, so declaration and stream cannot disagree. */
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
