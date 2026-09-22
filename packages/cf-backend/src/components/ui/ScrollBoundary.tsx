/**
 * End-of-list boundary. `failed` must never look like `exhausted`, which only an 'end' page sets.
 * `idle` renders a spacer so the container height does not shift under the reader.
 */
import { Loader } from "@cloudflare/kumo";
import { CheckIcon } from "@phosphor-icons/react";
import { LoadFailure } from "./LoadFailure";

export interface ScrollBoundaryProps {
  /** Plural, lower-case: "forks", "runs". */
  what: string;
  /** Shown when exhausted; a count from a capped read is not a total. */
  count: number;
  loading: boolean;
  exhausted: boolean;
  error: string | null;
  onRetry: () => void;
}

export function ScrollBoundary({ what, count, loading, exhausted, error, onRetry }: ScrollBoundaryProps) {
  if (error !== null) {
    return (
      <div className="py-2">
        <LoadFailure what={`more ${what}`} message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-2 p-meta p-text-3"
        role="status" aria-live="polite">
        <Loader size="sm" />
        <span>Loading more {what}…</span>
      </div>
    );
  }

  if (exhausted) {
    return (
      <div className="flex items-center justify-center gap-1.5 py-2 p-meta p-text-3"
        role="status">
        <CheckIcon size={11} className="shrink-0 opacity-70" />
        <span>All {count} {what}</span>
      </div>
    );
  }

  return <div className="py-2" aria-hidden="true" />;
}
