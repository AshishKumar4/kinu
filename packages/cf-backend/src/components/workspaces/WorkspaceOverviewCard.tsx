/**
 * One workspace with its live overview, in the two shapes the app draws it:
 * the home page's ruled row and the Workspaces page's tile. One component,
 * because the evidence — the attention line, the chips, the retry — is the
 * same read (`read-models/workspace-overview.ts`) wherever it appears, and two
 * renderers of it would say two things about one workspace.
 *
 * The name renders the moment the roster lands; the overview is the shared
 * per-name read (`use-workspace-overviews`) and fails independently. The retry button sits BESIDE the link — a button
 * inside an anchor is nested interactive content, so the card is a wrapper
 * holding the link and the action separately.
 */
import { Link } from "react-router-dom";
import { timeAgo } from "@kinu.run/core";
import { lastValue } from "@/hooks/use-async-resource";
import { useWorkspaceOverview } from "@/hooks/use-workspace-overviews";
import type { WorkspaceEntry } from "@/lib/user-api";
import { OverviewEvidence, OverviewLabel } from "@/pages/home-overview-label";

export function WorkspaceOverviewCard({ workspace, variant, first = false }: {
  workspace: WorkspaceEntry;
  /** `row` is the home page's ruled list entry; `tile` is a card in a grid. */
  variant: 'row' | 'tile';
  /** A row after the first draws the dashed rule above it. */
  first?: boolean;
}) {
  // One shared read per name, whoever is watching it: the home list, the
  // Workspaces page and the shell's background all see the same answer.
  const { resource, reload } = useWorkspaceOverview(workspace.name);

  const overview = lastValue(resource);
  const stale = resource.status === "error" && overview !== null;
  const unavailable = resource.status === "error" && overview === null;

  const frame = variant === 'row'
    ? `flex items-center gap-2 px-[18px] py-3 transition-colors hover:p-elevated ${first ? "" : "border-t border-dashed border-[var(--c-dash)]"}`
    : "p-card flex min-h-[120px] items-start gap-2 p-4 transition-colors hover:p-elevated";

  return (
    <div className={frame}>
      <Link
        to={`/workspace/${workspace.name}`}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 p-row-text p-text hover:p-accent"
      >
        <span className={`w-full truncate${variant === 'tile' ? ' font-medium' : ''}`}>{workspace.displayName || workspace.name}</span>
        <span
          role="status"
          aria-live="polite"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 p-t-status"
        >
          {workspace.lastVisited > 0 && (
            <span className="hidden p-text-4 sm:inline">Opened {timeAgo(workspace.lastVisited)}</span>
          )}
          {resource.status === "loading" && <span className="p-text-4">…</span>}
          {overview !== null && <OverviewLabel overview={overview} stale={stale} />}
          {stale && <span className="p-text-4">Last checked {timeAgo(overview.observedAt)}</span>}
          {unavailable && <span className="p-warning">unavailable</span>}
          <span className="p-arrow" aria-hidden="true">→</span>
          {overview !== null && <OverviewEvidence overview={overview} stale={stale} />}
        </span>
      </Link>
      {(stale || unavailable) && (
        <button
          type="button"
          onClick={() => reload()}
          className="shrink-0 p-accent underline decoration-dotted underline-offset-2 p-t-status"
        >
          retry
        </button>
      )}
    </div>
  );
}
