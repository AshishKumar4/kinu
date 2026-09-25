/**
 * Background-event provenance for chat event cards. Programmatic turns are stored as
 * `role: "user"`; `metadata.kinuEvent` (set by BackendHost.enqueueTurn) marks them as not typed by
 * the operator. A signal card and its durable message are joined by `metadata.signalId`.
 */

import {
  ADVISOR_SIGNAL_KIND, DEFAULT_ADVISOR_MIN_SEVERITY, isAdvisorSeverity,
  type AdvisorSeverity,
} from '../advisor/review';
import type { BroadcastEvent } from '../types/backend-host';
import { SIGNAL_ID_METADATA_KEY } from '../types/signals';
import type { SignalCardEvent, SignalCardState } from '../types/signals';
import { turnAuthor } from '../utils/ui-message';
import { JsonObjectSchema, type JsonObject } from '../utils/json';
import * as v from 'valibot';

/** A turn the backend enqueued; `system_event` is any harness event without its own card. */
export type ClassifiedProgrammaticTurn =
  | { kind: "workspace_created" }
  | { kind: "event_drain" }
  | { kind: "background_job"; jobKind: string; status: string }
  | { kind: "deferred_approval"; decision: string; count: number }
  | { kind: "advisor"; severity: AdvisorSeverity }
  | { kind: "system_event"; event: string };

const ProgrammaticMetadataSchema = v.looseObject({
  kinuEvent: v.optional(v.string()),
  advisorSeverity: v.optional(v.string()),
  kind: v.optional(v.string()),
  status: v.optional(v.string()),
  decision: v.optional(v.string()),
  count: v.optional(v.number()),
});

/** An empty-string metadata field takes the same default as an absent one. */
function cardField(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

const SignalCardEventSchema = v.variant('state', [
  v.object({ type: v.literal('signal_card'), id: v.string(), state: v.picklist(['shown', 'undelivered']) }),
  v.object({
    type: v.literal('signal_card'), id: v.string(), state: v.literal('pending'),
    metadata: JsonObjectSchema, text: v.string(),
  }),
]);

/**
 * Provenance of a message, or null when the operator typed it. Decided by `turnAuthor` from
 * written markers, never prose; unknown harness events fall back to `system_event`, not operator.
 */
export function classifyProgrammaticTurn(
  row: { metadata: unknown; id?: string },
): ClassifiedProgrammaticTurn | null {
  const { metadata, id } = row;

  if (turnAuthor({ id, metadata }) === "operator") return null;
  const parsed = v.safeParse(ProgrammaticMetadataSchema, metadata);
  const turn = parsed.success ? parsed.output : {};

  switch (turn.kinuEvent) {
    case "workspace_created":
      return { kind: "workspace_created" };
    case "event_drain":
      return { kind: "event_drain" };
    case "background_job":
      return {
        kind: "background_job",
        jobKind: cardField(turn.kind, "task"),
        status: cardField(turn.status, "completed"),
      };
    case "deferred_approval":
      return {
        kind: "deferred_approval",
        decision: cardField(turn.decision, "decided"),
        count: turn.count ?? 1,
      };
    case ADVISOR_SIGNAL_KIND:
      return {
        kind: "advisor",
        severity: isAdvisorSeverity(turn.advisorSeverity) ? turn.advisorSeverity : DEFAULT_ADVISOR_MIN_SEVERITY,
      };
    case undefined:
    default:
      return { kind: "system_event", event: cardField(turn.kinuEvent, "system") };
  }
}

function metadataField<T>(row: { metadata: unknown }, key: string, schema: v.GenericSchema<T>): T | undefined {
  const metadata = v.safeParse(v.looseObject({}), row.metadata);

  if (!metadata.success) return undefined;
  const field = v.safeParse(schema, metadata.output[key]);

  return field.success ? field.output : undefined;
}

/** The signal id a programmatic message carries, joining it to its card. */
export function messageSignalId(row: { metadata: unknown }): string | null {
  const id = metadataField(row, SIGNAL_ID_METADATA_KEY, v.string());

  return id === undefined || id === '' ? null : id;
}

/** Whether a durable user row was a mid-turn steer (actor stamps `kinuSteer`). */
export function isSteeredMessage(row: { metadata: unknown }): boolean {
  return metadataField(row, 'kinuSteer', v.boolean()) === true;
}

/** Metadata key on a settled answer whose turn ended `incomplete`; other end reasons have their
 *  own surface. */
export const TURN_END_METADATA_KEY = 'kinuTurnEnd';

/** Whether the turn ended while the model was still calling tools. */
export function endedMidWork(row: { metadata: unknown }): boolean {
  return metadataField(row, TURN_END_METADATA_KEY, v.string()) === 'incomplete';
}

export interface SignalCard {
  readonly id: string;
  readonly metadata: Readonly<JsonObject>;
  /** The signal as the agent will read it. */
  readonly text: string;
  readonly state: Exclude<SignalCardState, "undelivered">;
}

/** Mid-turn splices are never persisted, so live cards age out by count, not turn boundary. */
const MAX_LIVE_CARDS = 50;

/**
 * Reduce the `signal_card` stream to the live card list. A transition for an unseen id is
 * ignored: the client connected mid-flight and its history already shows the message.
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
export function parseSignalCardEvent(frame: { value: unknown }): SignalCardEvent | null {
  const parsed = v.safeParse(SignalCardEventSchema, frame.value);

  return parsed.success ? parsed.output : null;
}

/** One hub event as the agent was shown it (core's `renderForLLM`). */
export interface DrainedEvent {
  variant: string;
  source: string;
  brief: string;
  replyExpected: boolean;
}

// The source may carry a parenthesized label containing colons (`schedule (deploy:nightly)`).
const EVENT_LINE = /^- \[([^\]]+)\] from ((?:[^:(]|\([^)]*\))+): ([\s\S]*)$/;

const REPLY_HINT = /\s*\[the sender awaits your answer[\s\S]*\]$/;

/** Events inside a drain turn's text; [] when the text is not a drain listing. */
export function parseDrainedEvents(text: string): DrainedEvent[] {
  const events: DrainedEvent[] = [];

  for (const line of text.split("\n")) {
    const match = EVENT_LINE.exec(line);

    if (!match) continue;
    const [, variant, source, brief] = match;

    if (variant === undefined || source === undefined || brief === undefined) continue;
    events.push({ variant, source: source.trim(), brief, replyExpected: false });
  }

  for (const event of events) {
    event.replyExpected = REPLY_HINT.test(event.brief);
    // The drain escapes untrusted CR/LF as `\n` (events/hub/drain.ts `oneLine`); restore them.
    event.brief = event.brief
      .replace(REPLY_HINT, "")
      .replace(/\\n/g, "\n")
      .trim();
  }

  return events;
}

const VARIANT_LABELS = new Map([
  ["chat", "Chat message"],
  ["webhook", "Webhook"],
  ["process_done", "Process finished"],
  ["timer", "Scheduled trigger"],
  ["peer_agent", "Peer agent"],
  ["subordinate_task", "Agent task"],
  ["subordinate_report", "Agent report"],
  ["file_changed", "File changed"],
  ["email", "Email"],
  ["internal", "Internal"],
  ["reply_request", "Reply request"],
  ["mcp_chat", "MCP message"],
  ["mcp_third_party", "MCP client"],
]);

/** Unknown variants are de-snaked so a new backend variant still reads sensibly. */
export function eventVariantLabel(variant: string): string {
  return VARIANT_LABELS.get(variant) ?? variant.replace(/_/g, " ");
}

/** Internal event sources keep their stable vocabulary; owner copy does not. */
export function eventSourceLabel(source: string): string {
  return source.replace(/^subordinate(?=$|[\s(])/i, "Agent");
}

/** The one construction site for a metadata-bearing broadcast event. */
export function metadataBroadcastEvent(
  type: string,
  metadata: JsonObject,
  fields?: {
    readonly id?: string;
    readonly state?: string;
    readonly status?: string;
    readonly text?: string;
    readonly branchId?: string;
    readonly task?: string;
    readonly takeSetId?: string;
    readonly turnId?: string;
    readonly message?: string;
    readonly displayName?: string;
    readonly steerId?: string;
    readonly atStep?: number;
    readonly jobId?: string;
  },
): BroadcastEvent {
  return { type, metadata, ...fields };
}
