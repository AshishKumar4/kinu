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

import * as v from 'valibot';
import { tolerate } from '../obs/index.js';
import { parseJsonValue } from './json.js';

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
