/**
 * Needs you, Now, Journal. Queue rows deep-link to where each decision is made, so nothing is
 * decided twice; `listPendingActions` is host-owned and never a slate data source.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ClockIcon, PulseIcon, WarningCircleIcon, GitBranchIcon,
  RocketLaunchIcon, PackageIcon, SparkleIcon, CaretRightIcon, ShieldWarningIcon,
  NotePencilIcon, ArrowLeftIcon, DatabaseIcon,
} from "@phosphor-icons/react";
import { hasWorkspaceWork, timeAgo } from "@kinu.run/core";
import type { AgentTaskTree, ChangelogEntry, MemoryEntry, OwnedPlan, PendingAction, PendingActionKind, PlanReview, WorkspaceWork } from "@kinu.run/core";
import type { WorkspacePlanArrival } from "@/hooks/use-kinu";
import type { Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { FilledButton } from "@/components/ui/FilledButton";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import { Section } from "./shared";
import { isClosedTree, PlanProgress, TaskTree } from "./work-tasks";
import { JobCard } from "./work-jobs";
import { ChangelogEntryCard, ChangelogFailure, useChangelog, type ChangelogView } from "./changelog-entries";
import type { SurfaceKind } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { WorkPlans } from "./WorkPlans";

const PlanReviewView = lazy(() => import("./PlanReviewView"));

/** `All` holds every row the feed has: the queue counts unseen entries from the same unfiltered read and points here. Curation belongs to `buildChangelog`'s `changesOnly`. */
type JournalFilter = "all" | "jobs" | "self";

const FILTERS: Array<{ id: JournalFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "jobs", label: "Jobs" },
  { id: "self", label: "Self-changes" },
];

/** Where each pending kind is decided; tab names stay out of core. `deferred_action` is absent: the queue is its home. */
const PENDING_HOME = {
  release_approval: { surface: "Releases", cta: "decide in Releases" },
  scaffold_version: { surface: "Agent", cta: "decide in Agent → Evolution" },
  unseen_changes: { surface: null, cta: null },
  curriculum_task: { surface: null, cta: "decide in Supervise" },
  // The row is the deep link: it opens the review over the whole tab.
  plan_review: { surface: null, cta: "open the review" },
} satisfies Record<Exclude<PendingActionKind, "deferred_action">, { surface: SurfaceKind | null; cta: string | null }>;

const PENDING_ICON = {
  release_approval: RocketLaunchIcon,
  scaffold_version: GitBranchIcon,
  unseen_changes: SparkleIcon,
  curriculum_task: PackageIcon,
  plan_review: NotePencilIcon,
} satisfies Record<Exclude<PendingActionKind, "deferred_action">, typeof ClockIcon>;

export interface WorkTabProps {
  plan: PlanReview | null;
  planRpc: Rpc;
  planOwner?: string;
  workspacePlanArrival?: WorkspacePlanArrival | null;
  onReviewActor?: (name: string) => void | Promise<void>;
  /** Polled by the hook so the tab badge and this queue are one read. */
  pendingActions: PendingAction[];
  backgroundJobs: BackgroundJob[];
  onRefreshJobs: () => void;
  onOpenSurface: (surface: SurfaceKind) => void;
  onChangelogSeen?: () => void;
  /** Re-read after a decision so decided rows leave on the click, not the next poll. */
  onRefreshQueue?: () => void;
  isStreaming: boolean;
  rpc: Rpc;
  memory?: MemoryEntry[];
}

export function WorkTab({
  plan, planRpc, planOwner, workspacePlanArrival, onReviewActor, pendingActions, backgroundJobs, onRefreshJobs, onOpenSurface, onChangelogSeen, onRefreshQueue, isStreaming, rpc, memory = [],
}: WorkTabProps) {
  const [filter, setFilter] = useState<JournalFilter>("all");
  const [hasPlans, setHasPlans] = useState(plan !== null);
  /** A reference into the shared read, resolved live each render, so a decision repaints the header instead of a stale snapshot. */
  const [review, setReview] = useState<{ owner: string; id: string; revision: number } | null>(null);
  const openReview = useCallback((item: OwnedPlan) => setReview({ owner: item.owner.name, id: item.plan.id, revision: item.plan.revision }), []);
  const onNewPlan = useCallback(() => onOpenSurface("Work"), [onOpenSurface]);

  // Plans and tasks share one read, so the two halves never disagree about which row belongs where.
  const loadWork = useCallback(
    () => rpc<WorkspaceWork>("listWorkspaceWork", []),
    [rpc],
  );

  // The server never pushes the plan, so the tab revalidates until everything has settled.
  const revalidate = useCallback((work: WorkspaceWork | null) => {
    if (isStreaming) return 4000;

    const stillOpen = (owned: { tasks: AgentTaskTree[] }) => owned.tasks.some((task) => !isClosedTree(task));
    const open = (work?.plans ?? []).some(stillOpen) || (work?.tasks ?? []).some(stillOpen);

    return open ? 4000 : null;
  }, [isStreaming]);

  const { resource: taskResource, reload: reloadTasks } = useAsyncResource(loadWork, revalidate);
  const work = lastValue(taskResource);

  const {
    view: changelog, seenAt: changelogSeenAt, seenError: changelogSeenError,
    resource: changelogResource, reload: reloadChangelog,
  } = useChangelog(rpc, onChangelogSeen);

  const taskRows = useMemo(() => {
    const rows = (groups: readonly { owner: { name: string }; tasks: AgentTaskTree[] }[]) =>
      groups.flatMap((owned) => owned.tasks.map((task) => ({ task, owner: owned.owner.name })));

    return [...rows(work?.tasks ?? []), ...rows(work?.plans ?? [])];
  }, [work]);

  const openTasks = taskRows.filter(({ task }) => !isClosedTree(task));
  const closedTasks = taskRows.filter(({ task }) => isClosedTree(task)).map(({ task }) => task);
  const runningJobs = backgroundJobs.filter((job) => job.status === "running");
  const settledJobs = backgroundJobs.filter((job) => job.status !== "running");

  const journal = useMemo(
    () => buildJournal(settledJobs, closedTasks, changelog?.entries ?? []),
    [settledJobs, closedTasks, changelog],
  );

  /** A revision gone from the read closes the view rather than deciding against a plan the workspace no longer holds. */
  const reviewed = review === null ? undefined
    : (work?.plans ?? []).find((owned) =>
        owned.owner.name === review.owner && owned.plan.id === review.id && owned.plan.revision === review.revision);

  useEffect(() => {
    if (review !== null && work !== null && reviewed === undefined) setReview(null);
  }, [review, reviewed, work]);

  const activeKey = plan === null ? null : `${plan.id}:${plan.revision}`;

  /** Lives here, not in the list: the list unmounts while a review is open, and a latch there would reopen the review on Back. */
  const openedActive = useRef<string | null>(null);

  // Open the reported plan's review once per revision, after the shared read confirms the row; take no surface, unlike `onNewPlan`.
  useEffect(() => {
    if (plan === null || activeKey === null) {
      openedActive.current = null;

      return;
    }

    if (openedActive.current === activeKey || work === null) return;

    const own = work.plans.find((owned) => owned.owner.name === (planOwner ?? "main")
      && owned.plan.id === plan.id && owned.plan.revision === plan.revision);

    if (own === undefined) return;
    openedActive.current = activeKey;
    setReview({ owner: own.owner.name, id: own.plan.id, revision: own.plan.revision });
  }, [activeKey, plan, planOwner, work]);

  // The shared read has no push: re-read on each `plan_updated` frame. `plan` is a fresh object per push; a decision reuses the revision, so a key would miss it.
  useEffect(() => {
    if (plan !== null || workspacePlanArrival) reloadTasks();
  }, [plan, workspacePlanArrival, reloadTasks]);

  // Checked before the empty tab so an arrival does not flash "Nothing yet" for a frame.
  if (review !== null && reviewed !== undefined) {
    return <WorkReview item={reviewed} owner={planOwner ?? "main"} rpc={rpc} planRpc={planRpc}
      onReviewActor={onReviewActor} resource={taskResource} onRetry={reloadTasks}
      onBack={() => setReview(null)} />;
  }

  const nothingAtAll = work !== null && changelog !== null && !hasWorkspaceWork({
    work, pending: pendingActions, jobs: backgroundJobs,
    changes: changelog.entries, notes: memory,
  });

  if (nothingAtAll && !hasPlans && !plan) {
    return (
      <div className="space-y-6"><WorkPlans work={work} owner={planOwner ?? "main"} arrival={workspacePlanArrival} onPresence={setHasPlans} onNewPlan={onNewPlan} onOpenReview={openReview} /><p className="p-row-text p-text-3">Nothing yet</p></div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <WorkPlans work={work} owner={planOwner ?? "main"} arrival={workspacePlanArrival} onPresence={setHasPlans} onNewPlan={onNewPlan} onOpenReview={openReview} />
      <NeedsYou pendingActions={pendingActions} rpc={rpc} onDecided={onRefreshQueue} onOpenSurface={onOpenSurface} onOpenReview={setReview} />
      <WorkNow work={work} taskRows={taskRows} openTasks={openTasks} runningJobs={runningJobs} resource={taskResource} onRetry={reloadTasks} onRefreshJobs={onRefreshJobs} rpc={rpc} />
      <WorkJournal journal={journal} filter={filter} onFilter={setFilter} view={changelog} seenAt={changelogSeenAt} seenError={changelogSeenError} resource={changelogResource} onReload={reloadChangelog} rpc={rpc} onRefreshJobs={onRefreshJobs} />
      <Learnings memory={memory} onOpenSurface={onOpenSurface} />
    </div>
  );
}

/** Behind a review, Now's retry line is unmounted, so the shared read's retry is owed here. */
function WorkReview({ item, owner, rpc, planRpc, onReviewActor, resource, onRetry, onBack }: {
  item: OwnedPlan;
  owner: string;
  rpc: Rpc;
  planRpc: Rpc;
  onReviewActor?: (name: string) => void | Promise<void>;
  resource: AsyncResource<WorkspaceWork>;
  onRetry: () => void;
  onBack: () => void;
}) {
  const mine = item.owner.name === owner;

  return (
    <div className="flex h-full min-h-0 flex-col space-y-3 animate-fade-in">
      <div className="flex shrink-0 items-center gap-3">
        <button type="button" data-back-to-work onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs p-accent transition-colors hover:p-elevated">
          <ArrowLeftIcon size={12} /> Back to Work
        </button>
        {!mine && <span className="p-meta p-text-3">Read-only: {item.owner.name}'s plan
          {onReviewActor && <button type="button" className="ml-2 p-accent" onClick={() => void onReviewActor(item.owner.name)}>Review in {item.owner.name}'s conversation</button>}
        </span>}
      </div>
      {resource.status === "error" && (
        <LoadFailure what="the workspace's work" message={resource.message} onRetry={onRetry} />
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="flex justify-center py-8"><Loader size="sm" /></div>}>
          <PlanReviewView plan={item.plan} rpc={item.owner.name === "main" ? rpc : planRpc} readOnly={!mine || item.plan.status !== "pending"} />
        </Suspense>
      </div>
    </div>
  );
}

function NeedsYou({ pendingActions, rpc, onDecided, onOpenSurface, onOpenReview }: {
  pendingActions: PendingAction[];
  rpc: Rpc;
  /** Re-read after a decision so decided rows leave on the click, not the next poll. */
  onDecided?: () => void;
  onOpenSurface: (surface: SurfaceKind) => void;
  onOpenReview: (ref: { owner: string; id: string; revision: number }) => void;
}) {
  const parkedCommands = pendingActions.filter((a) => a.kind === "deferred_action");

  const elsewhere = pendingActions.filter(
    (a): a is DecidedElsewhere => a.kind !== "deferred_action");

  const openQueuedReview = useCallback((action: DecidedElsewhere) => {
    if (action.planRef !== undefined) onOpenReview(action.planRef);
  }, [onOpenReview]);

  if (pendingActions.length === 0) return null;

  return (
    <div className="rounded-lg border border-[rgba(224,164,88,.32)] bg-[rgba(224,164,88,.06)] px-[18px] pt-2.5 pb-3.5 [&_.p-label]:!text-[var(--c-accent-fg)]">
      <Section id="work-needs-you" title="Needs you"
        icon={<WarningCircleIcon size={14} className="p-warning" />}
        badge={<Badge variant="secondary">{pendingActions.length}</Badge>}>
        <div className="divide-y divide-dashed divide-[var(--c-dash)]">
          {parkedCommands.length > 0 && (
            <ParkedCommands actions={parkedCommands} rpc={rpc} onDecided={onDecided} />
          )}
          {elsewhere.map((action) => (
            <PendingRow key={action.id} action={action} onOpenSurface={onOpenSurface}
              onOpen={action.kind === "plan_review" ? () => openQueuedReview(action) : undefined} />
          ))}
        </div>
      </Section>
    </div>
  );
}

interface WorkTaskRow {
  task: AgentTaskTree;
  owner: string;
}

/** The read's tri-state gates only the work half, so a running job never waits behind the plan's spinner. */
function WorkNow({ work, taskRows, openTasks, runningJobs, resource, onRetry, onRefreshJobs, rpc }: {
  work: WorkspaceWork | null;
  taskRows: WorkTaskRow[];
  openTasks: WorkTaskRow[];
  runningJobs: BackgroundJob[];
  resource: AsyncResource<WorkspaceWork>;
  onRetry: () => void;
  onRefreshJobs: () => void;
  rpc: Rpc;
}) {
  const nowEmpty = work !== null && openTasks.length === 0 && runningJobs.length === 0;

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
                {openTasks.map(({ task, owner }) => <TaskTree key={`${owner}:${task.id}`} task={task} owner={owner} />)}
              </div>
            )}
          </>
        )}
        {runningJobs.length > 0 && (
          <div className="space-y-2">
            {runningJobs.map((job) => (
              <JobCard key={job.id} job={job} onRefresh={onRefreshJobs} rpc={rpc} />
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

/** Drawn while the digest read owes a retry too, so a broken read never blanks the tab; revalidation failures also show. */
function WorkJournal({ journal, filter, onFilter, view, seenAt, seenError, resource, onReload, rpc, onRefreshJobs }: {
  journal: JournalRow[];
  filter: JournalFilter;
  onFilter: (filter: JournalFilter) => void;
  view: ChangelogView | null;
  seenAt: number;
  seenError: string | null;
  resource: AsyncResource<ChangelogView>;
  onReload: () => void;
  rpc: Rpc;
  onRefreshJobs: () => void;
}) {
  const visible = journal.filter((row) => row.chips.includes(filter));

  if (journal.length === 0 && resource.status !== "error") return null;

  return (
    <Section id="work-journal" title="Journal"
      icon={<ClockIcon size={14} className="p-text-2" />}
      badge={journal.length > 0 ? <Badge variant="secondary">{journal.length}</Badge> : undefined}>
      <div className="space-y-3">
        {journal.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {FILTERS.map((chip) => (
              <button key={chip.id} type="button" onClick={() => onFilter(chip.id)}
                aria-pressed={filter === chip.id}
                className={`px-2.5 py-0.5 p-t-control rounded-full transition-colors ${filter === chip.id ? "bg-[rgba(224,164,88,.1)] p-accent" : "p-text-3 hover:p-accent"}`}>
                {chip.label}
              </button>
            ))}
          </div>
        )}

        {(view === null || resource.status === "error") && (
          <ChangelogFailure resource={resource} reload={onReload} />
        )}
        {seenError && (
          <div className="text-xs p-warning p-card rounded-lg px-3 py-1.5">
            Could not mark the changelog as seen: {seenError}
          </div>
        )}

        {journal.length > 0 && (visible.length > 0 ? (
          <div className="p-group">
            {visible.map((row) => (
              <div key={row.key}>
                {row.kind === "job" && <JobCard grouped job={row.job} onRefresh={onRefreshJobs} rpc={rpc} />}
                {row.kind === "task" && <TaskTree grouped task={row.task} />}
                {row.kind === "self" && (
                  <ChangelogEntryCard grouped entry={row.entry} seenAt={seenAt}
                    rpc={rpc} onReverted={onReload} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="p-row-text p-text-3">Nothing under this chip</p>
        ))}
      </div>
    </Section>
  );
}

function Learnings({ memory, onOpenSurface }: {
  memory: MemoryEntry[];
  onOpenSurface: (surface: SurfaceKind) => void;
}) {
  if (memory.length === 0) return null;

  return (
    <Section id="work-learnings" title="Learnings"
      icon={<DatabaseIcon size={14} className="p-text-2" />}
      badge={<Badge variant="secondary">{memory.length}</Badge>}>
      <div data-learnings className="p-group">
        {[...memory].reverse().map((entry, i) => (
          <button key={i} type="button" data-learning onClick={() => onOpenSurface("Agent")}
            className="w-full rounded-md px-3 py-2 text-left transition-colors hover:p-elevated">
            <span className="p-row-text p-text line-clamp-1">{entry.content.split("\n")[0]}</span>
            <span className="p-meta p-text-3 mt-0.5 block">{entry.updatedAt}{entry.savedBy ? ` · ${entry.savedBy}` : ""}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Nothing here has run, and approving does not run it: the agent is woken and re-issues the command. */
function countLabel(chosen: number, total: number): string {
  if (total === 1) return "";

  return chosen === total ? "all" : String(chosen);
}

/** `always` also records a standing grant per tripped gate-tier rule on that environment; it widens no access, and a refused rule cannot be granted. */
export type ParkedDecision = "approved" | "denied" | "always";

export interface ParkedDecisionDeps {
  decide: (ids: string[], decision: ParkedDecision) => Promise<{ decided: string[] }>;
  /** Re-read the queue so a decided row leaves on this click, not the next poll. */
  onDecided: () => void;
}

export interface ParkedQueueSnapshot {
  /** Null means everything, so an action parked mid-review joins "approve all"; after a decision it is the empty set. */
  readonly selected: ReadonlySet<string> | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly decided: ParkedDecision | null;
}

/** A decision never re-selects what was just decided, and always re-reads the queue. */
export class ParkedDecisionFlow {
  #snapshot: ParkedQueueSnapshot = { selected: null, busy: false, error: null, decided: null };
  readonly #listeners = new Set<() => void>();
  readonly #deps: ParkedDecisionDeps;

  constructor(deps: ParkedDecisionDeps) {
    this.#deps = deps;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => { this.#listeners.delete(listener); };
  };

  readonly snapshot = (): ParkedQueueSnapshot => this.#snapshot;

  chosen(allIds: readonly string[]): ReadonlySet<string> {
    return this.#snapshot.selected ?? new Set(allIds);
  }

  readonly toggle = (id: string, allIds: readonly string[]): void => {
    const chosen = this.chosen(allIds);
    this.#set({
      selected: new Set(
        chosen.has(id) ? [...chosen].filter((x) => x !== id) : [...chosen, id],
      ),
    });
  };

  readonly decide = async (decision: ParkedDecision, ids: readonly string[]): Promise<void> => {
    if (this.#snapshot.busy || ids.length === 0) return;
    this.#set({ busy: true, error: null, decided: null });

    try {
      await this.#deps.decide([...ids], decision);
      // The empty set, never null: null selects everything.
      this.#set({ busy: false, selected: new Set(), error: null, decided: decision });
      this.#deps.onDecided();
    } catch (cause) {
      // The answer never landed, so the selection stands.
      this.#set({ busy: false, error: `Could not record the decision: ${renderThrownChain({ cause })}` });
    }
  };

  #set(partial: Partial<ParkedQueueSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...partial };

    for (const listener of this.#listeners) listener();
  }
}

/** Permission is not an effect: the command still has not run, so never say "done". */
const DECIDED_LINE: Record<ParkedDecision, string> = {
  denied: "Denied. The agent will be told, and nothing runs.",
  always: "Approved. Kinu will stop asking about these checks in this environment.",
  approved: "Approved. It runs when the agent picks the decision up.",
};

export function ParkedCommands({ actions, rpc, onDecided, flow: injected }: { actions: PendingAction[]; rpc: Rpc; onDecided?: () => void; flow?: ParkedDecisionFlow }) {
  const [fresh] = useState(() => new ParkedDecisionFlow({
    decide: (ids, decision) => rpc("decideDeferredApprovals", [ids, decision]),
    onDecided: () => onDecided?.(),
  }));

  const flow = injected ?? fresh;
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  const allIds = actions.map((a) => a.id);
  const chosen = flow.chosen(allIds);

  const decidedLine = state.decided === null ? null : DECIDED_LINE[state.decided];

  return (
    <div className="py-1 space-y-2">
      <div className="flex items-start gap-2">
        <ShieldWarningIcon size={14} className="p-warning shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="p-row-text p-text">
            {actions.length} command{actions.length === 1 ? "" : "s"} waiting on your approval
          </div>
          <div className="p-meta p-text-3 mt-0.5">
            These checks are queued. Approve them so the agent can run them when it resumes.
          </div>
        </div>
      </div>

      <div className="space-y-1">
        {actions.map((action) => (
          <label key={action.id}
            className="flex items-start gap-2 rounded-md px-2 py-1.5 p-elevated cursor-pointer">
            <input type="checkbox" className="mt-0.5 shrink-0" checked={chosen.has(action.id)}
              onChange={() => flow.toggle(action.id, allIds)} disabled={state.busy} />
            <span className="min-w-0 flex-1">
              <code className="block p-t-code p-text break-all whitespace-pre-wrap">{action.detail}</code>
              <span className="block p-meta p-text-3 mt-0.5">{action.title} · queued {timeAgo(action.at)}</span>
            </span>
          </label>
        ))}
      </div>

      {state.error && <div className="p-t-status p-danger">{state.error}</div>}
      {decidedLine && <div className="p-t-status p-text-3">{decidedLine}</div>}

      <div className="flex items-center gap-1.5 flex-wrap">
        <FilledButton disabled={state.busy || chosen.size === 0}
          onClick={() => flow.decide("approved", [...chosen])}>
          Approve {countLabel(chosen.size, actions.length)}
        </FilledButton>
        <Button size="sm" variant="secondary" disabled={state.busy || chosen.size === 0}
          onClick={() => flow.decide("always", [...chosen])}
          title="Approve these checks for this environment. Revoke under Settings → Standing approvals.">
          Always allow {countLabel(chosen.size, actions.length)}
        </Button>
        <Button size="sm" variant="ghost" disabled={state.busy || chosen.size === 0}
          onClick={() => flow.decide("denied", [...chosen])}>
          Deny {countLabel(chosen.size, actions.length)}
        </Button>
      </div>
    </div>
  );
}

type DecidedElsewhere = PendingAction & { kind: Exclude<PendingActionKind, "deferred_action"> };

function PendingRow(
  { action, onOpenSurface, onOpen }: {
    action: DecidedElsewhere;
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
    return <div className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2 py-2">{icon}{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={open}
      className="grid w-full grid-cols-[14px_minmax(0,1fr)_16px] items-start gap-2 rounded-md py-2 text-left transition-colors hover:p-elevated"
    >
      {icon}
      {content}
      <CaretRightIcon size={12} className="mt-1 shrink-0 justify-self-end p-text-3" />
    </button>
  );
}

/** Membership is decided by the builder, never the renderer, so no chip drifts from the feed. */
type JournalRow =
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "job"; job: BackgroundJob }
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "task"; task: AgentTaskTree }
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "self"; entry: ChangelogEntry };

/** Exported for its test: the ordering is the feature. Every row answers to `All`, a no-change self-review included, because the queue counts it as unseen. */
export function buildJournal(
  jobs: readonly BackgroundJob[],
  tasks: readonly AgentTaskTree[],
  entries: readonly ChangelogEntry[],
): JournalRow[] {
  const rows: JournalRow[] = [
    ...jobs.map((job): JournalRow => ({
      key: `job:${job.id}`, at: job.settledAt ?? job.createdAt, chips: ["all", "jobs"], kind: "job", job,
    })),
    ...tasks.map((task): JournalRow => ({
      key: `task:${task.id}`, at: task.updatedAt, chips: ["all", "self"], kind: "task", task,
    })),
    ...entries.map((entry): JournalRow => ({
      key: `self:${entry.id}`, at: entry.at, chips: ["all", "self"], kind: "self", entry,
    })),
  ];

  return rows.sort((a, b) => b.at - a.at);
}

