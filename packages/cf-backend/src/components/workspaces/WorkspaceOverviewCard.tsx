/** One workspace on the roster, drawn from the tile its entry carries: the card reads nothing of its own. */
import { Link } from "react-router-dom";
import { APP_ROUTES, rosterHeadline, shortAge, workspaceDisplayTitle, type WorkspaceOverview, type RosterEntry } from "@kinu.run/core";
import { SlatePicture } from "@/components/slates/SlatePicture";
import { ChatMascot } from "@/components/ui/Marks";
import { useMascotOf } from "@/hooks/use-chat-mascot";
import { Status } from "@/components/ui/Status";
import { TILE, TileShell, TypesetCover } from "@/components/ui/Tiles";
import { workspaceStatusTone } from "@/components/workspaces/workspace-status-tone";
import { wakeAheadOf } from "@/hooks/use-wake-ahead";


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
  // The owner's assistant is Home, and wears the face Home's bar shows it in.
  const to = workspace.home === true ? APP_ROUTES.home : `/workspace/${workspace.name}`;
  const face = useMascotOf(workspace.name)("main", 0);

  if (variant === 'line') {
    return (
      <div className={`p-hover-row flex h-14 items-center gap-3 px-4 ${first ? "" : "border-t p-border"}`}>
        <Link to={to} className="flex min-w-0 flex-1 items-center gap-3" {...wakeAheadOf(workspace.name)}>
          <span className="min-w-0 flex-1">
            <span className="t-item block truncate p-text">{title}</span>
            {mission !== null && <span className="t-meta block truncate p-text-3">{mission}</span>}
          </span>
          <StatusChip workspace={workspace} />
          {age !== null && <span className="t-meta shrink-0 p-text-3 tabular-nums">{age}</span>}
        </Link>
      </div>
    );
  }

  // Its primary slate's picture; without one, a typeset cover says what it is for, so the body need not say it again.
  const cover = (
    <SlatePicture mat workspace={workspace.name} slate={pictured} className="absolute inset-0 size-full object-cover object-top"
      fallback={<TypesetCover title={title} line={mission} logo={workspace.logo} mark={workspace.home === true ? <ChatMascot seed={face.seed} colour={face.colour} activity={undefined} size={32} /> : undefined} />} />
  );

  return (
    <Link to={to} className={TILE} {...wakeAheadOf(workspace.name)}>
      <TileShell cover={cover} title={title}>
        <span className="flex min-w-0 items-center gap-2">
          <StatusChip workspace={workspace} />
          {age !== null && <span className="t-meta ml-auto shrink-0 p-text-3 tabular-nums">{age}</span>}
        </span>
        {pictured !== undefined && mission !== null && <span className="t-meta line-clamp-1 p-text-3">{mission}</span>}
      </TileShell>
    </Link>
  );
}
