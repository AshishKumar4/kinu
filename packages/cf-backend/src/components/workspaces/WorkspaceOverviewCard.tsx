/** One workspace on the roster, drawn from the tile its entry carries: the card reads nothing of its own. */
import { Link } from "react-router-dom";
import { rosterHeadline, shortAge, workspaceDisplayTitle, type WorkspaceOverview, type WorkspaceStatus, type RosterEntry } from "@kinu.run/core";
import { WorkspaceLogo } from "@/components/Marks";
import { SlatePicture } from "@/components/slates/SlatePicture";
import { Status, type StatusTone } from "@/components/ui/Status";

/** How a workspace stands, by core's one headline: the Workspaces card and the sidebar's dot read it alike. */
export function workspaceStatusTone(status: WorkspaceStatus): StatusTone {
  switch (status) {
    case "needs":
      return "warning";
    case "working":
      return "live";
    case "failed":
    case "unfinished":
      return "danger";
    case "updated":
    case "idle":
    case "unreported":
      return "neutral";
  }
}

function StatusChip({ workspace }: { workspace: RosterEntry }) {
  const headline = rosterHeadline(workspace.overview, workspace.decisions);

  return <Status tone={workspaceStatusTone(headline.status)} hooks={{ "data-overview-chip": "" }}>{headline.label}</Status>;
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

  return (
    <Link
      to={`/workspace/${workspace.name}`}
      className="p-card flex min-h-[150px] flex-col overflow-hidden transition-colors hover:p-elevated"
    >
      <SlatePicture workspace={workspace.name} slate={pictured} className="block aspect-[16/10] w-full border-b p-border object-cover object-top"
        fallback={(
          <span className="flex h-14 items-end border-b p-border p-recessed px-4 pb-2">
            <WorkspaceLogo title={title} logo={workspace.logo} size={32} />
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
