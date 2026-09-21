/**
 * Turn authorship and the client-side transcript projection.
 *
 * A turn the backend enqueues on the agent's behalf (a settled background job,
 * the reactor draining hub events) is stored `role: 'user'` because that is
 * what the model must read it as. Nothing about that makes the operator its
 * author: the read models render it as the harness's words and the walk-back
 * fork declines to pivot on it. Provenance is stated at the write, in the order
 * the fallbacks degrade: the author stamp the enqueue seam puts on every
 * programmatic row, then the `kinuEvent` name, then the row id (which
 * {@link programmaticMessageId} derives, and which survives a fork copy that
 * preserves keys but not metadata).
 */

import type { UIMessage } from 'ai';
import * as v from 'valibot';
import type { JsonObject } from './json';
import type { ChatHistoryEntry } from '../types/chat';

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
 * This exists because the alternative drifts. Re-derive provenance per surface
 * from the EVENT NAME and it becomes a list inside a renderer: a chat pane that
 * recognises four of them (`background_job`, `event_drain`,
 * `workspace_created`, `deferred_approval`) renders everything else in the
 * operator's bubble, so every event kind added after that list —
 * `fork_interrupted`, `completion_gate`, `take_pick`, `overflow_retry` —
 * silently becomes something the owner appeared to have typed. Measured on the
 * owner's live workspaces on 2026-08-20: five `fork_interrupted` rows across
 * `sunlit-stone-4a20`, `stone-ash-71f2` and `principal-machine-f1296946`, each
 * reading "23 head(s) across 6 fork run(s) were still marked running…" in the
 * owner's own bubble.
 *
 * So the writer decides. A turn the harness enqueues is the harness speaking
 * unless its producer says otherwise, and the one producer that does say
 * otherwise is the one carrying words the operator really wrote (an MCP
 * client's `run_task`, a leftover steer re-run as its own turn). A new event
 * kind is therefore attributed correctly the day it is added, without touching
 * any renderer.
 */
export const TURN_AUTHOR_METADATA_KEY = 'kinuAuthor';

export type TurnAuthor = 'harness' | 'operator';

const TurnAuthorSchema = v.looseObject({
  [TURN_AUTHOR_METADATA_KEY]: v.optional(v.picklist(['harness', 'operator'])),
  kinuEvent: v.optional(v.string()),
});

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
 * The stamp answers it outright. A row without one still carries the
 * `kinuEvent` a queued signal stamps, and that names the harness: the one
 * producer carrying the operator's own words says so in its stamp. A row with
 * neither marker leans on its id, because the fork copy preserves primary keys
 * but not metadata. The id resolves to `harness`, the direction that cannot
 * put the harness's words in the owner's mouth.
 */
export function turnAuthor<Metadata>(row: { id?: string; metadata?: Metadata }): TurnAuthor {
  const parsed = v.safeParse(TurnAuthorSchema, row.metadata ?? {});

  if (parsed.success) {
    const stamped = parsed.output[TURN_AUTHOR_METADATA_KEY];

    if (stamped) return stamped;

    if (parsed.output.kinuEvent !== undefined) return 'harness';
  }

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

/**
 * The stored rows of older pages as renderable messages, oldest first,
 * self-deduplicated: a page boundary that re-delivered a row would render it
 * twice under one React key, which React resolves by silently dropping one — a
 * pagination bug would then look like a message going missing rather than like
 * a duplicate.
 *
 * A pure projection of the fetched pages — it knows nothing of the live list —
 * so a streaming pane can hold one projection (and its row identities) across
 * stream ticks and re-run only the live-overlap filter when the live window's
 * ids actually change.
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
 * carries the parts — tool calls, reasoning, attachments — that a restored
 * page renders from its stored text alone.
 *
 * What the restored copy DOES keep is the row's metadata, because that is not
 * presentation: it is the author stamp and the `kinuEvent` name a surface
 * decides who wrote the row from. A restored row without them is read as the
 * operator's own words.
 */
export function mergeTranscript(
  older: readonly ChatHistoryEntry[],
  live: readonly UIMessage[],
): UIMessage[] {
  const known = new Set(live.map((message) => message.id));

  return [...restoredRows(older).filter((row) => !known.has(row.id)), ...live];
}
