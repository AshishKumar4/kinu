/**
 * Work — what needs me, what is happening, what happened.
 *
 * Three time-facets of ONE question, not three old tabs stacked. Tasks (the
 * plan), Jobs (detached work) and the Evolution Changelog (what it changed
 * about itself) each answered a slice of "what is this thing working through",
 * and each had its own room: two of them photographed as three or four cards
 * floating in ~90% empty column, and the third was filed under the agent's own
 * description where nobody returning from a day away would look for it.
 *
 *   Needs you — the pending-action queue. Rendered only when non-empty. Every
 *               row deep-links to where the decision is actually made; nothing
 *               is decided twice. Host-owned: `listPendingActions` is
 *               deliberately not a data source an agent-authored view can read
 *               (core/src/views/sources.ts).
 *   Now       — the plan's open half and the jobs still running.
 *   Journal   — one reverse-chronological feed of everything settled: jobs,
 *               closed tasks, self-changes. The chips filter that one list;
 *               they are views, not homes.
 *
 * What it does NOT absorb: chat cards stay chat cards. A job settling
 * mid-conversation still gets its transcript card — the journal is where it can
 * be acted on later, not a second narration. And the run's meters stay on the
 * gauge beside the strip, which was already the right home for them.
 */
import { useCallback, useMemo, useState } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  ClockIcon, PulseIcon, WarningCircleIcon, GitBranchIcon,
  RocketLaunchIcon, PackageIcon, SparkleIcon, CaretRightIcon,
} from "@phosphor-icons/react";
import type { AgentTaskTree, ChangelogEntry, PendingAction, PendingActionKind } from "@proteus/core";
import type { BackgroundJob, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState, Section, timeAgo } from "./shared";
import { isClosedTree, isSettled, PlanProgress, TaskTree } from "./work-tasks";
import { JobCard } from "./work-jobs";
import { ChangelogEntryCard, ChangelogFailure, useChangelog } from "./changelog-entries";
import type { SurfaceKind } from "./WorkSurface";

/** Which filter a journal row answers to. `All` is not a filter, it is no
 *  filter — the chips are views over one list. */
type JournalFilter = "all" | "jobs" | "plan" | "self";

const FILTERS: Array<{ id: JournalFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "jobs", label: "Jobs" },
  { id: "plan", label: "Plan" },
  { id: "self", label: "Self-changes" },
];

/** Where each kind of pending thing is actually decided. The mapping lives
 *  here, not in the read model: core has no business knowing tab names. */
const PENDING_HOME: Record<PendingActionKind, { surface: SurfaceKind | null; where: string }> = {
  release_approval: { surface: "Releases", where: "Releases" },
  scaffold_version: { surface: "Agent", where: "Agent → Evolution" },
  failed_job: { surface: null, where: "the journal below" },
  unseen_changes: { surface: null, where: "the journal below" },
  curriculum_task: { surface: null, where: "Supervise" },
};

const PENDING_ICON: Record<PendingActionKind, typeof ClockIcon> = {
  release_approval: RocketLaunchIcon,
  scaffold_version: GitBranchIcon,
  failed_job: WarningCircleIcon,
  unseen_changes: SparkleIcon,
  curriculum_task: PackageIcon,
};

export interface WorkTabProps {
  /** Polled by the hook so the tab badge and this queue are one read. */
  pendingActions: PendingAction[];
  backgroundJobs: BackgroundJob[];
  onRefreshJobs: () => void;
  /** Deep-link a queue row to where its decision is made. */
  onOpenSurface: (surface: SurfaceKind) => void;
  /** The changelog was seen — zero the badge upstream. */
  onChangelogSeen?: () => void;
  /** A turn is in flight — the plan is rewritten while it is. */
  isStreaming: boolean;
  rpc: Rpc;
}

export function WorkTab({
  pendingActions, backgroundJobs, onRefreshJobs, onOpenSurface, onChangelogSeen, isStreaming, rpc,
}: WorkTabProps) {
  const [filter, setFilter] = useState<JournalFilter>("all");

  const loadTasks = useCallback(() => rpc<AgentTaskTree[]>("listAgentTasks", []), [rpc]);
  // The agent writes its plan mid-turn and the server never pushes it, so the
  // view revalidates while anything is still open and stands down once
  // everything has settled.
  const revalidate = useCallback((tasks: AgentTaskTree[] | null) => {
    if (isStreaming) return 4000;
    const open = (tasks ?? []).some((t) => !isSettled(t.status) || t.subtasks.some((s) => !isSettled(s.status)));
    return open ? 4000 : null;
  }, [isStreaming]);
  const { resource: taskResource, reload: reloadTasks } = useAsyncResource(loadTasks, revalidate);
  const tasks = lastValue(taskResource);

  const { view: changelog, resource: changelogResource, reload: reloadChangelog } = useChangelog(rpc, onChangelogSeen);

  const openTasks = (tasks ?? []).filter((task) => !isClosedTree(task));
  const closedTasks = (tasks ?? []).filter(isClosedTree);
  const runningJobs = backgroundJobs.filter((job) => job.status === "running");
  const settledJobs = backgroundJobs.filter((job) => job.status !== "running");

  const journal = useMemo(
    () => buildJournal(settledJobs, closedTasks, changelog?.entries ?? []),
    [settledJobs, closedTasks, changelog],
  );
  const visible = journal.filter((row) => filter === "all" || row.filter === filter);

  const nothingAtAll = pendingActions.length === 0 && openTasks.length === 0
    && runningJobs.length === 0 && journal.length === 0
    && tasks !== null && changelog !== null;

  if (nothingAtAll) {
    return (
      <EmptyState icon={<PulseIcon size={28} />} title="Nothing has happened yet"
        hint="The plan the agent writes for itself, the work it detaches, and the changes it makes to itself all land here — with anything waiting on you at the top." />
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {pendingActions.length > 0 && (
        <Section id="work-needs-you" title="Needs you"
          icon={<WarningCircleIcon size={14} className="p-accent" />}
          badge={<Badge variant="secondary">{pendingActions.length}</Badge>}>
          <div className="space-y-1.5">
            {pendingActions.map((action) => (
              <PendingRow key={action.id} action={action} onOpenSurface={onOpenSurface} />
            ))}
          </div>
        </Section>
      )}

      <Section id="work-now" title="Now" icon={<PulseIcon size={14} className="p-text-2" />}>
        {taskResource.status === "error" && tasks === null ? (
          <LoadFailure what="the plan" message={taskResource.message} onRetry={reloadTasks} />
        ) : tasks === null ? (
          <div className="flex justify-center py-4"><Loader size="sm" /></div>
        ) : (
          <div className="space-y-3">
            {tasks.length > 0 && <PlanProgress tasks={tasks} />}
            {openTasks.length > 0 && (
              <div className="space-y-2">
                {openTasks.map((task) => <TaskTree key={task.id} task={task} />)}
              </div>
            )}
            {runningJobs.length > 0 && (
              <div className="space-y-2">
                {runningJobs.map((job) => (
                  <JobCard key={job.id} job={job} onRefresh={onRefreshJobs} rpc={rpc} />
                ))}
              </div>
            )}
            {openTasks.length === 0 && runningJobs.length === 0 && (
              <p className="text-xs p-text-3">
                Nothing in flight. When the agent takes on work with more than a step or two it writes
                the steps down here, and a tool call over 30s detaches as a job beside them.
              </p>
            )}
          </div>
        )}
      </Section>

      <Section id="work-journal" title="Journal"
        icon={<ClockIcon size={14} className="p-text-2" />}
        badge={journal.length > 0 ? <Badge variant="secondary">{journal.length}</Badge> : undefined}>
        <div className="space-y-3">
          <div className="flex items-center gap-1 flex-wrap">
            {FILTERS.map((chip) => (
              <button key={chip.id} type="button" onClick={() => setFilter(chip.id)}
                aria-pressed={filter === chip.id}
                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${filter === chip.id ? "p-fill p-text font-medium" : "p-text-3 hover:p-text-2"}`}>
                {chip.label}
              </button>
            ))}
          </div>

          {changelog === null && changelogResource.status === "error" && (
            <ChangelogFailure resource={changelogResource} reload={reloadChangelog} />
          )}

          {visible.length === 0 ? (
            <p className="text-xs p-text-3">
              {journal.length === 0
                ? "Nothing has settled yet — finished jobs, closed plan items and the agent's own changes land here."
                : "Nothing under this filter."}
            </p>
          ) : (
            <div className="space-y-2">
              {visible.map((row) => (
                <div key={row.key}>
                  {row.kind === "job" && <JobCard job={row.job} onRefresh={onRefreshJobs} rpc={rpc} />}
                  {row.kind === "task" && <TaskTree task={row.task} />}
                  {row.kind === "self" && (
                    <ChangelogEntryCard entry={row.entry} seenAt={changelog?.seenAt ?? 0}
                      rpc={rpc} onReverted={reloadChangelog} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

/* ── the needs-you queue ───────────────────────────────────────── */

function PendingRow(
  { action, onOpenSurface }: { action: PendingAction; onOpenSurface: (surface: SurfaceKind) => void },
) {
  const home = PENDING_HOME[action.kind];
  const Icon = PENDING_ICON[action.kind];
  const body = (
    <>
      <Icon size={14} className="p-accent shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs p-text leading-relaxed">{action.title}</div>
        {action.detail && (
          <div className="text-[10px] p-text-3 mt-0.5 line-clamp-2 break-words">{action.detail}</div>
        )}
        <div className="text-[10px] p-text-3 mt-0.5">{timeAgo(action.at)} · decide in {home.where}</div>
      </div>
    </>
  );
  if (home.surface === null) {
    return <div className="p-card rounded-lg px-3 py-2 flex items-start gap-2">{body}</div>;
  }
  return (
    <button type="button" onClick={() => onOpenSurface(home.surface!)}
      className="w-full p-card rounded-lg px-3 py-2 flex items-start gap-2 text-left hover:p-elevated transition-colors">
      {body}
      <CaretRightIcon size={12} className="p-text-3 shrink-0 mt-1" />
    </button>
  );
}

/* ── the journal ───────────────────────────────────────────────── */

type JournalRow =
  | { key: string; at: number; filter: "jobs"; kind: "job"; job: BackgroundJob }
  | { key: string; at: number; filter: "plan"; kind: "task"; task: AgentTaskTree }
  | { key: string; at: number; filter: "self"; kind: "self"; entry: ChangelogEntry };

/**
 * One reverse-chronological feed out of three ledgers.
 *
 * Exported for its test: the ordering IS the feature — three sources that each
 * used to be its own tab have to read as one stream, or the merge has bought
 * nothing but a longer page.
 */
export function buildJournal(
  jobs: readonly BackgroundJob[],
  tasks: readonly AgentTaskTree[],
  entries: readonly ChangelogEntry[],
): JournalRow[] {
  const rows: JournalRow[] = [
    ...jobs.map((job): JournalRow => ({
      key: `job:${job.id}`, at: job.settledAt ?? job.createdAt, filter: "jobs", kind: "job", job,
    })),
    ...tasks.map((task): JournalRow => ({
      key: `task:${task.id}`, at: task.updatedAt, filter: "plan", kind: "task", task,
    })),
    ...entries.map((entry): JournalRow => ({
      key: `self:${entry.id}`, at: entry.at, filter: "self", kind: "self", entry,
    })),
  ];
  return rows.sort((a, b) => b.at - a.at);
}
