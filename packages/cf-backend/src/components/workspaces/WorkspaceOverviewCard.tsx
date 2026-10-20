/** One workspace on the roster, drawn from the tile its entry carries: the card reads nothing of its own. */
import { Link } from "react-router-dom";
import { APP_ROUTES, rosterHeadline, shortAge, workspaceDisplayTitle, type WorkspaceOverview, type RosterEntry } from "@kinu.run/core";
import { WorkspaceLogo } from "@/components/Marks";
import { SlatePicture } from "@/components/slates/SlatePicture";
import { Status } from "@/components/ui/Status";
import { workspaceStatusTone } from "@/components/workspaces/workspace-status-tone";


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
  // The owner's assistant is Home.
  const to = workspace.home === true ? APP_ROUTES.home : `/workspace/${workspace.name}`;

  if (variant === 'line') {
    return (
      <div className={`flex h-14 items-center gap-3 px-4 transition-colors p-card-hover ${first ? "" : "border-t p-border"}`}>
        <Link to={to} className="flex min-w-0 flex-1 items-center gap-3">
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
      to={to}
      className="p-card flex min-h-[150px] flex-col overflow-hidden transition-colors hover:p-elevated"
    >
      {/* Its primary slate's picture; without one, its logo on the same recessed ground as Explore's tiles (`Cover`). */}
      <SlatePicture workspace={workspace.name} slate={pictured} className="block aspect-[16/10] w-full border-b p-border object-cover object-top"
        fallback={(
          // One column on a phone: no row to line up with, so the logo's ground stays short there.
          <span className="flex aspect-[3/1] w-full items-center justify-center border-b p-border p-recessed sm:aspect-[16/10]">
            <WorkspaceLogo title={title} logo={workspace.logo} size={36} />
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
