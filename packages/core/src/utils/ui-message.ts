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
import { JsonObjectSchema, parseJsonValue, type JsonObject } from './json';
import type { ChatHistoryEntry } from '../read-models/status';

const UiMessageSchema = v.object({
  parts: v.optional(v.array(v.object({
    type: v.string(),
    text: v.optional(v.string()),
  }))),
  metadata: v.optional(JsonObjectSchema),
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
 * WHO WROTE THE WORDS in a turn. Stamped by the seam that enqueues the turn,
 * read by every surface that renders or attributes it.
 *
 * This exists because the alternative was tried and drifted. Provenance used to
 * be re-derived per surface from the EVENT NAME: the chat pane recognised four
 * of them (`background_job`, `event_drain`, `workspace_created`,
 * `deferred_approval`) and rendered everything else in the operator's bubble,
 * so every event kind added after that list — `fork_interrupted`,
 * `completion_gate`, `take_pick`, `overflow_retry` — silently became something
 * the owner appeared to have typed. Measured on the owner's live workspaces on
 * 2026-08-20: five `fork_interrupted` rows across `sunlit-stone-4a20`,
 * `stone-ash-71f2` and `principal-machine-f1296946`, each reading "23 head(s)
 * across 6 fork run(s) were still marked running…" in the owner's own bubble.
 *
 * So the default is inverted and the writer decides. A turn the harness
 * enqueues is the harness speaking unless its producer says otherwise, and the
 * one producer that does say otherwise is the one carrying words the operator
 * really wrote (an MCP client's `run_task`, a leftover steer re-run as its own
 * turn). A new event kind is therefore attributed correctly the day it is
 * added, without touching any renderer.
 */
export const TURN_AUTHOR_METADATA_KEY = 'proteusAuthor';

export type TurnAuthor = 'harness' | 'operator';

const TurnAuthorSchema = v.looseObject({
  [TURN_AUTHOR_METADATA_KEY]: v.optional(v.picklist(['harness', 'operator'])),
  proteusEvent: v.optional(v.string()),
});

/**
 * Event names that predate {@link TURN_AUTHOR_METADATA_KEY} and carry the
 * operator's own words. Rows written before the stamp existed are read through
 * this; nothing new belongs here, because a new producer stamps instead.
 */
const LEGACY_OPERATOR_EVENTS = { mcp: true } satisfies Record<string, true>;

/**
 * The metadata a programmatic turn's durable row carries. Call it at the seam
 * that writes the row, so the stamp cannot be forgotten by a producer.
 *
 * Idempotent, and the producer's own answer wins: a caller that has already
 * named itself `operator` keeps that through every later funnel it passes.
 */
export function stampTurnAuthor(metadata?: JsonObject): JsonObject {
  const parsed = v.safeParse(TurnAuthorSchema, metadata ?? {});
  const declared = parsed.success ? parsed.output[TURN_AUTHOR_METADATA_KEY] : undefined;
  return { ...metadata, [TURN_AUTHOR_METADATA_KEY]: declared ?? 'harness' };
}

/**
 * Who wrote a stored row, from written markers only — never from its prose.
 *
 * The stamp answers it outright. Rows written before the stamp existed are read
 * from the two markers they do carry: the `proteusEvent` metadata a queued
 * signal has always stamped, and the {@link PROGRAMMATIC_MESSAGE_ID_PREFIX}
 * both backends have always derived a programmatic row's id from. One legacy
 * shape stays genuinely ambiguous — a metadata-less row under the programmatic
 * id prefix, which is what a leftover steer re-run as its own turn used to
 * write — and it resolves to `harness`, the direction that cannot put the
 * harness's words in the owner's mouth. Every such turn written from now on
 * stamps `operator` and is exact.
 */
export function turnAuthor<Metadata>(row: { id?: string; metadata?: Metadata }): TurnAuthor {
  const parsed = v.safeParse(TurnAuthorSchema, row.metadata ?? {});
  if (!parsed.success) return 'operator';
  const stamped = parsed.output[TURN_AUTHOR_METADATA_KEY];
  if (stamped) return stamped;
  const event = parsed.output.proteusEvent;
  if (event !== undefined) return Object.hasOwn(LEGACY_OPERATOR_EVENTS, event) ? 'operator' : 'harness';
  return row.id?.startsWith(PROGRAMMATIC_MESSAGE_ID_PREFIX) ? 'harness' : 'operator';
}

/**
 * The role a stored row takes in the TRANSCRIPT — what a surface renders, what
 * an operator reads back, and what the walk-back fork pivots on.
 *
 * A harness-authored turn is reported `system`, which is exactly what
 * `identity/fork.ts` already writes its own synthetic marker row as, and what
 * `findForkPivot` already declines to pivot on. The STORED role is untouched —
 * the model's history still reads it as the user turn it has to be — so this
 * changes what we claim about a row, never what the model is sent.
 */
export function transcriptRole<Metadata>(
  id: string,
  role: 'user' | 'assistant' | 'system',
  metadata?: Metadata,
): 'user' | 'assistant' | 'system' {
  return role === 'user' && turnAuthor({ id, metadata }) === 'harness' ? 'system' : role;
}

/** A stored conversation row projected for a transcript: its plain text, and
 *  the provenance metadata that decides who wrote it. */
export interface StoredRowProjection {
  text: string;
  metadata?: JsonObject;
}

/** A stored row's plain text and the provenance metadata beside it, from ONE
 *  parse. `assistant_messages` rows hold the serialized UI message and
 *  `messages` rows hold plain text; both reach this, so text that is not JSON
 *  is a value here and nothing else is. */
export function uiMessageRow(content: string): StoredRowProjection {
  const decoded = tolerate(() => parseJsonValue(content), 'malformed-input');
  if (decoded === undefined) return { text: content };
  const parsed = v.safeParse(UiMessageSchema, decoded);
  if (!parsed.success || !parsed.output.parts) return { text: content };
  const text = parsed.output.parts
    .flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : [])
    .join('');
  const metadata = parsed.output.metadata;
  return metadata === undefined ? { text } : { text, metadata };
}

/** {@link uiMessageRow}'s text half, for the callers that need nothing else. */
export function uiMessageText(content: string): string {
  return uiMessageRow(content).text;
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
