/** How a thing stands, the one way the app says it: a dot and a word in the state's ink. `live` pulses while it works. */
export type StatusTone = "success" | "live" | "warning" | "danger" | "neutral";

const TONE = {
  success: { dot: "p-dot-success", ink: "p-success" },
  live: { dot: "p-dot-success p-dot-pulse", ink: "p-success" },
  warning: { dot: "p-dot-warning", ink: "p-warning" },
  danger: { dot: "p-dot-danger", ink: "p-danger" },
  neutral: { dot: "p-dot-neutral", ink: "p-text-3" },
} satisfies Record<StatusTone, { dot: string; ink: string }>;

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

/** The dot alone, for a row that already names its state. */
export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE[tone].dot}`} />;
}
