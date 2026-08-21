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
import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
  ClockIcon, PulseIcon, WarningCircleIcon, GitBranchIcon,
  RocketLaunchIcon, PackageIcon, SparkleIcon, CaretRightIcon, ShieldWarningIcon,
} from "@phosphor-icons/react";
import type { AgentTaskTree, ChangelogEntry, PendingAction, PendingActionKind } from "@kinu.run/core";
import type { BackgroundJob, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { EmptyState, Section, timeAgo } from "./shared";
import { isClosedTree, isSettled, PlanProgress, TaskTree } from "./work-tasks";
import { JobCard } from "./work-jobs";
import { ChangelogEntryCard, ChangelogFailure, useChangelog } from "./changelog-entries";
import type { SurfaceKind } from "./WorkSurface";
import { renderThrownChain } from "@kinu.run/core/obs";

/** Which filter a journal row answers to. `All` is not a filter, it is no
 *  filter — the chips are views over one list. */
type JournalFilter = "all" | "jobs" | "plan" | "self";

const FILTERS: Array<{ id: JournalFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "jobs", label: "Jobs" },
  { id: "plan", label: "Plan" },
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
  failed_job: { surface: null, cta: "retry or dismiss it in the journal below" },
  unseen_changes: { surface: null, cta: null },
  curriculum_task: { surface: null, cta: "decide in Supervise" },
} satisfies Record<Exclude<PendingActionKind, "deferred_action">, { surface: SurfaceKind | null; cta: string | null }>;

const PENDING_ICON = {
  release_approval: RocketLaunchIcon,
  scaffold_version: GitBranchIcon,
  failed_job: WarningCircleIcon,
  unseen_changes: SparkleIcon,
  curriculum_task: PackageIcon,
} satisfies Record<Exclude<PendingActionKind, "deferred_action">, typeof ClockIcon>;

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
  const visible = journal.filter((row) => filter === "all" || row.filter === filter);

  // Commands the agent parked on the owner decide HERE — grouped so a night's
  // worth is one decision rather than N scattered rows. Everything else keeps
  // its deep link to where its decision is really made.
  const parkedCommands = pendingActions.filter((a) => a.kind === "deferred_action");
  const elsewhere = pendingActions.filter(
    (a): a is DecidedElsewhere => a.kind !== "deferred_action");

  const nothingAtAll = pendingActions.length === 0 && openTasks.length === 0
    && runningJobs.length === 0 && journal.length === 0
    && tasks !== null && changelog !== null;

  if (nothingAtAll) {
    return (
      <EmptyState title="Nothing has happened yet"
        hint="The plan the agent writes for itself, the work it detaches, and the changes it makes to itself all land here, with anything waiting on you at the top." />
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {pendingActions.length > 0 && (
        <Section id="work-needs-you" title="Needs you"
          icon={<WarningCircleIcon size={14} className="p-accent" />}
          badge={<Badge variant="secondary">{pendingActions.length}</Badge>}>
          <div className="space-y-1.5">
            {parkedCommands.length > 0 && (
              <ParkedCommands actions={parkedCommands} rpc={rpc} />
            )}
            {elsewhere.map((action) => (
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

          {/* Spinner until the digest has loaded once, and the failure on every
              read that breaks after — including a revalidation over a snapshot
              still on screen, which would otherwise go stale in silence. */}
          {(changelog === null || changelogResource.status === "error") && (
            <ChangelogFailure resource={changelogResource} reload={reloadChangelog} />
          )}
          {changelogSeenError && (
            <div className="text-xs p-warning p-card rounded-lg px-3 py-1.5">
              Couldn't mark the changelog as seen: {changelogSeenError}
            </div>
          )}

          {visible.length === 0 ? (
            // Never claimed while a third of this feed is still unread.
            changelog !== null && (
              <p className="text-xs p-text-3">
                {journal.length === 0
                  ? "Nothing has settled yet. Finished jobs, closed plan items and the agent's own changes land here."
                  : "Nothing under this filter."}
              </p>
            )
          ) : (
            <div className="space-y-2">
              {visible.map((row) => (
                <div key={row.key}>
                  {row.kind === "job" && <JobCard job={row.job} onRefresh={onRefreshJobs} rpc={rpc} />}
                  {row.kind === "task" && <TaskTree task={row.task} />}
                  {row.kind === "self" && (
                    <ChangelogEntryCard entry={row.entry} seenAt={changelogSeenAt}
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
function ParkedCommands({ actions, rpc }: { actions: PendingAction[]; rpc: Rpc }) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<string | null>(null);
  // Null means "everything", so a newly-parked action arriving mid-review is
  // included rather than silently left out of an "approve all" click.
  const chosen = selected ?? new Set(actions.map((a) => a.id));

  const toggle = (id: string) => {
    setSelected(new Set(
      chosen.has(id) ? [...chosen].filter((x) => x !== id) : [...chosen, id],
    ));
  };

  const decide = async (decision: "approved" | "denied" | "always") => {
    if (busy || chosen.size === 0) return;
    setBusy(true);
    setError(null);
    setDecided(null);
    try {
      await rpc("decideDeferredApprovals", [[...chosen], decision]);
      setSelected(null);
      // Permission is not an effect: the command still has not run, and the
      // agent is the only thing that runs it. Saying "done" here would be the
      // same lie the queued tool result is worded to avoid.
      setDecided(decision === "denied"
        ? "Denied. The agent will be told, and nothing runs."
        : decision === "always"
          ? "Approved, and Kinu will stop asking about these checks on that environment. It runs when the agent picks the decision up."
          : "Approved. It runs when the agent picks the decision up.");
    } catch (e) {
      const message = renderThrownChain({ cause: e });
      setError(`Could not record the decision: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-card px-3 py-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <ShieldWarningIcon size={14} className="p-accent shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-xs p-text leading-relaxed">
            {actions.length} command{actions.length === 1 ? "" : "s"} waiting on your approval
          </div>
          <div className="text-[10px] p-text-3 mt-0.5">
            None of these have run. The agent was told they are queued and carried on. Approving lets it
            run them when it picks the decision up.
          </div>
        </div>
      </div>

      <div className="space-y-1">
        {actions.map((action) => (
          <label key={action.id}
            className="flex items-start gap-2 rounded-md px-2 py-1.5 p-elevated cursor-pointer">
            <input type="checkbox" className="mt-0.5 shrink-0" checked={chosen.has(action.id)}
              onChange={() => toggle(action.id)} disabled={busy} />
            <span className="min-w-0 flex-1">
              <code className="block text-[11px] p-text break-all whitespace-pre-wrap">{action.detail}</code>
              {/* Which machine, before you authorise it. The read model puts it
                  in the title precisely because it is half the decision, and
                  this card used to drop the title on the floor. */}
              <span className="block text-[10px] p-text-3 mt-0.5">{action.title} · queued {timeAgo(action.at)}</span>
            </span>
          </label>
        ))}
      </div>

      {error && <div className="text-[10px] p-danger">{error}</div>}
      {decided && <div className="text-[10px] p-text-3">{decided}</div>}

      <div className="flex items-center gap-1.5 flex-wrap">
        <Button size="sm" variant="primary" disabled={busy || chosen.size === 0}
          onClick={() => decide("approved")}>
          Approve {countLabel(chosen.size, actions.length)}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || chosen.size === 0}
          onClick={() => decide("always")}
          title="Approve these, and stop asking about the same checks on the same environment. Manage or revoke in Settings → Standing approvals.">
          Always allow {countLabel(chosen.size, actions.length)}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || chosen.size === 0}
          onClick={() => decide("denied")}>
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
  const body = (
    <>
      <Icon size={14} className="p-accent shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs p-text leading-relaxed">{action.title}</div>
        {action.detail && (
          <div className="text-[10px] p-text-3 mt-0.5 line-clamp-2 break-words">{action.detail}</div>
        )}
        <div className="text-[10px] p-text-3 mt-0.5">
          {timeAgo(action.at)}{home.cta === null ? "" : ` · ${home.cta}`}
        </div>
      </div>
    </>
  );
  if (home.surface === null) {
    return <div className="p-card px-3 py-2 flex items-start gap-2">{body}</div>;
  }
  return (
    <button type="button" onClick={() => onOpenSurface(home.surface!)}
      className="w-full p-card px-3 py-2 flex items-start gap-2 text-left hover:p-elevated transition-colors">
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
