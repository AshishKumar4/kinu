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
  NotePencilIcon,
} from "@phosphor-icons/react";
import { hasWorkspaceWork, jobPhase, taskTreePhase, revealMisrepresenting, timeAgo, type InspectedWork } from "@kinu.run/core";
import type { AgentTaskTree, Omitted, OwnedPlan, PanelAgent, ParkedWriteReview, PendingAction, PendingActionKind, PlanPageRef, WorkspaceWork, WorkspaceWorkOwner } from "@kinu.run/core";
import type { Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { FilledButton } from "@/components/ui/FilledButton";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import { Section } from "./shared";
import { HelperRow, PlanProgress, TaskTree } from "./work-tasks";
import { InspectedRow, JobCard } from "./work-jobs";
import type { SurfaceKind } from "@kinu.run/core";
import { renderThrownChain, detach, settle } from "@kinu.run/core/obs";
import { WorkPlans } from "./WorkPlans";
import { FileBody } from "./changes/ChangesPanel";
import type { WorkspaceWorkRead } from "./use-workspace-work";

/** Kinds decided in this queue, which is their only home. */
type DecidedHere = "deferred_action" | "workspace_proposal";

/** Where each pending kind is decided; tab names stay out of core. The kinds decided here are absent. */
const PENDING_HOME = {
  scaffold_version: { surface: "Agent", cta: "decide in Agent" },
  // The agent's own changes are the Agent tab's: how it is changing.
  unseen_changes: { surface: "Agent", cta: "see them in Agent" },
  curriculum_task: { surface: null, cta: null },
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
  /** Re-read after a decision so decided rows leave on the click, not the next poll. */
  onRefreshQueue?: () => void;
  rpc: Rpc;
  agents?: { readonly list: readonly PanelAgent[]; readonly open: (agent: PanelAgent) => void };
}

export function WorkTab({
  onReviewActor, work: read, onOpenPlan, pendingActions, backgroundJobs, inspectedWork, onRefreshJobs, onOpenSurface, onRefreshQueue, rpc, agents,
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
      <NeedsYou pendingActions={pendingActions} rpc={rpc} onDecided={onRefreshQueue} onOpenSurface={onOpenSurface} onOpenPlan={onOpenPlan} />
      <WorkNow work={work} taskRows={taskRows} openTasks={openTasks} inspected={inspectedWork} runningJobs={runningJobs} helpers={helpers} onOpenHelper={agents?.open} resource={taskResource} onRetry={reloadTasks} onRefreshJobs={onRefreshJobs} onOpenOwner={onReviewActor} rpc={rpc} />
      <WorkJournal journal={journal} rpc={rpc} onRefreshJobs={onRefreshJobs} onOpenOwner={onReviewActor} />
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
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--c-accent)_32%,transparent)] bg-[var(--c-accent-subtle)] px-[18px] pt-2.5 pb-3.5 [&_.p-label]:!text-[var(--c-accent-fg)]">
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

/** What finished: jobs and tasks, newest first under the day they ended. A row opens what it was. */
function WorkJournal({ journal, rpc, onRefreshJobs, onOpenOwner }: {
  journal: JournalRow[];
  rpc: Rpc;
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
              {action.where !== undefined && <span className="block p-meta p-text-2 mt-0.5 break-all">Runs {revealMisrepresenting(action.where)}</span>}
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
