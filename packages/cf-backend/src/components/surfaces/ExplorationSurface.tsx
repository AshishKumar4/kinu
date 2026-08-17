/**
 * Exploration — every time the agent tried more than one path.
 *
 * ONE list and ONE tree, not a tab per mechanism. The old surface split MCTS
 * from Branches, which mirrored a storage split (search_nodes vs head_journal)
 * that `agents(action:'fork')` picks between on its `settle` argument — so the
 * same user action landed in a different tab depending on an internal strategy
 * id, and the owner twice found an empty pane where his forks should have been.
 *
 * The unification is honest because a fork IS a tree either way: a merge is
 * that tree at depth 1 (the task, then one branch per head) and a competition
 * is the same tree deeper, with scores on it. Master-detail rather than
 * latest-vs-past tabs: every fork the workspace ever ran is a row, newest
 * first, the live one selected on arrival.
 *
 * NOT the chat's thinking text — that streams inline as reasoning blocks in the
 * transcript, which is why this surface does not wear that word. GEPA and the
 * quality scoreboard are not here either: they measure the agent's trajectory
 * across scaffold versions and live under Agent → Evolution.
 */
import { useState, useCallback, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { GitForkIcon, TreeStructureIcon, ArrowsOutIcon, XIcon } from "@phosphor-icons/react";
import type { ForkRunParams, ForkRunSummary, HeadRunView } from "@proteus/core";
import { ForkTree } from "@/components/fork-tree";
import { NodeTranscript } from "@/components/NodeTranscript";
import { type ExplorerSelection } from "@/components/fork-tree-model";
import { buildTree, type MctsRow } from "@/lib/fork-tree-rows";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ScrollBoundary } from "@/components/ui/ScrollBoundary";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useElementSize } from "@/hooks/use-element-size";
import { EmptyState, EMPTY_HINTS, formatScore } from "./shared";
import {
  forkParamRows, FORK_REVALIDATE_MS, headRunToTree, settlePolicyOf, useExplorationCanvas,
} from "./fork-runs";

export interface ExplorationSurfaceProps {
  /** Trees of the searches in flight, keyed by search, fed by `mcts-progress`
   *  broadcasts. Used in place of the polled rows for the searches they cover,
   *  so a running search redraws per iteration rather than per poll. Keyed
   *  because a workspace runs several searches at once and one slot made them
   *  overwrite each other. */
  liveTrees: ReadonlyMap<string, ForkNode>;
  /** A turn is in flight — new forks and branches land while it is. */
  isStreaming: boolean;
  /** Detached work can create or continue a fork without a streaming turn. */
  backgroundJobs: readonly BackgroundJob[];
  rpc: Rpc;
  /** Per-branch journal-write counter, from the `head_activity` broadcast. What
   *  makes an OPEN branch's transcript grow as that branch works. */
  headActivity: ReadonlyMap<string, number>;
}

export function ExplorationSurface({
  liveTrees, isStreaming, backgroundJobs, rpc, headActivity,
}: ExplorationSurfaceProps) {
  const { agentId } = useParams();
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  /** The node being inspected, or null. It no longer REPLACES the canvas: the
   *  canvas and the branch are two panes of the same view, because reading what
   *  a branch did means looking at where it sits in the search at the same
   *  time. */
  const [selection, setSelection] = useState<ExplorerSelection | null>(null);

  const {
    resource, reload, runs, params, trees,
    exhausted, loadingMore, pageError, loadMore,
  } = useExplorationCanvas(rpc, isStreaming, backgroundJobs, liveTrees);
  // The list is the scroll container in both layouts, so the trigger lives on it
  // rather than on the canvas beside it.
  const listRef = useGrowingScroll<HTMLDivElement>({
    grows: "down", content: runs, fetched: runs, onReachEdge: loadMore,
  });

  if (runs === null) {
    return resource.status === "error"
      ? <LoadFailure what="the fork runs" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }
  if (runs.length === 0) {
    return <EmptyState icon={<GitForkIcon size={28} />} title="No forks yet" hint={EMPTY_HINTS.forks} />;
  }

  // The newest fork is what the operator came to look at, so it is focused on
  // arrival; once they pick another, a later poll must not move the focus.
  const focused = runs.find((run) => run.id === focusedRunId) ?? runs[0]!;
  const opened = selection === null ? null : runs.find((run) => run.id === selection.runId) ?? null;

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 animate-fade-in">
      {resource.status === "error" && (
        <LoadFailure what="fresh fork runs" message={resource.message} onRetry={reload} />
      )}
      {/* Three panes once there is room for them: the runs, the canvas, the
          branch. The canvas takes the whole height of its column and every
          spare pixel of width, which is the proportion the tree needs and the
          one a stack of fixed-height cards could never give it.

          Narrower than that, three columns would leave the tree ~200px, so the
          branch takes the canvas's place while it is open — and stacked
          narrowest of all, the list is content-height (capped, then it scrolls)
          so it cannot stretch into dead space above the canvas. */}
      <div className="flex-1 min-h-0 grid gap-3 grid-rows-[auto_minmax(0,1fr)] @3xl:grid-rows-1 @3xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] @6xl:grid-cols-[minmax(200px,250px)_minmax(0,1fr)_minmax(330px,400px)]">
        <div ref={listRef}
          className="min-h-0 max-h-44 @3xl:max-h-none overflow-y-auto rounded-lg border p-border p-surface p-1.5 space-y-0.5">
          {runs.map((run) => (
            <ForkRunRow key={run.id} run={run} params={params.get(run.id)}
              selected={focused.id === run.id}
              onSelect={() => { setSelection(null); setFocusedRunId(run.id); }} />
          ))}
          <ScrollBoundary what="forks" count={runs.length}
            loading={loadingMore} exhausted={exhausted} error={pageError} onRetry={loadMore} />
        </div>
        <div className={`min-h-0 ${selection === null ? "" : "hidden @6xl:block"}`}>
          <ForkCanvas
            runs={runs} params={params} trees={trees}
            focusedId={focused.id} selection={selection}
            onFocus={setFocusedRunId}
            onSelectNode={setSelection}
            expandTo={agentId ? `/mcts/${agentId}?run=${encodeURIComponent(focused.id)}` : null}
          />
        </div>
        <div className={`min-h-0 ${selection === null ? "hidden @6xl:block" : ""}`}>
          {opened !== null && selection !== null
            ? <ForkBranchView
                run={opened} branchId={selection.nodeId} rpc={rpc}
                trees={trees}
                headActivity={headActivity}
                onClose={() => setSelection(null)}
                onOpenBranch={(branchId) => setSelection({ runId: opened.id, nodeId: branchId })}
              />
            : <div className="h-full rounded-lg border p-border p-surface flex items-center justify-center p-4">
                <EmptyState icon={<TreeStructureIcon size={26} />} title="No branch open"
                  hint="Pick a node on the canvas to read what that branch did." />
              </div>}
        </div>
      </div>
    </div>
  );
}

/* ── the run list ──────────────────────────────────────────────── */

const RUN_DOT = {
  running: "p-dot-warning",
  completed: "p-dot-success",
  failed: "p-dot-danger",
  partial: "p-dot-neutral",
} satisfies Record<ForkRunSummary["status"], string>;

/**
 * What the fork WAS and what became of its branches, in that order.
 *
 * The row used to say only `merged`/`competed`, the outcome vocabulary, so two
 * runs dispatched under different policies were indistinguishable until one of
 * them happened to have a winner — and a run that never settled read as
 * "merged" with nothing merged. Leading with `settle=` names the policy the
 * caller actually asked for; the branch count and, where there is one, the
 * winner follow it.
 */
export function describeSettle(run: ForkRunSummary, params?: ForkRunParams): string {
  const branches = `${run.branches} branch${run.branches === 1 ? "" : "es"}`;
  const policy = `settle=${settlePolicyOf(run, params)}`;
  if (run.settle === "merged") return `${policy} · ${branches}`;
  const winner = run.winnerScore === null ? "" : ` · winner ${formatScore(run.winnerScore)}`;
  return `${policy} · ${branches}${winner}`;
}

/** What became of the run, said as an outcome rather than as a settle policy —
 *  the distinction the old label collapsed. `partial` is the honest word for a
 *  run that stopped without an answer, and a merge policy that never reached its
 *  synthesis is exactly that. */
const RUN_OUTCOME = {
  running: "running",
  completed: "settled",
  failed: "failed",
  partial: "stopped without an answer",
} satisfies Record<ForkRunSummary["status"], string>;

function ForkRunRow(
  { run, params, selected, onSelect }:
  { run: ForkRunSummary; params: ForkRunParams | undefined; selected: boolean; onSelect: () => void },
) {
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}
      className={`w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 transition-colors ${selected ? "p-fill" : "p-card-hover"}`}>
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "animate-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] p-text-2 truncate" title={run.task}>{run.task}</div>
        <div className="text-[10px] p-text-3 tabular-nums">
          {describeSettle(run, params)} · {RUN_OUTCOME[run.status]}
        </div>
        <div className="text-[10px] p-text-3 tabular-nums">
          {new Date(run.startedAt).toLocaleString()}
        </div>
      </div>
    </button>
  );
}

/* ── one fork: its tree, and whatever the selected branch actually was ── */

/**
 * A merged run's branches and their traces — the journal's projection.
 *
 * Only a merge needs it: a competition's branches ARE its search rows, which the
 * canvas already carries, while a merge's live per-branch step trace exists
 * nowhere else. Competed runs resolve to null without a request.
 */
export function useForkRunDetail(run: ForkRunSummary, rpc: Rpc, hasActiveWork: boolean) {
  const load = useCallback(
    () => run.settle === "merged"
      ? rpc<HeadRunView | null>("getHeadRun", [run.id])
      : Promise.resolve<HeadRunView | null>(null),
    [rpc, run.id, run.settle],
  );
  const revalidate = useCallback(
    () => (run.status === "running" || hasActiveWork ? FORK_REVALIDATE_MS : null),
    [run.status, hasActiveWork],
  );
  const { resource, reload } = useAsyncResource<HeadRunView | null>(
    load, revalidate, `${run.settle}:${run.id}`,
  );
  return { headRun: lastValue(resource) ?? null, resource, reload };
}

/**
 * One run's tree, from whichever store holds it — the single-run drill-down.
 *
 * A competed run whose search is in flight is served by the broadcast tree
 * instead of a fetch: the engine pushes a tree per iteration, and polling for
 * that would be both slower and noisier. The canvas does not use this — it has
 * every tree from one projection and only needs {@link useForkRunDetail}.
 */
export function useForkRunTree(
  run: ForkRunSummary, rpc: Rpc, liveTree: ForkNode | null, hasActiveWork: boolean,
) {
  const detail = useForkRunDetail(run, rpc, hasActiveWork);
  const load = useCallback(
    () => run.settle === "competed"
      ? rpc<MctsRow[]>("getSearchTree", [run.id])
      : Promise.resolve<MctsRow[]>([]),
    [rpc, run.id, run.settle],
  );
  const revalidate = useCallback(
    () => (run.status === "running" || hasActiveWork ? FORK_REVALIDATE_MS : null),
    [run.status, hasActiveWork],
  );
  const { resource, reload } = useAsyncResource(load, revalidate, `search:${run.id}`);
  const rows = lastValue(resource);
  const fetched = run.settle === "competed"
    ? (rows && rows.length > 0 ? buildTree(rows) : null)
    : (detail.headRun ? headRunToTree(detail.headRun) : null);
  return {
    tree: liveTree ?? fetched,
    headRun: detail.headRun,
    resource: run.settle === "competed" ? resource : detail.resource,
    reload: run.settle === "competed" ? reload : detail.reload,
  };
}

/* ── one branch, opened ────────────────────────────────────────── */

/**
 * A branch, opened.
 *
 * The owner's ask was for the chat, not a card: *"it should just be like a chat
 * view except there are no user inputs or user messages."* So the body is
 * {@link NodeTranscript}, which renders every step through the SAME
 * `MessageView` the main thread uses; what stays here is the frame that says
 * which fork this branch belongs to and how that fork settled — the one thing
 * the transcript itself cannot know.
 *
 * The metadata card this replaced (a verdict grid, a clamped summary, and a step
 * list that truncated reasoning to three lines and tool output to 160
 * characters) could not answer "what did this branch actually do", which is the
 * whole reason a reader opens one.
 *
 * Its own pane, beside the canvas rather than over it: reading what a branch did
 * and seeing where it sits in the search are the same question, and answering it
 * by replacing the tree meant losing the tree. So it closes with an X — a
 * back-arrow to "all trees" would name a journey the reader never took, because
 * the trees never left.
 */
function ForkBranchView({
  run, branchId, trees, rpc, headActivity, onClose, onOpenBranch,
}: {
  run: ForkRunSummary;
  branchId: string;
  /** Every drawn tree, keyed by run — the transcript names a node from it when
   *  the store has no record of that node at all. */
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  onClose: () => void;
  onOpenBranch: (branchId: string) => void;
}) {
  return (
    <div className="h-full min-h-0 flex flex-col gap-2">
      <div className="shrink-0 flex items-center gap-2 min-w-0">
        <div className="min-w-0 flex-1 text-[10px] p-text-3 truncate">
          in <span className="font-mono">{run.task}</span> · {describeSettle(run)}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close this branch"
          title="Close this branch" className="shrink-0">
          <XIcon size={12} />
        </Button>
      </div>
      <NodeTranscript
        selection={{ runId: run.id, nodeId: branchId }}
        trees={trees} rpc={rpc} headActivity={headActivity}
        onSelect={onOpenBranch} />
    </div>
  );
}

/**
 * The canvas: every tree the workspace has grown, on ONE surface.
 *
 * The surface once rendered exactly one tree — the run selected in the list — so
 * a workspace with five forks showed one of them and the other four existed only
 * as rows. Then it rendered one FIXED-HEIGHT canvas per run, stacked in cards,
 * which is worse in the way that matters: the room a tree could use was decided
 * before anyone knew how big the tree was, so a three-node merge held 300px it
 * could not fill while a hundred-node search was squeezed into the same 300px,
 * and a card's chrome and gutter were spent on every run.
 *
 * One canvas, one zoom, one scene. Every run is a band inside it under a soft
 * boundary, sized to the tree it holds; the selected band is lit and the others
 * recede without leaving. Choosing from the list FOCUSES a band — the view
 * refits to it — rather than filtering to it, so the comparison that made the
 * reader open the tab stays on screen.
 */
function ForkCanvas({
  runs, params, trees, focusedId, selection, onFocus, onSelectNode, expandTo,
}: {
  runs: readonly ForkRunSummary[];
  params: ReadonlyMap<string, ForkRunParams>;
  trees: ReadonlyMap<string, ForkNode>;
  focusedId: string;
  selection: ExplorerSelection | null;
  onFocus: (runId: string) => void;
  onSelectNode: (selection: ExplorerSelection) => void;
  /** Full-screen permalink for the focused run, or null outside a workspace. */
  expandTo: string | null;
}) {
  const { attach, size } = useElementSize();

  // Memoised on the identities the render actually depends on: the tree objects
  // only swap when their rows changed, so a poll that changed nothing does not
  // rebuild the scene. A fresh array here would redraw every tree per poll.
  // The band's note is the settle line only: the dispatch parameters laid across
  // every band are a sentence of numbers over the tree they describe. They are
  // still what tells two runs of the same task apart, so the bar below states
  // them for the FOCUSED fork — one fork at a time, where there is room.
  const regions = useMemo(
    () => runs.flatMap((run) => {
      const root = trees.get(run.id);
      return root
        ? [{ runId: run.id, root, title: run.task, note: describeSettle(run, params.get(run.id)) }]
        : [];
    }),
    [runs, trees, params],
  );

  const paramRows = forkParamRows(params.get(focusedId));
  const empty = regions.length === 0;

  return (
    <div className="h-full min-h-0 flex flex-col rounded-lg border p-border p-surface overflow-hidden">
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b p-border">
        <span className="text-[10px] uppercase tracking-normal p-text-3">
          {regions.length === 1 ? "1 fork" : `${regions.length} forks`}
        </span>
        <span className="text-[10px] p-text-3 truncate">
          {runs.find((run) => run.id === focusedId)?.task ?? ""}
        </span>
        {paramRows.length > 0 && (
          <div className="hidden @xl:flex items-center gap-x-3 shrink-0 text-[10px] p-text-3 font-mono">
            {paramRows.map((row) => (
              <span key={row.label}>{row.label} <span className="p-text-2">{row.value}</span></span>
            ))}
          </div>
        )}
        {expandTo && (
          <Link to={expandTo} title="Open the selected fork full-screen"
            className="ml-auto shrink-0 flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md p-text-3 hover:p-text transition-colors">
            <ArrowsOutIcon size={11} />Expand
          </Link>
        )}
      </div>
      {/* The graph gets the entire remaining height of the column — the whole
          point of one canvas — and measures the element that is actually
          mounted. */}
      <div ref={attach} className="flex-1 min-h-0 relative">
        {empty ? (
          <div className="h-full flex items-center justify-center px-6 text-center text-[11px] p-text-3">
            No branches were ever written for these runs. They stopped before the first one landed.
          </div>
        ) : size.w > 0 && size.h > 0 ? (
          <ForkTree
            regions={regions} width={size.w} height={size.h}
            selectedRunId={focusedId} selection={selection}
            onSelectRun={onFocus}
            onSelectNode={onSelectNode}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-[11px] p-text-3">Sizing canvas…</div>
        )}
      </div>
    </div>
  );
}
