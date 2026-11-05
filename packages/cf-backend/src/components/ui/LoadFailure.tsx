/** Rendered instead of an empty state: never report "none" for data that failed to load. */
import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "./Button";

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
      <Button size="sm" className="ml-auto shrink-0" icon={<ArrowsClockwiseIcon size={14} />} onClick={onRetry}>Retry</Button>
    </div>
  );
}
