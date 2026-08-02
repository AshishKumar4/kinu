/**
 * The failed-fetch affordance: an honest "couldn't read this" plus the retry
 * such a failure always needs. Rendered in place of an empty state so no
 * surface ever reports "none" for something it never managed to read.
 */
import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";

export interface LoadFailureProps {
  /** What could not be loaded, lower-case: "automations", "the changelog". */
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
        Couldn't load {what}{message ? ` — ${message}` : ""}
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
