/**
 * A stored conversation row, as the transcript read models see it: its plain
 * text, and whether the harness wrote it rather than the operator.
 *
 * `assistant_messages.content` holds a serialized UI message, not text, and two
 * places need the flattened form: the transcript read model, and the fork write
 * — which reconstructs the plain `messages` mirror from the rich rows instead of
 * carrying the same conversation across an RPC twice. Lives here rather than in
 * either of them because `read-models/status.ts` already imports
 * `identity/fork.ts`, so the projection cannot be owned by either without a
 * cycle.
 *
 * Authorship lives here for the same reason. A turn the backend enqueues on the
 * agent's behalf — a settled background job, the reactor draining hub events —
 * is stored `role: 'user'` because that is what the model must read it as, and
 * the row is the turn's input. Nothing about that makes the operator its
 * author, and every consumer that asks "what did the owner say" was answering
 * with these: the transcript read model rendered them as the owner's words, and
 * the walk-back fork (`findForkPivot`, which pivots on user rows) offered them
 * as fork points, so a workspace whose recovery re-announced one job filled its
 * whole walk-back list with the same machine notice.
 *
 * The provenance is the row's ID, not a column and not a second copy of the
 * metadata: `BackendHost.enqueueTurn` has always derived a programmatic turn's
 * message id from {@link programmaticMessageId}, so the fact is already durable
 * on both backends, survives the fork copy (which preserves primary keys), and
 * needs no schema change to read.
 */

import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { tolerate } from '../obs/index';
import { parseJsonValue } from './json';
import type { ChatHistoryEntry } from '../read-models/status';

const UiMessageSchema = v.object({
  parts: v.optional(v.array(v.object({
    type: v.string(),
    text: v.optional(v.string()),
  }))),
});

/**
 * The id prefix a programmatic turn's durable message carries, and the whole
 * provenance record.
 *
 * Both backends derive the row id as this prefix plus the identity the producer
 * gave the turn, so a producer with a stable `idempotencyKey` gets a stable row
 * id — which is the idempotency mechanism itself: the message store's primary
 * key refuses the second write, rather than a flag somewhere remembering that
 * the first happened.
 */
export const PROGRAMMATIC_MESSAGE_ID_PREFIX = 'programmatic:';

/**
 * The role a stored row takes in the TRANSCRIPT — what a surface renders, what
 * an operator reads back, and what the walk-back fork pivots on.
 *
 * A programmatic turn is reported `system`: the harness speaking in the
 * conversation, which is exactly what `identity/fork.ts` already writes its own
 * synthetic marker row as, and what `findForkPivot` already declines to pivot
 * on. The STORED role is untouched — the model's history still reads it as the
 * user turn it has to be — so this changes what we claim about a row, never
 * what the model is sent.
 */
export function transcriptRole(
  id: string,
  role: 'user' | 'assistant' | 'system',
): 'user' | 'assistant' | 'system' {
  return role === 'user' && id.startsWith(PROGRAMMATIC_MESSAGE_ID_PREFIX) ? 'system' : role;
}

/** Flatten a stored UIMessage-JSON content string to plain text.
 *  `assistant_messages` rows hold the serialized UI message and `messages` rows
 *  hold plain text; both reach this, so text that is not JSON is a value here
 *  and nothing else is. */
export function uiMessageText(content: string): string {
  const decoded = tolerate(() => parseJsonValue(content), 'malformed-input');
  if (decoded === undefined) return content;
  const parsed = v.safeParse(UiMessageSchema, decoded);
  if (!parsed.success || !parsed.output.parts) return content;
  return parsed.output.parts
    .flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : [])
    .join('');
}

/**
 * One transcript out of the two places a chat message reaches a surface from.
 *
 * The live list is the agents SDK's: `get-messages` seeds it with
 * `Think.messages` — a bounded newest window governed by `hydrationByteBudget`
 * — and the socket appends every turn after that. Anything older than that
 * window is only in storage, and is walked back one cursored page at a time by
 * `getChatHistoryPage`.
 *
 * The two sources overlap by construction. The walk seeks strictly older than
 * its anchor, but the anchor is minted from a list the socket keeps extending,
 * and a reconnect can re-seed a wider window — so the same message can
 * legitimately arrive both ways. The live copy wins whenever it does: it
 * carries parts, metadata, tool calls and attachments, where the stored copy
 * has been flattened to text by `uiMessageText` above.
 */
export function mergeTranscript(
  older: readonly ChatHistoryEntry[],
  live: readonly UIMessage[],
): UIMessage[] {
  const known = new Set(live.map((message) => message.id));
  const restored: UIMessage[] = [];
  for (const entry of older) {
    // Also guards the older half against itself: a page boundary that
    // re-delivered a row would render it twice under one React key, which
    // React resolves by silently dropping one — a pagination bug would then
    // look like a message going missing rather than like a duplicate.
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    restored.push({ id: entry.id, role: entry.role, parts: [{ type: 'text', text: entry.content }] });
  }
  return [...restored, ...live];
}
