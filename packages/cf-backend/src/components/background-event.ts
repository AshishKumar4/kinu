/**
 * Background-event provenance — the pure half of the chat's event cards.
 *
 * Turns the backend enqueues on the agent's behalf (the reactor draining hub
 * events, a background job returning) are stored as `role: "user"` messages so
 * the model reads them as its turn input. They are not the operator speaking,
 * and rendering them in the user's bubble says they were. `metadata.proteusEvent`
 * — stamped by BackendHost.enqueueTurn — is the provenance that tells them
 * apart, and the drain text the reactor composes is itself structured
 * (`- [variant] from source: brief`), so the card can show the events rather
 * than the prompt wrapped around them.
 *
 * A card exists from the moment the event HAPPENED, which is not the moment the
 * agent reads it: the delivery seam broadcasts `signal_card` when it routes a
 * signal and again when a step (or the turn it started) takes it in, so the
 * same card shows "to be shown to the agent" and then "shown to the agent".
 * {@link applySignalCard} is that stream reduced to the live card list. A
 * signal that starts a turn also becomes a durable message; the two are one
 * card, joined by `metadata.signalId`, so the list renders only what has no
 * message yet (or never will — a mid-turn splice is never persisted).
 */

import {
  JsonObjectSchema, SIGNAL_ID_METADATA_KEY, turnAuthor,
  type JsonObject, type SignalCardEvent, type SignalCardState,
} from "@kinu/core";
import * as v from 'valibot';

/** A turn the backend enqueued, never typed by the operator. `system_event` is
 *  the rest: harness-authored, with no card of its own. */
export type ProgrammaticTurn =
  | { kind: "event_drain" }
  | { kind: "workspace_created" }
  | { kind: "background_job"; jobKind: string; status: string }
  | { kind: "deferred_approval"; decision: string; count: number }
  | { kind: "system_event"; event: string };

const ProgrammaticMetadataSchema = v.looseObject({
  proteusEvent: v.optional(v.string()),
  kind: v.optional(v.string()),
  status: v.optional(v.string()),
  decision: v.optional(v.string()),
  count: v.optional(v.number()),
});
const SignalCardEventSchema = v.variant('state', [
  v.object({ type: v.literal('signal_card'), id: v.string(), state: v.picklist(['shown', 'undelivered']) }),
  v.object({
    type: v.literal('signal_card'), id: v.string(), state: v.literal('pending'),
    metadata: JsonObjectSchema, text: v.string(),
  }),
]);

/**
 * The provenance of a message, or null when the operator really did type it.
 *
 * The decision is `turnAuthor`'s and is made from written markers — the author
 * stamp the enqueue seam puts on every programmatic row, or, on rows written
 * before that stamp existed, the `proteusEvent` metadata and the
 * `programmatic:` id prefix. Nothing here reads the prose.
 *
 * Four events have a card that says what happened without the harness's
 * wording; everything else harness-authored is `system_event`, which shows the
 * event's name and keeps its words folded away. That fallback is the point:
 * this used to be an allowlist of those four, so every event kind added after
 * it — `fork_interrupted`, `completion_gate`, `take_pick`, `overflow_retry` —
 * arrived in the owner's own bubble, and five `fork_interrupted` rows were
 * sitting in the owner's live transcripts saying so.
 *
 * `deferred_approval` is the odd one: the OWNER did decide it, in the queue.
 * But the words in the turn are the harness's, not theirs, and rendering them
 * as something the owner typed would be the same misattribution the other
 * cards exist to prevent.
 *
 * `workspace_created` is the workspace's own first turn. The owner typed a
 * MISSION in the New workspace dialog, not a message — the mission is the soul
 * and reaches the agent through the system prompt. What lands in the transcript
 * is the harness telling the agent it is open, so it wears a card too.
 */
export function classifyProgrammaticTurn<Metadata>(
  metadata: Metadata, id?: string,
): ProgrammaticTurn | null {
  if (turnAuthor({ id, metadata }) === "operator") return null;
  const parsed = v.safeParse(ProgrammaticMetadataSchema, metadata);
  const turn = parsed.success ? parsed.output : {};
  switch (turn.proteusEvent) {
    case "event_drain":
      return { kind: "event_drain" };
    case "workspace_created":
      return { kind: "workspace_created" };
    case "background_job":
      return {
        kind: "background_job",
        jobKind: turn.kind || "task",
        status: turn.status || "completed",
      };
    case "deferred_approval":
      return {
        kind: "deferred_approval",
        decision: turn.decision || "decided",
        count: turn.count ?? 1,
      };
    default:
      return { kind: "system_event", event: turn.proteusEvent || "system" };
  }
}

/** The signal id a programmatic message carries, joining it to its card. */
export function messageSignalId<Metadata>(metadata: Metadata): string | null {
  const parsed = v.safeParse(v.looseObject({ [SIGNAL_ID_METADATA_KEY]: v.optional(v.string()) }), metadata);
  if (!parsed.success) return null;
  return parsed.output[SIGNAL_ID_METADATA_KEY] || null;
}

/** Whether a durable user row is one the agent was STEERED with mid-turn (the
 *  actor stamps `proteusSteer` when it persists a drained steer). It is a real
 *  user message either way — this only decides whether the thread explains why
 *  it appears inside another turn's work. */
export function isSteeredMessage<Metadata>(metadata: Metadata): boolean {
  const parsed = v.safeParse(v.looseObject({ proteusSteer: v.optional(v.boolean()) }), metadata);
  return parsed.success && parsed.output.proteusSteer === true;
}

/** One live background-event card: an event that has happened, and whether the
 *  agent has read it yet. */
export interface SignalCard {
  readonly id: string;
  /** Classifier input — the same `proteusEvent` metadata a queued signal's
   *  durable message carries. */
  readonly metadata: Readonly<JsonObject>;
  /** The signal as the agent will read it. */
  readonly text: string;
  readonly state: Exclude<SignalCardState, "undelivered">;
}

/** How many live cards the chat keeps. A mid-turn splice is never persisted,
 *  so its card is the only record of it in this session — old ones age out
 *  rather than being dropped on turn boundaries. */
const MAX_LIVE_CARDS = 50;

/**
 * The `signal_card` stream reduced to the chat's live card list: delivery adds
 * the card, a later event moves that same card, and a delivery that never
 * landed removes it (its work is compensated back; a later delivery opens a
 * new card). A transition for an id we never saw opened is ignored — that is
 * a client which connected mid-flight, and its history already shows the
 * message.
 */
export function applySignalCard(
  cards: readonly SignalCard[], event: SignalCardEvent,
): readonly SignalCard[] {
  if (event.state === "pending") {
    const card: SignalCard = {
      id: event.id, metadata: event.metadata, text: event.text, state: "pending",
    };
    const existing = cards.findIndex((c) => c.id === card.id);
    if (existing >= 0) return cards.map((c, i) => i === existing ? card : c);
    return [...cards.slice(-(MAX_LIVE_CARDS - 1)), card];
  }
  if (event.state === "undelivered") return cards.filter((c) => c.id !== event.id);
  return cards.map((c) => c.id === event.id ? { ...c, state: "shown" } : c);
}

/** Parse a broadcast frame into a card event, or null when it is not one. */
export function parseSignalCardEvent<Value>(value: Value): SignalCardEvent | null {
  const parsed = v.safeParse(SignalCardEventSchema, value);
  return parsed.success ? parsed.output : null;
}

/** One hub event as the agent was shown it (core's `renderForLLM`). */
export interface DrainedEvent {
  /** Hub event variant — `subordinate_report`, `webhook`, `timer`, … */
  variant: string;
  /** Where it came from, e.g. `subordinate (surface-auditor)`. */
  source: string;
  /** The event body the agent read. */
  brief: string;
  /** The sender is blocked awaiting this turn's `peers({action:'reply'})`. */
  replyExpected: boolean;
}

// `- [variant] from source: brief`, where the source may itself carry a
// parenthesized label containing colons (`schedule (deploy:nightly)`).
const EVENT_LINE = /^- \[([^\]]+)\] from ((?:[^:(]|\([^)]*\))+): ([\s\S]*)$/;
const REPLY_HINT = /\s*\[the sender awaits your answer[\s\S]*\]$/;

/**
 * The events inside a drain turn's text. The leading instruction line and the
 * mechanical reply hint are the prompt around the events, not content — they
 * are dropped (the hint becomes a flag). Returns [] when the text is not a
 * drain listing, which is the caller's signal to show it verbatim rather than
 * guess.
 */
export function parseDrainedEvents(text: string): DrainedEvent[] {
  const events: DrainedEvent[] = [];
  for (const line of text.split("\n")) {
    const match = EVENT_LINE.exec(line);
    if (match) {
      const [, variant, source, brief] = match;
      if (variant === undefined || source === undefined || brief === undefined) continue;
      events.push({ variant, source: source.trim(), brief, replyExpected: false });
      continue;
    }
    // A brief can run to several lines (an inherited-context assignment does);
    // anything before the first event is the instruction line.
    const previous = events[events.length - 1];
    if (previous) previous.brief += `\n${line}`;
  }
  // The hint sits at the end of the whole brief, so it is stripped only once
  // the continuation lines are in.
  for (const event of events) {
    event.replyExpected = REPLY_HINT.test(event.brief);
    event.brief = event.brief.replace(REPLY_HINT, "").trim();
  }
  return events;
}

const VARIANT_LABELS = new Map([
  ["chat", "Chat message"],
  ["webhook", "Webhook"],
  ["process_done", "Process finished"],
  ["timer", "Scheduled trigger"],
  ["peer_agent", "Peer agent"],
  ["subordinate_task", "Subordinate task"],
  ["subordinate_report", "Subordinate report"],
  ["file_changed", "File changed"],
  ["email", "Email"],
  ["internal", "Internal"],
  ["reply_request", "Reply request"],
  ["mcp_chat", "MCP message"],
  ["mcp_third_party", "MCP client"],
]);

/** Human label for a hub event variant; unknown variants are de-snaked rather
 *  than relabelled, so a new backend variant still reads sensibly. */
export function eventVariantLabel(variant: string): string {
  return VARIANT_LABELS.get(variant) ?? variant.replace(/_/g, " ");
}
