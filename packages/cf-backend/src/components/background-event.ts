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
 */

/** A turn the backend enqueued, never typed by the operator. */
export type ProgrammaticTurn =
  | { kind: "event_drain" }
  | { kind: "background_job"; jobKind: string; status: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" && value ? value : fallback;
}

/**
 * The provenance of a message, or null when the operator really did type it.
 *
 * Only the two events that arrive *on the agent's behalf* get a card. The
 * other programmatic turns (`mcp` — the operator talking through an MCP
 * client, `take_pick`, `overflow_retry`) are the operator's own words or a
 * mechanical re-send of them, so they keep the user bubble.
 */
export function classifyProgrammaticTurn(metadata: unknown): ProgrammaticTurn | null {
  if (!isRecord(metadata)) return null;
  switch (metadata.proteusEvent) {
    case "event_drain":
      return { kind: "event_drain" };
    case "background_job":
      return {
        kind: "background_job",
        jobKind: str(metadata, "kind", "task"),
        status: str(metadata, "status", "completed"),
      };
    default:
      return null;
  }
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
      events.push({ variant: match[1]!, source: match[2]!.trim(), brief: match[3]!, replyExpected: false });
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

const VARIANT_LABELS: Record<string, string> = {
  chat: "Chat message",
  webhook: "Webhook",
  process_done: "Process finished",
  timer: "Scheduled trigger",
  peer_agent: "Peer agent",
  subordinate_task: "Subordinate task",
  subordinate_report: "Subordinate report",
  file_changed: "File changed",
  email: "Email",
  internal: "Internal",
  reply_request: "Reply request",
  mcp_chat: "MCP message",
  mcp_third_party: "MCP client",
};

/** Human label for a hub event variant; unknown variants are de-snaked rather
 *  than relabelled, so a new backend variant still reads sensibly. */
export function eventVariantLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant.replace(/_/g, " ");
}
