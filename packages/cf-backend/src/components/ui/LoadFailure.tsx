/** Rendered instead of an empty state: never report "none" for data that failed to load. */
import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";

interface LoadFailureProps {
  /** Lower-case: "automations", "the changelog". */
  what: string;
  message?: string;
  onRetry: () => void;
  className?: string;
}

export function LoadFailure({ what, message, onRetry, className }: LoadFailureProps) {
  return (
    <div className={`t-meta flex items-start gap-2 p-danger ${className ?? ""}`}>
      <WarningCircleIcon size={14} className="mt-0.5 shrink-0" />
      {/* Its words wrap: a cut sentence says less than none. */}
      <span data-failure className="min-w-0 break-words" title={message}>
        Could not load {what}{message ? `: ${message}` : ""}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[var(--r-control)] border p-border px-2 py-1 p-text-2 hover:p-text"
      >
        <ArrowsClockwiseIcon size={14} /> Retry
      </button>
    </div>
  );
}
