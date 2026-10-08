/**
 * What happened in a chat besides what was said, placed where it happened: an event joins the thread before the first
 * message written after it, not after everything since (production, 2026-10-08: they all collected at the bottom).
 */
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { UIMessage } from "ai";
import { ArrowUpRightIcon, CheckCircleIcon, ClockIcon, UserPlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { SubordinateActivityEvent } from "@kinu.run/core";
import { EventRow, foldRepeats } from "@/components/ProgrammaticTurnCard";
import { eventTurnKey, messageTime } from "@/components/MessageView";

/** One event to place: when it happened, what makes a repeat of it, and how it draws `count` times in a row. */
export interface PlacedEvent {
  readonly key: string;
  readonly at: number;
  readonly fold: string;
  readonly draw: (count: number) => ReactNode;
}

export interface EventPlacement {
  /** The events that go before the message at an index of the thread. */
  readonly before: ReadonlyMap<number, ReactNode>;
  /** The events that came after every message. */
  readonly after: ReactNode;
}

const drawRun = (run: readonly PlacedEvent[]): ReactNode => foldRepeats(run, (event) => event.fold)
  .map(({ item, count }) => <Fragment key={item.key}>{item.draw(count)}</Fragment>);

/** Each event before the first message written after it; a message with no time of its own moves none. */
export function placeEvents(messages: readonly UIMessage[], events: readonly PlacedEvent[]): EventPlacement {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const before = new Map<number, ReactNode>();
  let next = 0;

  for (const [index, message] of messages.entries()) {
    const at = messageTime(message);
    const due: PlacedEvent[] = [];

    for (let event = ordered[next]; at !== undefined && event !== undefined && event.at < at; event = ordered[next]) {
      due.push(event);
      next += 1;
    }

    if (due.length > 0) before.set(index, drawRun(due));
  }

  return { before, after: drawRun(ordered.slice(next)) };
}

/** How many times each turn nobody typed came in a row: the first of a run counts them all, the rest draw nothing. */
export function foldEventTurns(messages: readonly UIMessage[]): readonly number[] {
  const counts = messages.map(() => 1);
  let lead = -1;

  for (const [index, message] of messages.entries()) {
    const key = eventTurnKey(message);

    if (key !== null && lead >= 0 && eventTurnKey(messages[lead] ?? message) === key) {
      counts[lead] = (counts[lead] ?? 1) + 1;
      counts[index] = 0;
    } else {
      lead = key === null ? -1 : index;
    }
  }

  return counts;
}

type EventOutcome = "done" | "failed" | "progress";

function eventOutcome(status: string | undefined): EventOutcome {
  if (status === "completed") return "done";

  if (status === "failed" || status === "error") return "failed";

  return "progress";
}

const OUTCOME_MARK = {
  done: { icon: CheckCircleIcon, verb: "reported done", tone: "p-success" },
  failed: { icon: WarningCircleIcon, verb: "hit an error", tone: "p-danger" },
  progress: { icon: ClockIcon, verb: "reported progress", tone: "p-text-3" },
} as const;

/** An agent given work, or reporting on it, as the event it is: the agent's chat a link beside it. */
export function subordinateEventRow(event: SubordinateActivityEvent, workspace: string): PlacedEvent {
  const outcome = OUTCOME_MARK[eventOutcome(event.status)];
  const assigned = event.kind === "task";
  const detail = event.task === undefined || event.task === "" ? event.content : event.task;

  return {
    key: event.id,
    at: event.timestamp,
    fold: JSON.stringify([event.subordinate, event.kind, event.status, detail]),
    draw: (count) => (
      <EventRow
        icon={assigned ? UserPlusIcon : outcome.icon}
        tone={assigned ? "p-accent" : outcome.tone}
        label={event.subordinate}
        source={assigned ? "assigned" : outcome.verb}
        body={detail}
        count={count}
        hooks={{ "data-subordinate-event": event.kind }}
        action={(
          <Link
            to={`/workspace/${workspace}/agents/${event.subordinate}`}
            title={`Open ${event.subordinate}'s chat`}
            aria-label={`Open ${event.subordinate}'s chat`}
            className="mt-1 mr-1 flex size-6 shrink-0 items-center justify-center rounded-md p-text-4 transition-colors hover:bg-[var(--c-elevated)] hover:p-text-2"
          >
            <ArrowUpRightIcon size={11} />
          </Link>
        )}
      />
    ),
  };
}
