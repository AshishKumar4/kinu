// The chat socket's frames as a browser sends them and as a test reads the answers back (agents/chat's protocol).
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import * as v from 'valibot';
import type { JsonObject } from '@kinu.run/core';

/** What a sent message carries beyond its text: its own id (`input-<request>` by default), metadata, parts before the
 *  text, the trigger. */
export interface SentMessage {
  readonly messageId?: string;
  readonly metadata?: JsonObject;
  readonly before?: readonly JsonObject[];
  readonly trigger?: 'submit-message' | 'regenerate-message';
}

/** A `cf_agent_use_chat_request` frame for request `id` sending `text`. */
export function chatRequest(id: string, text: string, sent: SentMessage = {}): string {
  const message: JsonObject = {
    id: sent.messageId ?? `input-${id}`, role: 'user', parts: [...sent.before ?? [], { type: 'text', text }],
  };

  if (sent.metadata !== undefined) message['metadata'] = sent.metadata;

  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id,
    init: { method: 'POST', body: JSON.stringify({ messages: [message], trigger: sent.trigger ?? 'submit-message' }) },
  });
}

const DoneSchema = v.object({
  type: v.literal(CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE),
  id: v.string(), done: v.optional(v.boolean()), error: v.optional(v.boolean()), landed: v.optional(v.string()), body: v.optional(v.string()),
});

/** A request's last answer: its id, its error's words if it failed, where it landed if it says. */
export interface DoneFrame {
  readonly id: string;
  readonly error?: string | undefined;
  readonly landed?: string | undefined;
}

/** Each request's last answer among the frames `frames` sent. */
export function doneFrames(frames: readonly string[]): DoneFrame[] {
  return frames.flatMap((raw) => {
    const parsed = v.safeParse(DoneSchema, JSON.parse(raw));

    if (!parsed.success || parsed.output.done !== true) return [];
    const { id, error, body, landed } = parsed.output;

    return [{ id, error: error === true ? body : undefined, landed }];
  });
}
