/**
 * What a focus workspace's bar says under its main agent's name (docs/HOME-EXPLORE.md §2): while a turn is live, the
 * step it is on, in a few words; at rest, what it watches and when it next looks. Muse, Meta's personal agent, which the
 * owner set as the bar (1018-xao), has a status line ("Is working", "Making something") and an Upcoming list. Null where
 * neither has anything to say, so the bar falls back to the agent's activity.
 */
import { clockTime } from "../utils/format";
import type { LiveTail } from "./message-live-tail";
import { ongoing } from "./tool-phase-title";

/** The step a live turn is on: the call running, in its row's words, else writing or thinking. Null at rest. */
export function liveStep(tail: LiveTail | null): string | null {
  if (tail === null) return null;

  if (tail.kind === "tool") return ongoing(tail.part);

  return tail.kind === "text" ? "Writing" : "Thinking";
}

/** A trigger as the bar counts it (`listTriggers`): armed or not, its own label, and when it next fires (null for one
 *  that fires on an arrival, as mail does). */
export interface Watch {
  readonly state: string;
  readonly spec: { readonly label?: unknown };
  readonly next_fire_at: number | null;
}

/** "Watching 4 · Daily brief tomorrow 8:00 AM": how many it watches, and the next one due, by its own label. */
export function watchingLine(watches: readonly Watch[], now: number): string | null {
  const armed = watches.filter((watch) => watch.state === "active");

  if (armed.length === 0) return null;

  const [next] = armed.filter((watch) => watch.next_fire_at !== null).sort((a, b) => (a.next_fire_at ?? 0) - (b.next_fire_at ?? 0));
  const watching = `Watching ${String(armed.length)}`;

  if (next?.next_fire_at === undefined || next.next_fire_at === null) return watching;

  const label = typeof next.spec.label === "string" && next.spec.label !== "" ? next.spec.label : "next";

  return `${watching} · ${label} ${dueAt(next.next_fire_at, now)}`;
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** A next look in the reader's own day: its time today, "tomorrow" and its time, or its weekday and time. */
function dueAt(at: number, now: number): string {
  const days = Math.round((midnight(at) - midnight(now)) / 864e5);

  if (days <= 0) return clockTime(at);

  return `${days === 1 ? "tomorrow" : WEEKDAY.format(at)} ${clockTime(at)}`;
}

function midnight(at: number): number {
  const day = new Date(at);

  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}
