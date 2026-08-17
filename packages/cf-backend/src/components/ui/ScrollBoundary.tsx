/**
 * The growing edge of a paged list — the ONE affordance every scrollable
 * surface puts at the end of its items.
 *
 * There are four states here and they are four different claims, which is the
 * whole reason this is a component and not four ad-hoc rows:
 *
 *   loading   — a page is in flight. Says nothing about how much is left.
 *   exhausted — the read reached the end and said so. Only ever set by a page
 *               whose status was 'end', never inferred from a short page.
 *   failed    — the last page did not arrive. NOTHING was established about
 *               completeness, so this must never look like `exhausted`. A
 *               failed fetch rendered as an ended list is the defect that made
 *               a workspace's intact chat history look deleted.
 *   idle      — at rest, more to come, nothing in flight.
 *
 * `idle` renders a spacer rather than nothing, deliberately. A boundary that
 * appears and disappears changes the container's height on every page, and a
 * changing height nudges the viewport under the reader mid-scroll.
 *
 * The surface's FIRST load is not this component's job: nothing-loaded-yet is a
 * spinner and nothing-exists is an `EmptyState`, both of which belong to the
 * surface because only it knows what its own emptiness means.
 */
import { Loader } from "@cloudflare/kumo";
import { CheckIcon } from "@phosphor-icons/react";
import { LoadFailure } from "./LoadFailure";

export interface ScrollBoundaryProps {
  /** What is being paged, plural and lower-case: "forks", "runs". */
  what: string;
  /** How many are loaded. Shown when exhausted, where it is the one honest
   *  statement of total available — a count taken from a capped read never was. */
  count: number;
  loading: boolean;
  exhausted: boolean;
  /** The failure of the LAST page, or null. Never conflated with `exhausted`. */
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
      <div className="flex items-center justify-center gap-2 py-2 text-[11px] p-text-3"
        role="status" aria-live="polite">
        <Loader size="sm" />
        <span>Loading more {what}…</span>
      </div>
    );
  }
  if (exhausted) {
    return (
      <div className="flex items-center justify-center gap-1.5 py-2 text-[11px] p-text-3"
        role="status">
        <CheckIcon size={11} className="shrink-0 opacity-70" />
        <span>All {count} {what}</span>
      </div>
    );
  }
  return <div className="py-2" aria-hidden="true" />;
}
