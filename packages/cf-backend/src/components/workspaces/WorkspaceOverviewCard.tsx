/**
 * One workspace with its live overview, in the two shapes the app draws it:
 * the 56px line the home page's recent list and the Workspaces page share,
 * and the Workspaces page's grid tile. One component because the read
 * (`read-models/workspace-overview.ts`) is the same wherever it appears.
 *
 * Both shapes speak the one shared headline — `overviewHeadline`, exactly one
 * chip — beside the title, the last task when it says something the title
 * does not, and the bare relative time. The name renders the moment
 * the roster lands; the overview is the shared per-name read
 * (`use-workspace-overviews`) and fails independently. The retry button sits
 * BESIDE the link — a button inside an anchor is nested interactive content,
 * so the card is a wrapper holding the link and the action separately, and
 * the tile's slate picture hangs off that same wrapper.
 */
import { Link } from "react-router-dom";
import { overviewHeadline, shortAge, timeAgo, workspaceDisplayTitle, type WorkspaceOverview, type WorkspaceStatus } from "@kinu.run/core";
import { lastValue } from "@/hooks/use-async-resource";
import { useWorkspaceOverview } from "@/hooks/use-workspace-overviews";
import type { WorkspaceEntry } from "@/lib/user-api";

interface StatusTone {
  readonly dot: string;
  readonly text: string;
}

/** The one place a workspace's status becomes colour: a dot and a coloured
 *  word. `working` pulses like every other running dot in the app. */
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

/** The card's one chip: the shared headline's status as a dot and a coloured
 *  word, dimmed when its answer is old, `…` while it loads, `unavailable`
 *  when there is nothing to say from. */
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

/** The line and tile share their evidence: the mission is the last run's
 *  task preview, omitted when there is none — or when it only repeats the
 *  title, which a first message that became the title always does — and the
 *  timestamp is the bare relative time. */
function missionOf(overview: WorkspaceOverview | null, title: string): string | null {
  const task = overview?.latestRun?.task;

  if (task === undefined || task === null || task === "") return null;

  return task.trim().toLowerCase() === title.trim().toLowerCase() ? null : task;
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
  /** `line` is the ruled list entry (home's recent list, the Workspaces
   *  list); `tile` is a card in the Workspaces grid. */
  variant: 'line' | 'tile';
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
  const mission = missionOf(overview, title);
  // The same compact age the sidebar's column carries, so a workspace reads one age everywhere.
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
          {/* An old answer says so beside its chip; the chip alone only dims. */}
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
          {age !== null && <span className="mt-auto self-end pt-2 p-meta p-text-4 tabular-nums">{age}</span>}
        </span>
      </Link>
      {/* Above the link's overlay, or the one action on a failed card would
          open the workspace instead of retrying its read. */}
      {retry && <span className="relative px-4 pb-3">{retry}</span>}
    </div>
  );
}
