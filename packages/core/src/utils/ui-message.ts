/**
 * Turn authorship and the client-side transcript projection. Harness-enqueued turns are stored
 * `role: 'user'` for the model but attributed to the harness: author stamp, then `kinuEvent`, then row id.
 */

import type { UIMessage } from 'ai';
import * as v from 'valibot';
import type { ChatHistoryEntry } from '../types/chat';
import { turnTags } from '../types/turn-metadata';

/** A UI message by its shape: what Kinu projects from its own rows is walked no deeper. */
export const UIMessageSchema = v.custom<UIMessage>((value) =>
  v.is(v.object({ id: v.string(), role: v.picklist(['user', 'assistant', 'system']), parts: v.array(v.unknown()) }), value));

/** Row id = prefix + producer identity; the primary key is the idempotency mechanism. */
export const PROGRAMMATIC_MESSAGE_ID_PREFIX = 'programmatic:';

/** The producer identity a programmatic turn is named for (an assignment row's id); any other turn id as it is. */
export function announcementOf(turnId: string): string {
  return turnId.startsWith(PROGRAMMATIC_MESSAGE_ID_PREFIX) ? turnId.slice(PROGRAMMATIC_MESSAGE_ID_PREFIX.length) : turnId;
}

/** What a row says: an answer's last text (its earlier texts are narration), anything else's text whole. */
export function rowText(row: { readonly role: string; readonly parts: readonly { readonly type?: unknown; readonly text?: unknown }[] }): string {
  const texts = row.parts.flatMap((part) => part.type === 'text' ? [v.parse(v.string(), part.text)] : []);

  return row.role === 'assistant' ? texts.at(-1) ?? '' : texts.join('');
}

/** Displayed role: harness-authored user rows show as `system`; the stored role sent to the model is unchanged. */
export function transcriptRole(
  row: { id: string; role: 'user' | 'assistant' | 'system'; metadata?: unknown },
): 'user' | 'assistant' | 'system' {
  return row.role === 'user' && turnTags(row).author === 'harness' ? 'system' : row.role;
}

/**
 * Older pages as messages, oldest first, deduplicated (a duplicate React key silently drops one).
 * Pure over the fetched pages, so a pane can reuse it across stream ticks.
 */
export function restoredRows(older: readonly ChatHistoryEntry[]): UIMessage[] {
  const seen = new Set<string>();
  const restored: UIMessage[] = [];

  for (const entry of older) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);

    const row: UIMessage = {
      id: entry.id, role: entry.role, parts: [{ type: 'text', text: entry.content }],
    };

    if (entry.metadata !== undefined) row.metadata = entry.metadata;
    restored.push(row);
  }

  return restored;
}

