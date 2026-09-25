/** One workspace on the roster, drawn from the tile its entry carries: the card reads nothing of its own. */
import { Link } from "react-router-dom";
import { rosterHeadline, shortAge, workspaceDisplayTitle, type WorkspaceOverview, type WorkspaceStatus } from "@kinu.run/core";
import type { RosterEntry } from "@/lib/user-api";
import { coverBadge, coverLetter, coverWash, hueOf } from "@/components/ui/cover";
import { SlatePicture } from "@/components/slates/SlatePicture";

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
    case "unreported":
      return { dot: "p-dot-neutral", text: "p-text-3" };
  }
}

function StatusChip({ workspace }: { workspace: RosterEntry }) {
  const headline = rosterHeadline(workspace.overview, workspace.decisions);
  const tone = workspaceStatusTone(headline.status);

  return (
    <span data-overview-chip className={`inline-flex items-center gap-1.5 whitespace-nowrap p-t-status ${tone.text}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${tone.dot}`} />
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

export function WorkspaceOverviewCard({ workspace, variant, first = false }: {
  workspace: RosterEntry;
  variant: 'line' | 'tile';
  first?: boolean;
}) {
  const { overview } = workspace;
  const title = workspaceDisplayTitle(workspace);
  const mission = missionOf(overview, title);
  const age = shortAge(workspace.lastVisited);
  const pictured = overview?.slates.find((slate) => slate.picture !== null);

  if (variant === 'line') {
    return (
      <div className={`flex h-14 items-center gap-3 px-4 transition-colors p-card-hover ${first ? "" : "border-t p-border"}`}>
        <Link to={`/workspace/${workspace.name}`} className="flex min-w-0 flex-1 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate p-row-text font-medium p-text">{title}</span>
            {mission !== null && <span className="block truncate p-meta p-text-3">{mission}</span>}
          </span>
          <StatusChip workspace={workspace} />
          {age !== null && <span className="shrink-0 p-meta p-text-4 tabular-nums">{age}</span>}
        </Link>
      </div>
    );
  }

  const hue = hueOf(workspace.name);

  return (
    <Link
      to={`/workspace/${workspace.name}`}
      className="p-card flex min-h-[150px] flex-col overflow-hidden transition-colors hover:p-elevated"
    >
      <SlatePicture workspace={workspace.name} slate={pictured} className="block aspect-[16/10] w-full border-b p-border object-cover object-top"
        fallback={(
          <span className="flex h-14 items-end px-4 pb-2" style={coverWash(hue)}>
            <span
              className="flex size-8 items-center justify-center rounded-lg text-sm font-semibold"
              style={coverBadge(hue)}
              aria-hidden="true"
            >
              {coverLetter(title)}
            </span>
          </span>
        )} />
      <span className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-2.5">
        <span className="truncate p-row-text font-medium p-text">{title}</span>
        <span className="mt-1"><StatusChip workspace={workspace} /></span>
        {mission !== null && <span className="mt-1.5 line-clamp-2 p-meta p-text-3">{mission}</span>}
        {age !== null && <span className="mt-auto self-end pt-2 p-meta p-text-4 tabular-nums">{age}</span>}
      </span>
    </Link>
  );
}
