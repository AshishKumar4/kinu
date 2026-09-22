/** Rendered instead of an empty state: never report "none" for data that failed to load. */
import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";

export interface LoadFailureProps {
  /** Lower-case: "automations", "the changelog". */
  what: string;
  message?: string;
  onRetry: () => void;
  className?: string;
}

export function LoadFailure({ what, message, onRetry, className }: LoadFailureProps) {
  return (
    <div className={`flex items-center gap-2 text-xs p-danger ${className ?? ""}`}>
      <WarningCircleIcon size={13} className="shrink-0" />
      <span className="min-w-0 truncate" title={message}>
        Could not load {what}{message ? `: ${message}` : ""}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border p-border px-2 py-1 p-text-2 hover:p-text"
      >
        <ArrowsClockwiseIcon size={11} /> Retry
      </button>
    </div>
  );
}
