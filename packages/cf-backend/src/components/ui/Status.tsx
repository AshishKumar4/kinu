/**
 * How a thing stands, the one way the app says it: a dot and a word in the state's ink. `live` is running or working,
 * the accent, pulsing; `success` is done or healthy; `warning` needs a look. Accent and green stay apart where motion is
 * reduced and the pulse stops.
 */
import { Dot } from "./Dot";

export type StatusTone = "success" | "live" | "accent" | "warning" | "danger" | "info" | "neutral";

const INK = {
  success: "p-success",
  live: "p-accent-fg",
  accent: "p-accent-fg",
  warning: "p-warning",
  danger: "p-danger",
  info: "p-info",
  neutral: "p-text-3",
} satisfies Record<StatusTone, string>;

/** A tone's ink, for a word or an icon that says the state without the dot. */
export function toneInk(tone: StatusTone): string {
  return INK[tone];
}

export function Status({ tone, children, hooks }: {
  tone: StatusTone;
  children: React.ReactNode;
  /** Data attributes the flows find it by. */
  hooks?: Readonly<Record<`data-${string}`, string>>;
}) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap t-status ${INK[tone]}`} {...hooks}>
      <Dot tone={tone} />
      {children}
    </span>
  );
}

export type StatePillTone = "done" | "live" | "quiet";

const PILL_TONE = { done: "p-badge-success", live: "p-state-pill-live", quiet: "p-state-pill-quiet" } satisfies Record<StatePillTone, string>;

/** A run's state on its row, as a pill: `done` in the success tint, `live` on the selected ground, `quiet` on the fill. */
export function StatePill({ tone, children }: { tone: StatePillTone; children: React.ReactNode }) {
  return <span className={`t-status p-state-pill ${PILL_TONE[tone]}`}>{children}</span>;
}
