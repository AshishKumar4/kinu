/**
 * One workspace with its live overview, in the shapes the app draws it: the
 * home page's ruled roster row, the Workspaces page's 56px line, and its
 * grid tile. One component because the read (`read-models/workspace-overview.ts`)
 * is the same wherever it appears.
 *
 * The line and the tile speak the one shared headline — `overviewHeadline`,
 * exactly one chip — while the roster row keeps the home page's own label and
 * evidence row, whose copy the home gate pins. The name renders the moment
 * the roster lands; the overview is the shared per-name read
 * (`use-workspace-overviews`) and fails independently. The retry button sits
 * BESIDE the link — a button inside an anchor is nested interactive content,
 * so the card is a wrapper holding the link and the action separately, and
 * the tile's slate picture hangs off that same wrapper.
 */
import { Link } from "react-router-dom";
import { overviewHeadline, timeAgo, workspaceDisplayTitle, type WorkspaceHeadline, type WorkspaceOverview } from "@kinu.run/core";
import { lastValue } from "@/hooks/use-async-resource";
import { useWorkspaceOverview } from "@/hooks/use-workspace-overviews";
import type { WorkspaceEntry } from "@/lib/user-api";
import { OverviewEvidence, OverviewLabel } from "@/pages/home-overview-label";

/** The headline's tone words resolved to this surface's tokens. `live` is the
 *  pulsing accent dot, not accent text — one accent element per card — so the
 *  word itself stays plain. `muted` is the quiet register; a stale answer
 *  dims whatever tone it held to the quietest one. */
const TONE_CLS = {
  accent: "p-accent",
  live: "p-text",
  danger: "p-danger",
  muted: "p-text-3",
} satisfies Record<WorkspaceHeadline["tone"], string>;

/** The card's one chip: the shared headline, dimmed when its answer is old,
 *  `…` while it loads, `unavailable` when there is nothing to say from. */
function StatusChip({ overview, stale, loading, unavailable }: {
  overview: WorkspaceOverview | null;
  stale: boolean;
  loading: boolean;
  unavailable: boolean;
}) {
  if (loading) return <span data-overview-chip className="p-t-status p-text-4">…</span>;

  if (unavailable) return <span data-overview-chip className="p-t-status p-text-4">unavailable</span>;

  const headline = overviewHeadline(overview!);

  return (
    <span data-overview-chip
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full p-fill px-2 py-0.5 p-t-status ${stale ? "p-text-4" : TONE_CLS[headline.tone]}`}>
      {headline.tone === "live" && !stale && <span aria-hidden="true" className="p-dot-accent p-dot-pulse h-1.5 w-1.5 rounded-full" />}
      {headline.label}
    </span>
  );
}

/** The line and tile share their evidence: the mission is the last run's
 *  task preview, omitted when there is none, and the timestamp is the bare
 *  relative time — "Opened … ago" as a label is gone. */
function missionOf(overview: WorkspaceOverview | null): string | null {
  const task = overview?.latestRun?.task;

  return task === undefined || task === null || task === "" ? null : task;
}

/** A hue of the workspace's own, from its name: stable across sessions and
 *  devices, distinct between neighbours, and never the same for two tiles
 *  that sit together by chance of creation order. */
function hueOf(name: string): number {
  let hash = 0;

  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;

  return hash % 360;
}

/**
 * The tile's picture: the workspace's primary slate, live, at a quarter
 * scale. A slate is a durable application on a URL that outlives its
 * process, so the tile can hold the app itself — there is no screenshot
 * service and no capture to go stale.
 *
 * The frame renders at four times the box and is scaled down from its top
 * left, so the app lays out at a real viewport width instead of reflowing
 * into a phone column. It is inert in every direction: no pointer events, no
 * tab stop, out of the accessibility tree, and `sandbox` without
 * `allow-top-navigation` or `allow-forms`. The workspace's own colour is the
 * ground under it, so a slate that has not painted yet still reads as a tile.
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
  /** `row` is the home roster's ruled entry; `line` is the Workspaces list;
   *  `tile` is a card in its grid. */
  variant: 'row' | 'line' | 'tile';
  /** A row after the first draws the rule above it. */
  first?: boolean;
}) {
  // One shared read per name, whoever is watching it: the home list, the
  // Workspaces page and the shell's background all see the same answer.
  const { resource, reload } = useWorkspaceOverview(workspace.name);

  const overview = lastValue(resource);
  const stale = resource.status === "error" && overview !== null;
  const unavailable = resource.status === "error" && overview === null;
  const title = workspaceDisplayTitle(workspace);
  const mission = missionOf(overview);

  const retry = (stale || unavailable) && (
    <button
      type="button"
      onClick={() => reload()}
      className="shrink-0 self-center p-accent underline decoration-dotted underline-offset-2 p-t-status"
    >
      retry
    </button>
  );

  if (variant === 'row') {
    return (
      <div className={`flex items-center gap-2 px-[18px] py-3 transition-colors hover:p-elevated ${first ? "" : "border-t border-dashed border-[var(--c-dash)]"}`}>
        <Link
          to={`/workspace/${workspace.name}`}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 p-row-text p-text hover:p-accent"
        >
          <span className="w-full truncate">{title}</span>
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
        {retry}
      </div>
    );
  }

  if (variant === 'line') {
    return (
      <div className={`flex h-14 items-center gap-3 px-4 transition-colors p-card-hover ${first ? "" : "border-t p-border"}`}>
        <Link to={`/workspace/${workspace.name}`} className="flex min-w-0 flex-1 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate p-row-text font-medium p-text">{title}</span>
            {mission !== null && <span className="block truncate p-meta p-text-3">{mission}</span>}
          </span>
          <StatusChip overview={overview} stale={stale} loading={resource.status === "loading"} unavailable={unavailable} />
          {workspace.lastVisited > 0 && (
            <span className="shrink-0 p-meta p-text-4 tabular-nums">{timeAgo(workspace.lastVisited)}</span>
          )}
        </Link>
        {retry}
      </div>
    );
  }

  const hue = hueOf(workspace.name);
  const slate = overview?.primarySlate ?? null;

  return (
    <div className="p-card relative flex min-h-[150px] flex-col overflow-hidden transition-colors hover:p-elevated">
      {/* The picture is the link's SIBLING, never its child: an iframe inside
          an anchor is nested interactive content. The link stretches over the
          whole tile instead, so a click on the picture still opens the
          workspace. */}
      {slate !== null && <SlateFrame slate={slate} hue={hue} />}
      <Link
        to={`/workspace/${workspace.name}`}
        className="flex min-h-0 flex-1 flex-col after:absolute after:inset-0 after:content-['']"
      >
        {slate === null && (
          // The tile's own colour where there is nothing to show: a band and
          // a monogram in the workspace's hue.
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
          {workspace.lastVisited > 0 && (
            <span className="mt-auto self-end pt-2 p-meta p-text-4 tabular-nums">{timeAgo(workspace.lastVisited)}</span>
          )}
        </span>
      </Link>
      {/* Above the link's overlay, or the one action on a failed card would
          open the workspace instead of retrying its read. */}
      {retry && <span className="relative px-4 pb-3">{retry}</span>}
    </div>
  );
}
