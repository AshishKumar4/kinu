/** The retry button sits beside the link, not inside it: a button in an anchor is nested interactive content. */
import { Link } from "react-router-dom";
import { overviewHeadline, shortAge, timeAgo, workspaceDisplayTitle, type WorkspaceOverview, type WorkspaceStatus } from "@kinu.run/core";
import { lastValue } from "@/hooks/use-async-resource";
import { useWorkspaceOverview } from "@/hooks/use-workspace-overviews";
import type { WorkspaceEntry } from "@/lib/user-api";

interface StatusTone {
  readonly dot: string;
  readonly text: string;
}

function workspaceStatusTone(status: WorkspaceStatus): StatusTone {
  switch (status) {
    case "needs":
      return { dot: "p-dot-warning", text: "p-warning" };
    case "working":
      return { dot: "p-dot-success p-dot-pulse", text: "p-success" };
    case "failed":
    case "unfinished":
      return { dot: "p-dot-danger", text: "p-danger" };
    case "updated":
    case "idle":
      return { dot: "p-dot-neutral", text: "p-text-3" };
  }
}

function StatusChip({ overview, stale, loading, unavailable }: {
  overview: WorkspaceOverview | null;
  stale: boolean;
  loading: boolean;
  unavailable: boolean;
}) {
  if (loading) return <span data-overview-chip className="p-t-status p-text-4">…</span>;

  if (unavailable || overview === null) {
    return <span data-overview-chip className="p-t-status p-text-4">unavailable</span>;
  }

  const headline = overviewHeadline(overview);
  const tone = workspaceStatusTone(headline.status);

  return (
    <span data-overview-chip
      className={`inline-flex items-center gap-1.5 whitespace-nowrap p-t-status ${stale ? "p-text-4" : tone.text}`}>
      <span aria-hidden="true"
        className={`size-1.5 rounded-full ${stale ? "p-dot-neutral" : tone.dot}`} />
      {headline.label}
    </span>
  );
}

/** The mission is omitted when it only repeats the title, which a first message that became the title always does. */
function missionOf(overview: WorkspaceOverview | null, title: string): string | null {
  const task = overview?.latestRun?.task;

  if (task === undefined || task === null || task === "") return null;

  return task.trim().toLowerCase() === title.trim().toLowerCase() ? null : task;
}

function hueOf(name: string): number {
  let hash = 0;

  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;

  return hash % 360;
}

/**
 * Rendered at four times the box and scaled down so the slate lays out at a real viewport width.
 * Inert: no pointer events, no tab stop, aria-hidden, sandbox without top-navigation or forms.
 */
function SlateFrame({ slate, hue }: { slate: NonNullable<WorkspaceOverview["primarySlate"]>; hue: number }) {
  return (
    <span
      data-slate-frame
      className="relative block aspect-[16/10] w-full overflow-hidden"
      style={{ background: `linear-gradient(180deg, oklch(62% 0.13 ${hue} / 0.28), oklch(62% 0.13 ${hue} / 0.08))` }}
    >
      <iframe
        src={slate.url}
        title={slate.title}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin"
        tabIndex={-1}
        aria-hidden
        className="absolute left-0 top-0 border-0"
        style={{ width: "400%", height: "400%", transform: "scale(0.25)", transformOrigin: "top left", pointerEvents: "none" }}
      />
    </span>
  );
}

export function WorkspaceOverviewCard({ workspace, variant, first = false }: {
  workspace: WorkspaceEntry;
  variant: 'line' | 'tile';
  first?: boolean;
}) {
  const { resource, reload } = useWorkspaceOverview(workspace.name);

  const overview = lastValue(resource);
  const stale = resource.status === "error" && overview !== null;
  const unavailable = resource.status === "error" && overview === null;
  const title = workspaceDisplayTitle(workspace);
  const mission = missionOf(overview, title);
  const age = shortAge(workspace.lastVisited);

  const retry = (stale || unavailable) && (
    <button
      type="button"
      onClick={() => reload()}
      className="shrink-0 self-center p-accent underline decoration-dotted underline-offset-2 p-t-status"
    >
      retry
    </button>
  );

  if (variant === 'line') {
    return (
      <div className={`flex h-14 items-center gap-3 px-4 transition-colors p-card-hover ${first ? "" : "border-t p-border"}`}>
        <Link to={`/workspace/${workspace.name}`} className="flex min-w-0 flex-1 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate p-row-text font-medium p-text">{title}</span>
            {mission !== null && <span className="block truncate p-meta p-text-3">{mission}</span>}
          </span>
          {stale && <span className="hidden shrink-0 p-meta p-text-4 sm:inline">checked {timeAgo(overview.observedAt)}</span>}
          <StatusChip overview={overview} stale={stale} loading={resource.status === "loading"} unavailable={unavailable} />
          {age !== null && <span className="shrink-0 p-meta p-text-4 tabular-nums">{age}</span>}
        </Link>
        {retry}
      </div>
    );
  }

  const hue = hueOf(workspace.name);
  const slate = overview?.primarySlate ?? null;

  return (
    <div className="p-card relative flex min-h-[150px] flex-col overflow-hidden transition-colors hover:p-elevated">
      {/* The picture is the link's sibling: an iframe inside an anchor is nested interactive content. */}
      {slate !== null && <SlateFrame slate={slate} hue={hue} />}
      <Link
        to={`/workspace/${workspace.name}`}
        className="flex min-h-0 flex-1 flex-col after:absolute after:inset-0 after:content-['']"
      >
        {slate === null && (
          <span
            className="flex h-14 items-end px-4 pb-2"
            style={{ background: `linear-gradient(180deg, oklch(62% 0.13 ${hue} / 0.28), oklch(62% 0.13 ${hue} / 0.08))` }}
          >
            <span
              className="flex size-8 items-center justify-center rounded-lg text-sm font-semibold"
              style={{ background: `oklch(62% 0.14 ${hue} / 0.35)`, color: `oklch(78% 0.12 ${hue})` }}
              aria-hidden="true"
            >
              {title.trim().charAt(0).toUpperCase() || "·"}
            </span>
          </span>
        )}
        <span className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-2.5">
          <span className="truncate p-row-text font-medium p-text">{title}</span>
          <span className="mt-1"><StatusChip overview={overview} stale={stale} loading={resource.status === "loading"} unavailable={unavailable} /></span>
          {mission !== null && <span className="mt-1.5 line-clamp-2 p-meta p-text-3">{mission}</span>}
          {age !== null && <span className="mt-auto self-end pt-2 p-meta p-text-4 tabular-nums">{age}</span>}
        </span>
      </Link>
      {/* Above the link's overlay, or the failed card's action would open the workspace instead of retrying. */}
      {retry && <span className="relative px-4 pb-3">{retry}</span>}
    </div>
  );
}
