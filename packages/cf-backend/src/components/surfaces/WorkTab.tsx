/**
 * Needs you, Now, Journal. Queue rows deep-link to where each decision is made, so nothing is
 * decided twice; `listPendingActions` is host-owned and never a slate data source.
 */
import { Cause, Effect } from "effect";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ClockIcon, PulseIcon, WarningCircleIcon, GitBranchIcon,
  PackageIcon, SparkleIcon, CaretRightIcon, ShieldWarningIcon,
  NotePencilIcon, DatabaseIcon,
} from "@phosphor-icons/react";
import { hasWorkspaceWork, jobPhase, revealMisrepresenting, timeAgo, type InspectedWork } from "@kinu.run/core";
import type { AgentTaskTree, ChangelogEntry, MemoryEntry, Omitted, OwnedPlan, PanelAgent, ParkedWriteReview, PendingAction, PendingActionKind, PlanPageRef, WorkspaceWork, WorkspaceWorkOwner } from "@kinu.run/core";
import type { ReadMoves } from "@/hooks/use-kinu";
import type { Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { FilledButton } from "@/components/ui/FilledButton";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import { Section } from "./shared";
import { HelperRow, isClosedTree, PlanProgress, TaskTree } from "./work-tasks";
import { InspectedRow, JobCard } from "./work-jobs";
import { ChangelogEntryCard, ChangelogFailure, useChangelog, type ChangelogView } from "./changelog-entries";
import type { SurfaceKind } from "@kinu.run/core";
import { renderThrownChain, detach, settle } from "@kinu.run/core/obs";
import { WorkPlans } from "./WorkPlans";
import { FileBody } from "./changes/ChangesPanel";
import type { WorkspaceWorkRead } from "./use-workspace-work";

/** `All` holds every row the feed has: the queue counts unseen entries from the same unfiltered read and points here. Curation belongs to `buildChangelog`'s `changesOnly`. */
type JournalFilter = "all" | "jobs" | "self";

const FILTERS: Array<{ id: JournalFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "jobs", label: "Jobs" },
  { id: "self", label: "Self-changes" },
];

/** Kinds decided in this queue, which is their only home. */
type DecidedHere = "deferred_action" | "workspace_proposal";

/** Where each pending kind is decided; tab names stay out of core. The kinds decided here are absent. */
const PENDING_HOME = {
  scaffold_version: { surface: "Agent", cta: "decide in Agent → Evolution" },
  unseen_changes: { surface: null, cta: null },
  curriculum_task: { surface: null, cta: "decide in Supervise" },
  // The row is the deep link: it opens the plan's own page.
  plan_review: { surface: null, cta: "open the review" },
} satisfies Record<Exclude<PendingActionKind, DecidedHere>, { surface: SurfaceKind | null; cta: string | null }>;

const PENDING_ICON = {
  scaffold_version: GitBranchIcon,
  unseen_changes: SparkleIcon,
  curriculum_task: PackageIcon,
  plan_review: NotePencilIcon,
} satisfies Record<Exclude<PendingActionKind, DecidedHere>, typeof ClockIcon>;

export interface WorkTabProps {
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
  onChangelogSeen?: () => void;
  /** Re-read after a decision so decided rows leave on the click, not the next poll. */
  onRefreshQueue?: () => void;
  rpc: Rpc;
  memory?: MemoryEntry[];
  readMoves?: ReadMoves;
  agents?: { readonly list: readonly PanelAgent[]; readonly open: (agent: PanelAgent) => void };
}

export function WorkTab({
  onReviewActor, work: read, onOpenPlan, pendingActions, backgroundJobs, inspectedWork, onRefreshJobs, onOpenSurface, onChangelogSeen, onRefreshQueue, rpc, memory = [], readMoves = {}, agents,
}: WorkTabProps) {
  const [filter, setFilter] = useState<JournalFilter>("all");
  const openPlan = useCallback((item: OwnedPlan) => onOpenPlan({ owner: item.owner.name, id: item.plan.id, revision: item.plan.revision }), [onOpenPlan]);
  const { work, resource: taskResource, reload: reloadTasks } = read;

  const {
    view: changelog, seenAt: changelogSeenAt, seenError: changelogSeenError,
    resource: changelogResource, reload: reloadChangelog,
  } = useChangelog(rpc, onChangelogSeen, readMoves.getEvolutionChangelog ?? 0);

  const taskRows = useMemo(() => {
    const rows = (groups: readonly { owner: WorkspaceWorkOwner; tasks: AgentTaskTree[] }[]) =>
      groups.flatMap((owned) => owned.tasks.map((task) => ({ task, owner: owned.owner })));

    return [...rows(work?.tasks ?? []), ...rows(work?.plans ?? [])];
  }, [work]);

  const openTasks = taskRows.filter(({ task }) => !isClosedTree(task));
  const closedTasks = taskRows.filter(({ task }) => isClosedTree(task));
  const helpers = useMemo(() => (agents?.list ?? []).filter((agent) => agent.category === "background"), [agents]);
  const runningJobs = backgroundJobs.filter((job) => jobPhase(job, Date.now()) !== "settled");
  const settledJobs = backgroundJobs.filter((job) => jobPhase(job, Date.now()) === "settled");

  const journal = useMemo(
    () => buildJournal(settledJobs, closedTasks, changelog?.entries ?? []),
    [settledJobs, closedTasks, changelog],
  );

  const nothingAtAll = work !== null && changelog !== null && !hasWorkspaceWork({
    work, pending: pendingActions, jobs: backgroundJobs,
    changes: changelog.entries, notes: memory, owed: inspectedWork,
  });

  if (nothingAtAll) return <p className="p-row-text p-text-3">Nothing yet</p>;

  return (
    <div className="space-y-6 animate-fade-in">
      <WorkPlans work={work} onOpen={openPlan} />
      <NeedsYou pendingActions={pendingActions} rpc={rpc} onDecided={onRefreshQueue} onOpenSurface={onOpenSurface} onOpenPlan={onOpenPlan} />
      <WorkNow work={work} taskRows={taskRows} openTasks={openTasks} inspected={inspectedWork} runningJobs={runningJobs} helpers={helpers} onOpenHelper={agents?.open} resource={taskResource} onRetry={reloadTasks} onRefreshJobs={onRefreshJobs} onOpenOwner={onReviewActor} rpc={rpc} />
      <WorkJournal journal={journal} filter={filter} onFilter={setFilter} view={changelog} seenAt={changelogSeenAt} seenError={changelogSeenError} resource={changelogResource} onReload={reloadChangelog} rpc={rpc} onRefreshJobs={onRefreshJobs} onOpenOwner={onReviewActor} />
      <Learnings memory={memory} onOpenSurface={onOpenSurface} />
    </div>
  );
}

function NeedsYou({ pendingActions, rpc, onDecided, onOpenSurface, onOpenPlan }: {
  pendingActions: PendingAction[];
  rpc: Rpc;
  /** Re-read after a decision so decided rows leave on the click, not the next poll. */
  onDecided?: () => void;
  onOpenSurface: (surface: SurfaceKind) => void;
  onOpenPlan: (plan: PlanPageRef) => void;
}) {
  const parkedCommands = pendingActions.filter((a) => a.kind === "deferred_action");
  const proposals = pendingActions.filter((a) => a.kind === "workspace_proposal");

  const elsewhere = pendingActions.filter(
    (a): a is DecidedElsewhere => a.kind !== "deferred_action" && a.kind !== "workspace_proposal");

  const openQueuedReview = useCallback((action: DecidedElsewhere) => {
    if (action.planRef !== undefined) onOpenPlan(action.planRef);
  }, [onOpenPlan]);

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
          {proposals.map((action) => (
            <WorkspaceProposalCard key={action.id} action={action} rpc={rpc} onDecided={onDecided} />
          ))}
          {elsewhere.map((action) => (
            <PendingRow key={action.id} action={action} onOpenSurface={onOpenSurface}
              onOpen={action.kind === "plan_review" ? () => openQueuedReview(action) : undefined} />
          ))}
        </div>
      </Section>
    </div>
  );
}

export interface WorkTaskRow {
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
  rpc: Rpc;
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

/** Drawn while the digest read owes a retry too, so a broken read never blanks the tab; revalidation failures also show. */
function WorkJournal({ journal, filter, onFilter, view, seenAt, seenError, resource, onReload, rpc, onRefreshJobs, onOpenOwner }: {
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
  onOpenOwner?: (name: string, actorId: string) => void | Promise<void>;
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
                {row.kind === "task" && <TaskTree grouped task={row.task} owner={row.owner} onOpenOwner={onOpenOwner} />}
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

  decide(decision: ParkedDecision, ids: readonly string[]): Promise<void> {
    if (this.#snapshot.busy || ids.length === 0) return Promise.resolve();
    this.#set({ busy: true, error: null, decided: null });

    return settle(Effect.catchCause(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(() => this.#deps.decide([...ids], decision));
      // The empty set, never null: null selects everything.
      this.#set({ busy: false, selected: new Set(), error: null, decided: decision });
      this.#deps.onDecided();
    }), (failed) => Effect.sync(() => {
      // The answer never landed, so the selection stands.
      this.#set({ busy: false, error: `Could not record the decision: ${renderThrownChain({ cause: Cause.squash(failed) })}` });
    })));
  }

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
            <input type="checkbox" className="mt-0.5 shrink-0 cursor-pointer accent-[var(--c-accent)] hover:brightness-110" checked={chosen.has(action.id)}
              onChange={() => flow.toggle(action.id, allIds)} disabled={state.busy} />
            <span className="min-w-0 flex-1">
              <code className="block p-t-code p-text break-all whitespace-pre-wrap">{revealMisrepresenting(action.detail ?? "")}</code>
              <span className="block p-meta p-text-3 mt-0.5">{action.title} · queued {timeAgo(action.at)}</span>
            </span>
          </label>
        ))}
        {actions.filter((action) => action.write !== undefined).map((action) => (
          <ParkedWriteChange key={`change-${action.id}`} id={action.id} rpc={rpc} />
        ))}
      </div>

      {state.error && <div className="p-t-status p-danger">{state.error}</div>}
      {decidedLine && <div className="p-t-status p-text-3">{decidedLine}</div>}

      <div className="flex items-center gap-1.5 flex-wrap">
        <FilledButton disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("approved", [...chosen])))}>
          Approve {countLabel(chosen.size, actions.length)}
        </FilledButton>
        <Button size="sm" variant="secondary" disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("always", [...chosen])))}
          title="Approve these checks for this environment. Revoke under Settings → Standing approvals.">
          Always allow {countLabel(chosen.size, actions.length)}
        </Button>
        <Button size="sm" variant="ghost" disabled={state.busy || chosen.size === 0}
          onClick={() => detach(Effect.promise(async () => flow.decide("denied", [...chosen])))}>
          Deny {countLabel(chosen.size, actions.length)}
        </Button>
      </div>
    </div>
  );
}

const OMITTED_TEXT: Record<Omitted, string> = { binary: "Binary content", large: "Too large to show line by line" };

function byteCount(bytes: number): string {
  return `${bytes.toLocaleString()} byte${bytes === 1 ? "" : "s"}`;
}

/** The parked bytes against the file as it is now: approving writes exactly these. */
export function ParkedWriteChange({ id, rpc }: { id: string; rpc: Rpc }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md px-2 py-1.5 p-elevated" data-parked-write={id}>
      <button type="button" className="p-meta p-accent-fg hover:underline" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
        {open ? "Hide the change" : "Show the change"}
      </button>
      {open && <ParkedWriteDiff id={id} rpc={rpc} />}
    </div>
  );
}

function ParkedWriteDiff({ id, rpc }: { id: string; rpc: Rpc }) {
  const load = useCallback(() => rpc<ParkedWriteReview>("reviewParkedWrite", [id]), [rpc, id]);
  const { resource, reload } = useAsyncResource(load);
  const review = lastValue(resource);

  if (review === null) {
    return resource.status === "error"
      ? <LoadFailure what="the change" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-2"><Loader size="sm" /></div>;
  }

  const sizes = `${review.currentBytes === null ? "New file" : byteCount(review.currentBytes)} → ${byteCount(review.nextBytes)}`;

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="p-meta p-text-3">{review.path} · {sizes}</div>
      {review.changedSinceAsked && (
        <div className="p-t-status p-warning">The file changed after the agent asked, so approving writes nothing.</div>
      )}
      {review.diff.omitted === undefined
        ? <div className="overflow-hidden rounded-md border p-border"><FileBody file={review.diff} stacked={false} onOpenInFiles={null} /></div>
        : <div className="p-meta p-text-2">{OMITTED_TEXT[review.diff.omitted]}.</div>}
    </div>
  );
}

type DecidedElsewhere = PendingAction & { kind: Exclude<PendingActionKind, DecidedHere> };

type ProposalDecision = "approve" | "decline";

/** A workspace the agent proposed: the SOUL.md approving writes, and one decision. Nothing exists until approved. */
function WorkspaceProposalCard({ action, rpc, onDecided }: { action: PendingAction; rpc: Rpc; onDecided?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const decide = (answer: ProposalDecision) => Effect.catchCause(Effect.gen(function* () {
    setBusy(true);
    setError(null);
    yield* Effect.promise(() => rpc("decideWorkspaceProposal", [action.id, answer]));
    onDecided?.();
  }), (failed) => Effect.sync(() => {
    setError(`Could not record the decision: ${renderThrownChain({ cause: Cause.squash(failed) })}`);
  })).pipe(Effect.ensuring(Effect.sync(() => { setBusy(false); })));

  return (
    <div className="py-1 space-y-2" data-workspace-proposal={action.id}>
      <div className="flex items-start gap-2">
        <SparkleIcon size={14} className="p-warning shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="p-row-text p-text">{action.title}</div>
          {action.detail && <div className="mt-0.5 break-words p-meta p-text-2">{action.detail}</div>}
          <div className="mt-0.5 p-meta p-text-3">
            The agent asked {timeAgo(action.at)}. Nothing is created until you approve it, under your account.
          </div>
        </div>
      </div>
      {action.proposal !== undefined && (
        <div className="rounded-md px-2 py-1.5 p-elevated">
          <button type="button" className="p-meta p-accent-fg hover:underline" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
            {open ? "Hide its soul" : "Show its soul"}
          </button>
          {open && <pre className="mt-1.5 p-t-code p-text whitespace-pre-wrap break-words" data-workspace-proposal-soul>{action.proposal.soul}</pre>}
        </div>
      )}
      {error && <div className="p-t-status p-danger">{error}</div>}
      <div className="flex items-center gap-1.5 flex-wrap">
        <FilledButton disabled={busy} onClick={() => detach(decide("approve"))}>Create workspace</FilledButton>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => detach(decide("decline"))}>Decline</Button>
      </div>
    </div>
  );
}

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
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "task"; task: AgentTaskTree; owner: WorkspaceWorkOwner }
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "self"; entry: ChangelogEntry };

/** Exported for its test: the ordering is the feature. Every row answers to `All`, a no-change self-review included, because the queue counts it as unseen. */
function buildJournal(
  jobs: readonly BackgroundJob[],
  tasks: readonly WorkTaskRow[],
  entries: readonly ChangelogEntry[],
): JournalRow[] {
  const rows: JournalRow[] = [
    ...jobs.map((job): JournalRow => ({
      key: `job:${job.id}`, at: job.settledAt ?? job.createdAt, chips: ["all", "jobs"], kind: "job", job,
    })),
    ...tasks.map(({ task, owner }): JournalRow => ({
      key: `task:${owner.actorId}:${task.id}`, at: task.updatedAt, chips: ["all", "self"], kind: "task", task, owner,
    })),
    ...entries.map((entry): JournalRow => ({
      key: `self:${entry.id}`, at: entry.at, chips: ["all", "self"], kind: "self", entry,
    })),
  ];

  return rows.sort((a, b) => b.at - a.at);
}

