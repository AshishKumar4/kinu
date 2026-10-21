/**
 * How a thing stands, the one way the app says it: a dot and a word in the state's ink. `live` is running or working,
 * the accent, pulsing; `success` is done or healthy; `warning` needs a look. Accent and green stay apart where motion is
 * reduced and the pulse stops.
 */
export type StatusTone = "success" | "live" | "accent" | "warning" | "danger" | "info" | "neutral";

const TONE = {
  success: { dot: "p-dot-success", ink: "p-success", fill: "var(--c-success)" },
  live: { dot: "p-dot-accent p-dot-pulse", ink: "p-accent-fg", fill: "var(--c-accent)" },
  accent: { dot: "p-dot-accent", ink: "p-accent-fg", fill: "var(--c-accent)" },
  warning: { dot: "p-dot-warning", ink: "p-warning", fill: "var(--c-warning)" },
  danger: { dot: "p-dot-danger", ink: "p-danger", fill: "var(--c-danger)" },
  info: { dot: "p-dot-info", ink: "p-info", fill: "var(--c-info)" },
  neutral: { dot: "p-dot-neutral", ink: "p-text-3", fill: "var(--c-text-3)" },
} satisfies Record<StatusTone, { dot: string; ink: string; fill: string }>;

/** A tone's colour, for a mark drawn in it (a bar, a band) rather than a dot or a word. */
export function toneFill(tone: StatusTone): string {
  return TONE[tone].fill;
}

/** A tone's ink, for a word or an icon that says the state without the dot. */
export function toneInk(tone: StatusTone): string {
  return TONE[tone].ink;
}

export function Status({ tone, children, hooks }: {
  tone: StatusTone;
  children: React.ReactNode;
  /** Data attributes the flows find it by. */
  hooks?: Readonly<Record<`data-${string}`, string>>;
}) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap t-status ${TONE[tone].ink}`} {...hooks}>
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-[var(--r-pill)] ${TONE[tone].dot}`} />
      {children}
    </span>
  );
}

/** The dot alone, for a row that already names its state; `title` says it on hover. */
export function StatusDot({ tone, title, className = "" }: { tone: StatusTone; title?: string; className?: string }) {
  return <span aria-hidden={title === undefined} title={title} className={`size-1.5 shrink-0 rounded-[var(--r-pill)] ${TONE[tone].dot} ${className}`} />;
}

export type StatePillTone = "done" | "live" | "quiet";

const PILL_TONE = { done: "p-badge-success", live: "p-state-pill-live", quiet: "p-state-pill-quiet" } satisfies Record<StatePillTone, string>;

/** A run's state on its row, as a pill: `done` in the success tint, `live` on the selected ground, `quiet` on the fill. */
export function StatePill({ tone, children }: { tone: StatePillTone; children: React.ReactNode }) {
  return <span className={`t-status p-state-pill ${PILL_TONE[tone]}`}>{children}</span>;
}
