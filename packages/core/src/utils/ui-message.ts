/**
 * Turn authorship and the client-side transcript projection. Harness-enqueued turns are stored
 * `role: 'user'` for the model but attributed to the harness: author stamp, then `kinuEvent`, then row id.
 */

import type { UIMessage } from 'ai';
import * as v from 'valibot';
import type { JsonObject } from './json';
import type { ChatHistoryEntry } from '../types/chat';

/** Row id = prefix + producer identity; the primary key is the idempotency mechanism. */
export const PROGRAMMATIC_MESSAGE_ID_PREFIX = 'programmatic:';

/** Who wrote a turn's words, stamped at enqueue. Defaults to harness, so a new event kind never renders as the operator's. */
export const TURN_AUTHOR_METADATA_KEY = 'kinuAuthor';

export type TurnAuthor = 'harness' | 'operator';

const TurnAuthorSchema = v.looseObject({
  [TURN_AUTHOR_METADATA_KEY]: v.optional(v.picklist(['harness', 'operator'])),
  kinuEvent: v.optional(v.string()),
});

/** Stamp at the row-writing seam. Idempotent; a producer's declared author wins. */
export function stampTurnAuthor(metadata?: JsonObject): JsonObject {
  const parsed = v.safeParse(TurnAuthorSchema, metadata ?? {});
  const declared = parsed.success ? parsed.output[TURN_AUTHOR_METADATA_KEY] : undefined;

  return { ...metadata, [TURN_AUTHOR_METADATA_KEY]: declared ?? 'harness' };
}

/**
 * Author from written markers only, never prose. Id fallback exists because fork copies keep keys, not metadata;
 * it resolves to `harness`, the safe direction.
 */
export function turnAuthor(row: { id?: string; metadata?: unknown }): TurnAuthor {
  const parsed = v.safeParse(TurnAuthorSchema, row.metadata ?? {});

  if (parsed.success) {
    const stamped = parsed.output[TURN_AUTHOR_METADATA_KEY];

    if (stamped) return stamped;

    if (parsed.output.kinuEvent !== undefined) return 'harness';
  }

  return row.id?.startsWith(PROGRAMMATIC_MESSAGE_ID_PREFIX) ? 'harness' : 'operator';
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
  return row.role === 'user' && turnAuthor(row) === 'harness' ? 'system' : row.role;
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

/**
 * Merge stored older pages with the live SDK list; the two overlap by construction and the live copy wins.
 * Restored rows keep metadata, which carries authorship.
 */
export function mergeTranscript(
  older: readonly ChatHistoryEntry[],
  live: readonly UIMessage[],
): UIMessage[] {
  const known = new Set(live.map((message) => message.id));

  return [...restoredRows(older).filter((row) => !known.has(row.id)), ...live];
}
