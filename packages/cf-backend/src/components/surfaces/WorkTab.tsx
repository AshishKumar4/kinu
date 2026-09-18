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
 *               deliberately not a data source a slate can read.
 *   Now       — the plan's open half and the jobs still running.
 *   Journal   — one reverse-chronological feed of everything settled: jobs,
 *               closed tasks, self-changes. The chips filter that one list;
 *               they are filters, not homes.
 *
 * What it does NOT absorb: chat cards stay chat cards. A job settling
 * mid-conversation still gets its transcript card — the journal is where it can
 * be acted on later, not a second narration. And the run's meters stay on the
 * gauge beside the strip, which was already the right home for them.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ClockIcon, PulseIcon, WarningCircleIcon, GitBranchIcon,
  RocketLaunchIcon, PackageIcon, SparkleIcon, CaretRightIcon, ShieldWarningIcon,
} from "@phosphor-icons/react";
import type { AgentTaskTree, ChangelogEntry, PendingAction, PendingActionKind, PlanReview } from "@kinu.run/core";
import type { WorkspacePlanArrival } from "@/hooks/use-kinu";
import type { Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { FilledButton } from "@/components/ui/FilledButton";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { Section } from "./shared";
import { timeAgo } from "@kinu.run/core";
import { isClosedTree, isSettled, PlanProgress, TaskTree } from "./work-tasks";
import { JobCard } from "./work-jobs";
import { ChangelogEntryCard, ChangelogFailure, useChangelog } from "./changelog-entries";
import type { SurfaceKind } from "./WorkSurface";
import { renderThrownChain } from "@kinu.run/core/obs";
import { WorkPlans } from "./WorkPlans";

/** The chips over the journal. `All` holds every row the feed has. The queue
 *  above counts an unseen entry with the same unfiltered read this feed
 *  renders (`listUnseenChangelog`), and its row says to read them "in the
 *  journal below" — so a chip named for everything that dropped one of those
 *  entries sent the owner to a feed without it. Curation belongs to the read
 *  named for it (`buildChangelog`'s `changesOnly`), never to this chip: the
 *  journal half of 28e8206eb is reversed here. Plan history is not a chip:
 *  `WorkPlans` above owns the plan read model (`inspectSubordinate` over
 *  `plan_reviews`), so a second Plan here would be the duplicate B12 removed —
 *  closed tasks are the settled tail, not the home. */
type JournalFilter = "all" | "jobs" | "self";

const FILTERS: Array<{ id: JournalFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "jobs", label: "Jobs" },
  { id: "self", label: "Self-changes" },
];

/**
 * Where each kind of pending thing is actually decided, and the words that
 * send the reader there. The mapping lives here, not in the read model: core
 * has no business knowing tab names. `deferred_action` is absent because it is
 * the one kind with no elsewhere — the queue IS its home, so it is rendered
 * with its own approve/deny controls instead of a deep link.
 *
 * The verb is part of the mapping rather than a fixed "decide in", because it
 * is not always a decision. The unseen digest is a READ — several of its entry
 * kinds are measurements with no keep and no revert — and a row promising a
 * decision over a card that offers none is the same lie as pointing at the
 * wrong tab. That row is also the one with no cta of its own: what it says to
 * do and where to do it is the whole of its detail line, and printing the
 * destination twice on one card reads as a stutter.
 */
const PENDING_HOME = {
  release_approval: { surface: "Releases", cta: "decide in Releases" },
  scaffold_version: { surface: "Agent", cta: "decide in Agent → Evolution" },
  unseen_changes: { surface: null, cta: null },
  curriculum_task: { surface: null, cta: "decide in Supervise" },
} satisfies Record<Exclude<PendingActionKind, "deferred_action">, { surface: SurfaceKind | null; cta: string | null }>;

const PENDING_ICON = {
  release_approval: RocketLaunchIcon,
  scaffold_version: GitBranchIcon,
  unseen_changes: SparkleIcon,
  curriculum_task: PackageIcon,
} satisfies Record<Exclude<PendingActionKind, "deferred_action">, typeof ClockIcon>;

export interface WorkTabProps {
  plan: PlanReview | null;
  planRpc: Rpc;
  planOwner?: string;
  workspacePlanArrival?: WorkspacePlanArrival | null;
  activePlanActors?: readonly string[];
  onReviewActor?: (name: string) => void | Promise<void>;
  /** Polled by the hook so the tab badge and this queue are one read. */
  pendingActions: PendingAction[];
  backgroundJobs: BackgroundJob[];
  onRefreshJobs: () => void;
  /** Deep-link a queue row to where its decision is made. */
  onOpenSurface: (surface: SurfaceKind) => void;
  /** The changelog was seen — zero the badge upstream. */
  onChangelogSeen?: () => void;
  /** Re-read the queue after a decision, so decided rows leave on the click
   *  rather than on the next ambient poll. */
  onRefreshQueue?: () => void;
  /** A turn is in flight — the plan is rewritten while it is. */
  isStreaming: boolean;
  rpc: Rpc;
}

export function WorkTab({
  plan, planRpc, planOwner, workspacePlanArrival, activePlanActors, onReviewActor, pendingActions, backgroundJobs, onRefreshJobs, onOpenSurface, onChangelogSeen, onRefreshQueue, isStreaming, rpc,
}: WorkTabProps) {
  const [filter, setFilter] = useState<JournalFilter>("all");
  const [hasPlans, setHasPlans] = useState(plan !== null);
  const onNewPlan = useCallback(() => onOpenSurface("Work"), [onOpenSurface]);

  const loadTasks = useCallback(() => planRpc<AgentTaskTree[]>("listAgentTasks", []), [planRpc]);

  // The agent writes its plan mid-turn and the server never pushes it, so the
  // tab revalidates while anything is still open and stands down once
  // everything has settled.
  const revalidate = useCallback((tasks: AgentTaskTree[] | null) => {
    if (isStreaming) return 4000;
    const open = (tasks ?? []).some((t) => !isSettled(t.status) || t.subtasks.some((s) => !isSettled(s.status)));

    return open ? 4000 : null;
  }, [isStreaming]);

  const { resource: taskResource, reload: reloadTasks } = useAsyncResource(loadTasks, revalidate);
  const tasks = lastValue(taskResource);

  const {
    view: changelog, seenAt: changelogSeenAt, seenError: changelogSeenError,
    resource: changelogResource, reload: reloadChangelog,
  } = useChangelog(rpc, onChangelogSeen);

  const openTasks = (tasks ?? []).filter((task) => !isClosedTree(task));
  const closedTasks = (tasks ?? []).filter(isClosedTree);
  const runningJobs = backgroundJobs.filter((job) => job.status === "running");
  const settledJobs = backgroundJobs.filter((job) => job.status !== "running");

  const journal = useMemo(
    () => buildJournal(settledJobs, closedTasks, changelog?.entries ?? []),
    [settledJobs, closedTasks, changelog],
  );

  const visible = journal.filter((row) => row.chips.includes(filter));

  // Commands the agent parked on the owner decide HERE — grouped so a night's
  // worth is one decision rather than N scattered rows. Everything else keeps
  // its deep link to where its decision is really made.
  const parkedCommands = pendingActions.filter((a) => a.kind === "deferred_action");

  const elsewhere = pendingActions.filter(
    (a): a is DecidedElsewhere => a.kind !== "deferred_action");

  // Empty sections render nothing: the tab opens with one pending action and
  // no in-flight work as "Needs you" alone, with no Now section beneath it.
  const nothingAtAll = pendingActions.length === 0 && openTasks.length === 0
    && runningJobs.length === 0 && journal.length === 0
    && tasks !== null && changelog !== null;

  if (nothingAtAll && !hasPlans && !plan) {
    return (
      <div className="space-y-6"><WorkPlans active={plan} rpc={planRpc} rootRpc={rpc} owner={planOwner} arrival={workspacePlanArrival} activeActors={activePlanActors} onPresence={setHasPlans} onNewPlan={onNewPlan} onReviewActor={onReviewActor} /><p className="p-row-text p-text-3">Nothing yet</p></div>
    );
  }

  const nowEmpty = tasks !== null && openTasks.length === 0 && runningJobs.length === 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <WorkPlans active={plan} rpc={planRpc} rootRpc={rpc} owner={planOwner} arrival={workspacePlanArrival} activeActors={activePlanActors} onPresence={setHasPlans} onNewPlan={onNewPlan} onReviewActor={onReviewActor} />
      {pendingActions.length > 0 && (
        <div className="rounded-lg border border-[rgba(224,164,88,.32)] bg-[rgba(224,164,88,.06)] px-[18px] pt-2.5 pb-3.5 [&_.p-label]:!text-[var(--c-accent-fg)]">
          <Section id="work-needs-you" title="Needs you"
            icon={<WarningCircleIcon size={14} className="p-accent" />}
            badge={<Badge variant="secondary">{pendingActions.length}</Badge>}>
            <div className="divide-y divide-dashed divide-[var(--c-dash)]">
              {parkedCommands.length > 0 && (
                <ParkedCommands actions={parkedCommands} rpc={rpc} onDecided={onRefreshQueue} />
              )}
              {elsewhere.map((action) => (
                <PendingRow key={action.id} action={action} onOpenSurface={onOpenSurface} />
              ))}
            </div>
          </Section>
        </div>
      )}

      {!nowEmpty && (
      <Section id="work-now" title="Now" icon={<PulseIcon size={14} className="p-text-2" />}>
        <div className="space-y-3">
          {/* The plan read's tri-state covers the PLAN half only. Gating the
              whole section on it put a running job behind the plan's spinner,
              and dropped it altogether when that read failed — two ledgers,
              and this one is already in hand as a prop. */}
          {taskResource.status === "error" && tasks === null ? (
            <LoadFailure what="the plan" message={taskResource.message} onRetry={reloadTasks} />
          ) : tasks === null ? (
            <div className="flex justify-center py-4"><Loader size="sm" /></div>
          ) : (
            <>
              {tasks.length > 0 && <PlanProgress tasks={tasks} />}
              {openTasks.length > 0 && (
                <div className="space-y-2">
                  {openTasks.map((task) => <TaskTree key={task.id} task={task} />)}
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
      )}

      {(journal.length > 0 || changelogResource.status === "error") && (
      <Section id="work-journal" title="Journal"
        icon={<ClockIcon size={14} className="p-text-2" />}
        badge={journal.length > 0 ? <Badge variant="secondary">{journal.length}</Badge> : undefined}>
        <div className="space-y-3">
          {journal.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {FILTERS.map((chip) => (
                <button key={chip.id} type="button" onClick={() => setFilter(chip.id)}
                  aria-pressed={filter === chip.id}
                  className={`px-2.5 py-0.5 p-t-control rounded-full transition-colors ${filter === chip.id ? "bg-[rgba(224,164,88,.1)] p-accent" : "p-text-3 hover:p-accent"}`}>
                  {chip.label}
                </button>
              ))}
            </div>
          )}

          {/* Spinner until the digest has loaded once, and the failure on every
              read that breaks after — including a revalidation over a snapshot
              still on screen, which would otherwise go stale in silence. The
              failure is also why this section renders over an empty feed: gated
              on rows alone, a broken digest read left the whole tab blank. */}
          {(changelog === null || changelogResource.status === "error") && (
            <ChangelogFailure resource={changelogResource} reload={reloadChangelog} />
          )}
          {changelogSeenError && (
            <div className="text-xs p-warning p-card rounded-lg px-3 py-1.5">
              Couldn't mark the changelog as seen: {changelogSeenError}
            </div>
          )}

          {journal.length > 0 && (visible.length > 0 ? (
            <div className="p-group">
              {visible.map((row) => (
                <div key={row.key}>
                  {row.kind === "job" && <JobCard grouped job={row.job} onRefresh={onRefreshJobs} rpc={rpc} />}
                  {row.kind === "task" && <TaskTree grouped task={row.task} />}
                  {row.kind === "self" && (
                    <ChangelogEntryCard grouped entry={row.entry} seenAt={changelogSeenAt}
                      rpc={rpc} onReverted={reloadChangelog} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="p-row-text p-text-3">Nothing under this chip</p>
          ))}
        </div>
      </Section>
      )}
    </div>
  );
}

/* ── the needs-you queue ───────────────────────────────────────── */

/**
 * Commands the agent stopped on because the gate wanted an approval and nobody
 * was there to give it.
 *
 * Decided here and nowhere else, and decided in BULK: an unattended overnight
 * run parks a pile, and the failure this whole mechanism exists to remove is
 * the owner working through them one prompt at a time. Selection defaults to
 * everything, so the common case ("these are all fine") is one click.
 *
 * Nothing here has run. Approving does not run it either — the agent is woken
 * and re-issues the command itself, which is the only moment it executes. The
 * copy says so, because a button labelled "Approve" on a queue of commands is
 * otherwise easy to read as "Run".
 */
/** What a bulk button says it will act on: nothing extra for a queue of one,
 *  "all" when the whole queue is selected, the count otherwise. */
function countLabel(chosen: number, total: number): string {
  if (total === 1) return "";

  return chosen === total ? "all" : String(chosen);
}

/**
 * `always` is the third answer the queue has always accepted and never
 * offered. It approves these commands AND records a standing grant for each
 * gate-tier check they tripped, on the environment they were asked about — so
 * the same question stops arriving. Nothing wider: the grant is one rule on
 * one machine, it widens no access, and a rule the gate refuses outright
 * cannot be granted at all. Settings → Standing approvals lists what is held
 * and is the only place to take one back.
 */
/** The three answers the queue has always accepted. */
export type ParkedDecision = "approved" | "denied" | "always";

export interface ParkedDecisionDeps {
  /** `decideDeferredApprovals` over the surface's RPC seam. */
  decide: (ids: string[], decision: ParkedDecision) => Promise<{ decided: string[] }>;
  /** Re-read the queue — a decided row leaves the list on this click, not on
   *  the next ambient poll. */
  onDecided: () => void;
}

export interface ParkedQueueSnapshot {
  /** What a bulk button would act on: null is the untouched default and means
   *  EVERYTHING, so a command parked mid-review joins an "approve all" click
   *  instead of being silently left out. After a decision it is the EMPTY set
   *  — what was decided stays unticked; it is not re-selected. */
  readonly selected: ReadonlySet<string> | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly decided: ParkedDecision | null;
}

/**
 * The queue's decision half, and a plain object so every claim about it is
 * provable without a browser: nothing it records re-selects what was just
 * decided, and a recorded decision always re-reads the queue.
 *
 * The defect this locks: `decide` resetting the selection to null — and null
 * means everything — re-ticks every box the instant the call lands, and a
 * `decide` that does not re-read the queue leaves the decided rows on screen.
 */
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

  /** What a bulk button would act on — everything while untouched, exactly
   *  what is ticked once anything is. */
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
      // The EMPTY set, never null: null selects everything, and what was
      // just decided must leave, not re-tick.
      this.#set({ busy: false, selected: new Set(), error: null, decided: decision });
      // Deciding records the answer; re-reading is what makes the rows leave.
      this.#deps.onDecided();
    } catch (cause) {
      // The answer never landed, so the selection stands — the owner's intent
      // is still the selection on screen.
      this.#set({ busy: false, error: `Could not record the decision: ${renderThrownChain({ cause })}` });
    }
  };

  #set(partial: Partial<ParkedQueueSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...partial };

    for (const listener of this.#listeners) listener();
  }
}

export function ParkedCommands({ actions, rpc, onDecided, flow: injected }: { actions: PendingAction[]; rpc: Rpc; onDecided?: () => void; flow?: ParkedDecisionFlow }) {
  const [fresh] = useState(() => new ParkedDecisionFlow({
    decide: (ids, decision) => rpc("decideDeferredApprovals", [ids, decision]),
    onDecided: () => onDecided?.(),
  }));

  const flow = injected ?? fresh;
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  const allIds = actions.map((a) => a.id);
  // Null means "everything", so a newly-parked action arriving mid-review is
  // included rather than silently left out of an "approve all" click. The
  // rule lives in the flow, beside the untick that must never become it.
  const chosen = flow.chosen(allIds);

  const decidedLine = state.decided === "denied"
    ? "Denied. The agent will be told, and nothing runs."
    : state.decided === "always"
      // Permission is not an effect: the command still has not run, and the
      // agent is the only thing that runs it. Saying "done" here would be the
      // same lie the queued tool result is worded to avoid.
      ? "Approved. Kinu will stop asking about these checks in this environment."
      : state.decided === "approved"
        ? "Approved. It runs when the agent picks the decision up."
        : null;

  return (
    <div className="py-1 space-y-2">
      <div className="flex items-start gap-2">
        <ShieldWarningIcon size={14} className="p-accent shrink-0 mt-0.5" />
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
              {/* Which machine, before you authorise it. The read model puts it
                  in the title precisely because it is half the decision, so
                  this card never drops the title on the floor. */}
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

/** A pending action whose decision is made on another surface — everything
 *  except a parked command, which is decided in the queue itself. */
type DecidedElsewhere = PendingAction & { kind: Exclude<PendingActionKind, "deferred_action"> };

function PendingRow(
  { action, onOpenSurface }: { action: DecidedElsewhere; onOpenSurface: (surface: SurfaceKind) => void },
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

  const icon = <Icon size={14} className="mt-0.5 shrink-0 p-accent" />;

  if (home.surface === null) {
    return <div className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2 py-2">{icon}{content}</div>;
  }

  const surface = home.surface;

  return (
    <button
      type="button"
      onClick={() => onOpenSurface(surface)}
      className="grid w-full grid-cols-[14px_minmax(0,1fr)_16px] items-start gap-2 rounded-md py-2 text-left transition-colors hover:p-elevated"
    >
      {icon}
      {content}
      <CaretRightIcon size={12} className="mt-1 shrink-0 justify-self-end p-text-3" />
    </button>
  );
}

/* ── the journal ───────────────────────────────────────────────── */

/** A row and the chips it answers to. Membership is decided by the builder
 *  below, never by the renderer, so one place holds the rule and no chip can
 *  drift from the feed it filters. */
type JournalRow =
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "job"; job: BackgroundJob }
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "task"; task: AgentTaskTree }
  | { key: string; at: number; chips: readonly JournalFilter[]; kind: "self"; entry: ChangelogEntry };

/**
 * One reverse-chronological feed out of three ledgers.
 *
 * Exported for its test: the ordering IS the feature — three separate ledgers
 * have to read as one stream, or the merge has bought nothing but a longer
 * page. The chips each row answers to are here for the same reason. Closed
 * tasks ride the `self` filter: they are settled history, and the live plan
 * already has its home in `WorkPlans` above.
 *
 * EVERY ROW ANSWERS TO `All`, a self-review that changed nothing
 * ({@link ChangelogEntry.noChange}) included. The queue above counts that
 * entry as unseen — `listUnseenChangelog` reads the digest with no
 * `changesOnly` — and tells the owner to read it in the journal below, so a
 * chip named for everything that dropped it pointed at a feed without it.
 * That is the journal half of 28e8206eb reversed: the curation lives in the
 * read named for it, and the row reads as a no-op from its own summary.
 */
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

