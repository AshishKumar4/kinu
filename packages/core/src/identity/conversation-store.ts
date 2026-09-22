/** Flat reads over `conversation_entries` for graders, fork preflight and recovery. */

import * as v from 'valibot';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from './actor-handle';
import type { SessionTranscriptReader } from '../session/transcript';

import { CHAT_SESSION_ID } from '../session/transcript-schema';

/** Fork-cut preflight by primary key only, before any workspace is reserved or ancestry read. */
export function forkPointExists(sql: SqlExecutor, actor: ActorHandle, messageId: string): boolean {
  actor.assertCurrent();

  return sql<{ id: string }>`SELECT id FROM conversation_entries WHERE actor_id=${actor.actorId} AND session_id=${CHAT_SESSION_ID} AND id=${messageId} LIMIT 1`.length > 0;
}

export function conversationCount(sql: SqlExecutor, actor: ActorHandle): number {
  actor.assertCurrent();

  return sql<{ c: number }>`SELECT COUNT(*) AS c FROM conversation_entries WHERE actor_id=${actor.actorId} AND session_id=${CHAT_SESSION_ID}`[0]?.c ?? 0;
}

/** The user→assistant pair behind a completed turn. */
export interface ConversationTurnPair {
  sessionId: string;
  /** Flattened plain text; null where the pair has no user row. */
  request: string | null;
  responseId: string;
  response: string | null;
  startedAtMs: number | null;
  endedAtMs: number;
}

// Non-strict: the enqueue seam writes other stamps.
const DrainTurnMetadataSchema = v.object({ drainTurnId: v.optional(v.string()) });

/**
 * The durable answer to each drain turn, found via the assistant child of the user entry carrying `drainTurnId`.
 * Empty answers are omitted: replying with nothing would close a delivery the sender still awaits.
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

/** The pair behind a turn, named by its assistant entry id; a root answer has a null request. */
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
