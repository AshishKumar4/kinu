/**
 * How a thing stands, the one way the app says it: a dot and a word in the state's ink. `live` is running or working,
 * the accent, pulsing; `success` is done or healthy; `warning` needs a look. Accent and green stay apart where motion is
 * reduced and the pulse stops.
 */
export type StatusTone = "success" | "live" | "warning" | "danger" | "neutral";

const TONE = {
  success: { dot: "p-dot-success", ink: "p-success", fill: "var(--c-success)" },
  live: { dot: "p-dot-accent p-dot-pulse", ink: "p-accent", fill: "var(--c-accent)" },
  warning: { dot: "p-dot-warning", ink: "p-warning", fill: "var(--c-warning)" },
  danger: { dot: "p-dot-danger", ink: "p-danger", fill: "var(--c-danger)" },
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
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap p-t-status ${TONE[tone].ink}`} {...hooks}>
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE[tone].dot}`} />
      {children}
    </span>
  );
}

/** The dot alone, for a row that already names its state; `title` says it on hover. */
export function StatusDot({ tone, title, className = "" }: { tone: StatusTone; title?: string; className?: string }) {
  return <span aria-hidden={title === undefined} title={title} className={`size-1.5 shrink-0 rounded-full ${TONE[tone].dot} ${className}`} />;
}
