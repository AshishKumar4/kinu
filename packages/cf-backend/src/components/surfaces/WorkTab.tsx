/**
 * Needs you, Now, Journal. Queue rows deep-link to where each decision is made, so nothing is
 * decided twice: a parked command or a proposal in the chat's attention stack, a plan on its own page.
 * `listPendingActions` is host-owned and never a slate data source.
 */
import { useCallback, useMemo } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  ClockIcon, PulseIcon, WarningCircleIcon, GitBranchIcon,
  PackageIcon, SparkleIcon, CaretRightIcon, ShieldWarningIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { hasWorkspaceWork, jobPhase, taskTreePhase, timeAgo, type InspectedWork } from "@kinu.run/core";
import type { AgentTaskTree, OwnedPlan, PanelAgent, PendingAction, PendingActionKind, PlanPageRef, WorkspaceWork, WorkspaceWorkOwner } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import type { AsyncResource } from "@/hooks/use-async-resource";
import { Section } from "./shared";
import { HelperRow, PlanProgress, TaskTree } from "./work-tasks";
import { InspectedRow, JobCard } from "./work-jobs";
import type { SurfaceKind } from "@kinu.run/core";
import { WorkPlans } from "./WorkPlans";
import type { WorkspaceWorkRead } from "./use-workspace-work";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

/** Kinds the attention stack decides: their rows open its card. */
const STACKED: ReadonlySet<PendingActionKind> = new Set(["deferred_action", "workspace_proposal"]);

/** Where each pending kind is decided; tab names stay out of core. */
const PENDING_HOME = {
  deferred_action: { surface: null, cta: "answer it in the chat" },
  workspace_proposal: { surface: null, cta: "answer it in the chat" },
  scaffold_version: { surface: "Agent", cta: "decide in Agent" },
  // The agent's own changes are the Agent tab's: how it is changing.
  unseen_changes: { surface: "Agent", cta: "see them in Agent" },
  curriculum_task: { surface: null, cta: null },
  // The row is the deep link: it opens the plan's own page.
  plan_review: { surface: null, cta: "open the review" },
} satisfies Record<PendingActionKind, { surface: SurfaceKind | null; cta: string | null }>;

const PENDING_ICON = {
  deferred_action: ShieldWarningIcon,
  workspace_proposal: SparkleIcon,
  scaffold_version: GitBranchIcon,
  unseen_changes: SparkleIcon,
  curriculum_task: PackageIcon,
  plan_review: NotePencilIcon,
} satisfies Record<PendingActionKind, typeof ClockIcon>;

interface WorkTabProps {
  onReviewActor?: (name: string, actorId?: string) => void | Promise<void>;
  /** The column's one read of plans and tasks. */
  work: WorkspaceWorkRead;
  /** Shows a plan's own page. */
  onOpenPlan: (plan: PlanPageRef) => void;
  /** Polled by the hook so the tab badge and this queue are one read. */
  pendingActions: PendingAction[];
  backgroundJobs: BackgroundJob[];
  inspectedWork: readonly InspectedWork[];
  onRefreshJobs: () => void;
  onOpenSurface: (surface: SurfaceKind) => void;
  /** Opens an ask's card in the chat's attention stack: where a parked command or a proposal is decided. */
  onOpenAsk?: (key: string) => void | Promise<void>;
  rpc: WorkspaceRpc;
  agents?: { readonly list: readonly PanelAgent[]; readonly open: (agent: PanelAgent) => void };
}

export function WorkTab({
  onReviewActor, work: read, onOpenPlan, pendingActions, backgroundJobs, inspectedWork, onRefreshJobs, onOpenSurface, onOpenAsk, rpc, agents,
}: WorkTabProps) {
  const openPlan = useCallback((item: OwnedPlan) => onOpenPlan({ owner: item.owner.name, id: item.plan.id, revision: item.plan.revision }), [onOpenPlan]);
  const { work, resource: taskResource, reload: reloadTasks } = read;

  const taskRows = useMemo(() => {
    const rows = (groups: readonly { owner: WorkspaceWorkOwner; tasks: AgentTaskTree[] }[]) =>
      groups.flatMap((owned) => owned.tasks.map((task) => ({ task, owner: owned.owner })));

    return [...rows(work?.tasks ?? []), ...rows(work?.plans ?? [])];
  }, [work]);

  const openTasks = taskRows.filter(({ task }) => taskTreePhase(task) !== "settled");
  const closedTasks = taskRows.filter(({ task }) => taskTreePhase(task) === "settled");
  const helpers = useMemo(() => (agents?.list ?? []).filter((agent) => agent.category === "background"), [agents]);
  const runningJobs = backgroundJobs.filter((job) => jobPhase(job, Date.now()) !== "settled");
  const settledJobs = backgroundJobs.filter((job) => jobPhase(job, Date.now()) === "settled");

  const journal = useMemo(() => buildJournal(settledJobs, closedTasks), [settledJobs, closedTasks]);

  const nothingAtAll = work !== null && !hasWorkspaceWork({
    work, pending: pendingActions, jobs: backgroundJobs, changes: [], notes: [], owed: inspectedWork,
  });

  if (nothingAtAll) {
    return (
      <p className="py-1">
        <span className="block p-row-text p-text-2">No work yet</span>
        <span className="mt-1 block p-meta p-text-3">Plans, tasks and jobs show here while they run, and stay in the Journal once they finish.</span>
      </p>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <WorkPlans work={work} onOpen={openPlan} />
      <NeedsYou pendingActions={pendingActions} onOpenAsk={onOpenAsk} onOpenSurface={onOpenSurface} onOpenPlan={onOpenPlan} />
      <WorkNow work={work} taskRows={taskRows} openTasks={openTasks} inspected={inspectedWork} runningJobs={runningJobs} helpers={helpers} onOpenHelper={agents?.open} resource={taskResource} onRetry={reloadTasks} onRefreshJobs={onRefreshJobs} onOpenOwner={onReviewActor} rpc={rpc} />
      <WorkJournal journal={journal} rpc={rpc} onRefreshJobs={onRefreshJobs} onOpenOwner={onReviewActor} />
    </div>
  );
}

function NeedsYou({ pendingActions, onOpenAsk, onOpenSurface, onOpenPlan }: {
  pendingActions: PendingAction[];
  onOpenAsk?: (key: string) => void | Promise<void>;
  onOpenSurface: (surface: SurfaceKind) => void;
  onOpenPlan: (plan: PlanPageRef) => void;
}) {
  if (pendingActions.length === 0) return null;

  // A plan opens its page; a parked command or a proposal opens its card in the stack (`ownerAsks` keys it so).
  const opener = (action: PendingAction): (() => void) | undefined => {
    const { planRef } = action;

    if (action.kind === "plan_review") return planRef === undefined ? undefined : () => onOpenPlan(planRef);

    return STACKED.has(action.kind) && onOpenAsk !== undefined ? () => void onOpenAsk(`action:${action.id}`) : undefined;
  };

  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--c-accent)_32%,transparent)] bg-[var(--c-accent-subtle)] px-[18px] pt-2.5 pb-3.5 [&_.p-label]:!text-[var(--c-accent-fg)]">
      <Section id="work-needs-you" title="Needs you"
        icon={<WarningCircleIcon size={14} className="p-warning" />}
        badge={<Badge variant="secondary">{pendingActions.length}</Badge>}>
        <div className="divide-y divide-dashed divide-[var(--c-dash)]">
          {pendingActions.map((action) => (
            <PendingRow key={action.id} action={action} onOpenSurface={onOpenSurface} onOpen={opener(action)} />
          ))}
        </div>
      </Section>
    </div>
  );
}

interface WorkTaskRow {
  task: AgentTaskTree;
  owner: WorkspaceWorkOwner;
}

/** The read's tri-state gates only the work half, so a running job never waits behind the plan's spinner. */
function WorkNow({ work, taskRows, openTasks, inspected, runningJobs, helpers, onOpenHelper, resource, onRetry, onRefreshJobs, onOpenOwner, rpc }: {
  work: WorkspaceWork | null;
  taskRows: WorkTaskRow[];
  openTasks: WorkTaskRow[];
  /** Turns and effects still owed, by their recorded phase. */
  inspected: readonly InspectedWork[];
  runningJobs: BackgroundJob[];
  helpers: readonly PanelAgent[];
  onOpenHelper?: (agent: PanelAgent) => void;
  resource: AsyncResource<WorkspaceWork>;
  onRetry: () => void;
  onRefreshJobs: () => void;
  onOpenOwner?: (name: string, actorId: string) => void | Promise<void>;
  rpc: WorkspaceRpc;
}) {
  const nowEmpty = work !== null && openTasks.length === 0 && inspected.length === 0 && runningJobs.length === 0 && helpers.length === 0;
  const now = Date.now();

  if (nowEmpty && resource.status !== "error") return null;

  return (
    <Section id="work-now" title="Now" icon={<PulseIcon size={14} className="p-text-2" />}>
      <div className="space-y-3">
        {resource.status === "error" && (
          <LoadFailure what="the workspace's work" message={resource.message} onRetry={onRetry} />
        )}
        {work === null ? (
          resource.status !== "error" && <div className="flex justify-center py-4"><Loader size="sm" /></div>
        ) : (
          <>
            {taskRows.length > 0 && <PlanProgress tasks={taskRows.map(({ task }) => task)} />}
            {openTasks.length > 0 && (
              <div className="space-y-2">
                {openTasks.map(({ task, owner }) => <TaskTree key={`${owner.actorId}:${task.id}`} task={task} owner={owner} onOpenOwner={onOpenOwner} />)}
              </div>
            )}
          </>
        )}
        {inspected.length > 0 && (
          <div className="space-y-1">
            {inspected.map((owed) => <InspectedRow key={`${owed.actor ?? ""}:${owed.kind}:${owed.id}`} work={owed} now={now} />)}
          </div>
        )}
        {runningJobs.length > 0 && (
          <div className="space-y-2">
            {runningJobs.map((job) => (
              <JobCard key={job.id} job={job} onRefresh={onRefreshJobs} rpc={rpc} />
            ))}
          </div>
        )}
        {helpers.length > 0 && (
          <div className="space-y-1">
            {helpers.map((agent) => <HelperRow key={agent.key} agent={agent} onOpen={onOpenHelper} />)}
          </div>
        )}
      </div>
    </Section>
  );
}

/** What finished: jobs and tasks, newest first under the day they ended. A row opens what it was. */
function WorkJournal({ journal, rpc, onRefreshJobs, onOpenOwner }: {
  journal: JournalRow[];
  rpc: WorkspaceRpc;
  onRefreshJobs: () => void;
  onOpenOwner?: (name: string, actorId: string) => void | Promise<void>;
}) {
  if (journal.length === 0) return null;
  const days = journalDays(journal, Date.now());

  return (
    <Section id="work-journal" title="Journal"
      icon={<ClockIcon size={14} className="p-text-2" />}
      badge={<Badge variant="secondary">{journal.length}</Badge>}>
      <div className="space-y-3.5">
        {days.map(({ label, rows }) => (
          <div key={label} className="space-y-1.5">
            <p className="p-eyebrow">{label}</p>
            <div className="p-group">
              {rows.map((row) => (
                <div key={row.key} data-journal-row={row.kind}>
                  {row.kind === "job" && <JobCard grouped job={row.job} onRefresh={onRefreshJobs} rpc={rpc} />}
                  {row.kind === "task" && <TaskTree grouped task={row.task} owner={row.owner} onOpenOwner={onOpenOwner} />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** The journal by the local day each row ended: Today, Yesterday, then the date. */
function journalDays(journal: readonly JournalRow[], now: number): { label: string; rows: JournalRow[] }[] {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const days = new Map<string, JournalRow[]>();

  for (const row of journal) {
    const ago = Math.floor((midnight - new Date(row.at).setHours(0, 0, 0, 0)) / 86_400_000);
    let label = new Date(row.at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

    if (ago <= 0) label = "Today";
    else if (ago === 1) label = "Yesterday";
    days.set(label, [...days.get(label) ?? [], row]);
  }

  return [...days].map(([label, rows]) => ({ label, rows }));
}

function PendingRow(
  { action, onOpenSurface, onOpen }: {
    action: PendingAction;
    onOpenSurface: (surface: SurfaceKind) => void;
    onOpen?: () => void;
  },
) {
  const home = PENDING_HOME[action.kind];
  const Icon = PENDING_ICON[action.kind];

  const content = (
    <div className="min-w-0">
      <div className="p-row-text p-text">{action.title}</div>
      {action.detail && (
        <div className="mt-0.5 line-clamp-2 break-words p-meta p-text-3">{action.detail}</div>
      )}
      <div className="mt-0.5 p-meta p-text-3">
        {timeAgo(action.at)}{home.cta === null ? "" : ` · ${home.cta}`}
      </div>
    </div>
  );

  const icon = <Icon size={14} className="mt-0.5 shrink-0 p-warning" />;
  const surface = home.surface;
  const open = onOpen ?? (surface === null ? null : () => onOpenSurface(surface));

  if (open === null) {
    return <div className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2 py-2" data-pending-action={action.id}>{icon}{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={open}
      data-pending-action={action.id}
      className="grid w-full grid-cols-[14px_minmax(0,1fr)_16px] items-start gap-2 rounded-md py-2 text-left transition-colors hover:p-elevated"
    >
      {icon}
      {content}
      <CaretRightIcon size={12} className="mt-1 shrink-0 justify-self-end p-text-3" />
    </button>
  );
}

type JournalRow =
  | { key: string; at: number; kind: "job"; job: BackgroundJob }
  | { key: string; at: number; kind: "task"; task: AgentTaskTree; owner: WorkspaceWorkOwner };

/** Newest first: the ordering is the feature. */
function buildJournal(jobs: readonly BackgroundJob[], tasks: readonly WorkTaskRow[]): JournalRow[] {
  const rows: JournalRow[] = [
    ...jobs.map((job): JournalRow => ({ key: `job:${job.id}`, at: job.settledAt ?? job.createdAt, kind: "job", job })),
    ...tasks.map(({ task, owner }): JournalRow => ({ key: `task:${owner.actorId}:${task.id}`, at: task.updatedAt, kind: "task", task, owner })),
  ];

  return rows.sort((a, b) => b.at - a.at);
}
