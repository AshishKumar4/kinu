/**
 * The plain text of a stored UIMessage.
 *
 * `assistant_messages.content` holds a serialized UI message, not text, and two
 * places need the flattened form: the transcript read model, and the fork write
 * — which reconstructs the plain `messages` mirror from the rich rows instead of
 * carrying the same conversation across an RPC twice. Lives here rather than in
 * either of them because `read-models/status.ts` already imports
 * `identity/fork.ts`, so the projection cannot be owned by either without a
 * cycle.
 */

import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { tolerate } from '../obs/index.js';
import { parseJsonValue } from './json.js';
import type { ChatHistoryEntry } from '../read-models/status.js';

const UiMessageSchema = v.object({
  parts: v.optional(v.array(v.object({
    type: v.string(),
    text: v.optional(v.string()),
  }))),
});

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
