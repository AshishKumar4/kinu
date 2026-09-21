/**
 * The canonical conversation store: the flat reads every grader, fork preflight
 * and recovery takes over `conversation_entries`.
 */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import type { SessionTranscriptReader } from '../orchestrator/session-transcript';

/** The chat session every conversational read and write uses. */
export const CHAT_SESSION_ID = 'default';

/** Cheap fork-cut preflight. It reads only the authority table primary key, so
 * the driver can refuse an unknown requested cut before it probes or reserves a
 * workspace without materialising the ancestry the transfer will stream. */
export function forkPointExists(sql: SqlExecutor, actor: ActorHandle, messageId: string): boolean {
  actor.assertCurrent();

  return sql<{ id: string }>`SELECT id FROM conversation_entries WHERE actor_id=${actor.actorId} AND session_id=${CHAT_SESSION_ID} AND id=${messageId} LIMIT 1`.length > 0;
}

/** How many messages the workspace's default chat holds. */
export function conversationCount(sql: SqlExecutor, actor: ActorHandle): number {
  actor.assertCurrent();

  return sql<{ c: number }>`SELECT COUNT(*) AS c FROM conversation_entries WHERE actor_id=${actor.actorId} AND session_id=${CHAT_SESSION_ID}`[0]?.c ?? 0;
}

/** The user→assistant pair behind a completed turn. */
export interface ConversationTurnPair {
  /** The conversation the turn lives in, as surfaces report it. */
  sessionId: string;
  /** Flattened plain text; null where the pair has no user row. */
  request: string | null;
  responseId: string;
  response: string | null;
  startedAtMs: number | null;
  endedAtMs: number;
}

/** The one field a resumed reply reads off a queued drain turn's user row.
 *  Non-strict: every other stamp the enqueue seam writes is irrelevant here. */
const DrainTurnMetadataSchema = v.object({ drainTurnId: v.optional(v.string()) });

/**
 * The durable answer each named synthetic drain turn received, or nothing when
 * it never got one.
 *
 * What makes a recovery able to finish a reply the answering turn never sent.
 * The link is the store's own parent edge: a queued drain turn's USER entry
 * carries `drainTurnId` in its metadata, and the assistant entry whose
 * `parentId` is that user entry is the answer to it. This reads the durable
 * transcript rather than a live activation's hydrated message list — a recovery
 * has no such list, and that is the whole point of it.
 *
 * An empty answer is ABSENT from the result, never present as `''`. Replying
 * with nothing would close a delivery the sender is still waiting on.
 */
export async function answersForDrainTurns(
  transcript: SessionTranscriptReader,
  drainTurnIds: readonly string[],
): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
  const wanted = new Set(drainTurnIds);

  for (const ask of [...transcript.ancestry()].reverse()) {
    if (answers.size === wanted.size) break;

    if (ask.role !== 'user') continue;
    const parsed = v.safeParse(DrainTurnMetadataSchema, await transcript.metadata(ask.id));
    const drainTurnId = parsed.success ? parsed.output.drainTurnId : undefined;

    if (drainTurnId === undefined || !wanted.has(drainTurnId) || answers.has(drainTurnId)) continue;

    for (const replyId of [...transcript.children(ask.id)].reverse()) {
      const reply = transcript.read(replyId);

      if (reply?.role !== 'assistant') continue;
      const answer = await transcript.project(replyId);

      if (answer !== null && answer.content.trim().length > 0) { answers.set(drainTurnId, answer.content); break; }
    }
  }

  return answers;
}

/**
 * The request/response pair behind a turn id — what outcome attribution, take
 * picks and explicit feedback grade a turn from.
 *
 * A turn is named by the id of the answer it produced, so an id that names
 * anything but an assistant entry is not a turn and has no pair. The parent
 * edge carries the ask: absent where the answer roots its own chain, which the
 * pair reports as a null request rather than as no pair at all.
 */
export async function conversationTurnPair(
  transcript: SessionTranscriptReader,
  messageId: string,
): Promise<ConversationTurnPair | undefined> {
  const entry = transcript.read(messageId);

  if (entry === null || entry.role !== 'assistant') return undefined;

  const parent = entry.parentId === null ? null : transcript.read(entry.parentId);
  const response = await transcript.project(entry.id);
  const request = parent === null ? null : await transcript.project(parent.id);

  return {
    sessionId: transcript.sessionId,
    request: request === null ? null : request.content,
    responseId: messageId,
    response: response === null ? null : response.content,
    startedAtMs: parent === null ? null : parent.recordedAt,
    endedAtMs: entry.recordedAt,
  };
}
