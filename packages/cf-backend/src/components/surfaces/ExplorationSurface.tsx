/**
 * Exploration — every time the agent tried more than one path.
 *
 * ONE list and ONE tree, not a tab per mechanism. The old surface split MCTS
 * from Branches, which mirrored a storage split: a search writes `search_nodes`
 * for its tree and `head_journal` for each node's transcript. Exploring
 * alternatives therefore landed in a different tab depending on which store a
 * run happened to fill, and the owner twice found an empty pane where his
 * searches should have been.
 *
 * The unification is honest because a run IS a tree either way: one level with a
 * branch per candidate is that tree at depth 1, and a deeper search is the same
 * tree with more levels and scores on it. A run carries both halves at once, so
 * the two facts a row reports are `hasSearchTree` and `hasNodeTranscripts`
 * rather than one tag admitting one store. Master-detail rather than
 * latest-versus-past tabs: every search the workspace ever ran is a row, newest
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
import { SwarmTree, naturalCanvasHeight } from "@/components/swarm-tree";
import { NodeTranscript } from "@/components/NodeTranscript";
import { type ExplorerSelection } from "@/components/swarm-tree-model";
import { buildTree, type MctsRow } from "@/lib/fork-tree-rows";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ScrollBoundary } from "@/components/ui/ScrollBoundary";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useElementSize } from "@/hooks/use-element-size";
import { EmptyState, EMPTY_HINTS, formatScore } from "./shared";
import {
  forkParamRows, FORK_REVALIDATE_MS, headRunToTree, judgeEnsembleLabel, settlePolicyOf,
  useExplorationCanvas,
} from "./fork-runs";
import {
  fanInVertices, nodeRationales, runRefusal, swarmAxisRows, swarmResolutionOf,
  type RunRefusal, type SwarmAxis, type SwarmResolution,
} from "./swarm-resolution";

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
    resource, reload, runs, params, trees, journals, resolutions,
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
              resolution={resolutions.get(run.id)}
              refusal={runRefusal(run, journals.get(run.id) ?? null)}
              selected={focused.id === run.id}
              onSelect={() => { setSelection(null); setFocusedRunId(run.id); }} />
          ))}
          <ScrollBoundary what="forks" count={runs.length}
            loading={loadingMore} exhausted={exhausted} error={pageError} onRetry={loadMore} />
        </div>
        <div className={`min-h-0 ${selection === null ? "" : "hidden @6xl:block"}`}>
          <ForkCanvas
            runs={runs} params={params} trees={trees} journals={journals} resolutions={resolutions}
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
 * What the run WAS and what became of its candidates, in that order.
 *
 * The resolution leads where the store recorded one, and the resolution is the preset the
 * run resolved plus the `settle` its axes DERIVED — `settleOf(config)`, the same
 * total function the engine reads. That is a different and better fact than the
 * dispatch policy: `settle` is not an axis and not a choice, so a run under a
 * named preset can be described by what it must have reported rather than by
 * which of two internal strategies wrote its rows.
 *
 * Without a resolution it falls back to the half the run leads with, which is all a
 * legacy search left behind. The row used to say `merged`/`competed` — the two
 * settlements of a verb that no longer exists — so two runs dispatched differently
 * were indistinguishable until one of them happened to have a winner, and a run that
 * never settled read as "merged" with nothing merged.
 */
export function describeSettle(
  run: ForkRunSummary, params?: ForkRunParams, resolution?: SwarmResolution,
): string {
  const branches = `${run.branches} branch${run.branches === 1 ? "" : "es"}`;

  const winner = run.winnerScore === null ? "" : ` · winner ${formatScore(run.winnerScore)}`;
  if (resolution === undefined) {
    return `settle=${settlePolicyOf(run, params)} · ${branches}${winner}`;
  }
  if (resolution.kind === "preset") {
    return `preset=${resolution.preset} · settle=${resolution.settle} · ${branches}${winner}`;
  }
  if (resolution.kind === "undeclared") {
    return `preset=${resolution.preset} (undeclared) · ${branches}${winner}`;
  }
  return `custom "${resolution.label}" · ${branches}${winner}`;
}

/** What became of the run, said as an outcome rather than as a settle policy —
 *  the distinction the old label collapsed. `partial` is the honest word for a
 *  run that stopped without an answer. */
const RUN_OUTCOME = {
  running: "running",
  completed: "settled",
  failed: "failed",
  partial: "stopped without an answer",
} satisfies Record<ForkRunSummary["status"], string>;

function ForkRunRow(
  { run, params, resolution, refusal, selected, onSelect }: {
    run: ForkRunSummary;
    params: ForkRunParams | undefined;
    resolution: SwarmResolution | undefined;
    refusal: RunRefusal | null;
    selected: boolean;
    onSelect: () => void;
  },
) {
  const judges = judgeEnsembleLabel(params);
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}
      data-fork-run={run.id}
      className={`w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 transition-colors ${selected ? "p-fill" : "p-card-hover"}`}>
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "animate-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] p-text-2 truncate" title={run.task}>{run.task}</div>
        <div className="text-[10px] p-text-3 tabular-nums">
          {describeSettle(run, params, resolution)} · {refusal === null ? RUN_OUTCOME[run.status] : refusal.reason}
        </div>
        {/* The clamp travels with the row, not only with the panel: a reader
            scanning the list is exactly the reader who has not opened the run
            whose ensemble was cut, and `requested` is the word that says so. */}
        {judges !== null && (
          <div className="text-[10px] p-text-3 tabular-nums font-mono" data-fork-judges={run.id}>
            judges {judges}
          </div>
        )}
        <div className="text-[10px] p-text-3 tabular-nums">
          {new Date(run.startedAt).toLocaleString()}
        </div>
      </div>
    </button>
  );
}

/* ── one run: its tree, and whatever the selected branch actually was ── */

/**
 * One run's per-node journal — why each node exists, what it reported, and how far
 * it got.
 *
 * Asked for EVERY run that HAS one, never for one settle tag. An agent-unit search
 * writes `search_nodes` for the tree AND `head_journal` for each node's own agent
 * run, so a tag that admits one store per run could not say whether this read has an
 * answer — the run's own `hasNodeTranscripts` can, and a run with none is spared the
 * request rather than answered null by the server. It is also the only record of
 * which nodes fanned a level in and of the preset the run resolved, so skipping it
 * for a search is what left both invisible.
 */
export function useForkRunDetail(run: ForkRunSummary, rpc: Rpc, hasActiveWork: boolean) {
  const load = useCallback(
    () => run.hasNodeTranscripts
      ? rpc<HeadRunView | null>("getHeadRun", [run.id])
      : Promise.resolve<HeadRunView | null>(null),
    [rpc, run.id, run.hasNodeTranscripts],
  );
  const revalidate = useCallback(
    () => (run.status === "running" || hasActiveWork ? FORK_REVALIDATE_MS : null),
    [run.status, hasActiveWork],
  );
  const { resource, reload } = useAsyncResource<HeadRunView | null>(
    load, revalidate, `journal:${run.id}`,
  );
  return { headRun: lastValue(resource) ?? null, resource, reload };
}

/**
 * One run's tree and its resolution — the single-run drill-down.
 *
 * A search in flight is served by the broadcast tree instead of a fetch: the
 * engine pushes a tree per iteration, and polling for that would be both slower
 * and noisier. The canvas does not use this — it has every tree from one
 * projection.
 *
 * The search rows ARE the tree wherever there are any; the journal's depth-1
 * projection stands in only where there are none. Choosing between them by a
 * settle tag drew an agent-unit search as a flat wave of every node it ever
 * expanded, at one depth, because the journal carries no parent edge a client can
 * read.
 */
export function useForkRunTree(
  run: ForkRunSummary, rpc: Rpc, liveTree: ForkNode | null, hasActiveWork: boolean,
) {
  const detail = useForkRunDetail(run, rpc, hasActiveWork);
  const load = useCallback(
    () => run.hasSearchTree
      ? rpc<MctsRow[]>("getSearchTree", [run.id])
      : Promise.resolve<MctsRow[]>([]),
    [rpc, run.id, run.hasSearchTree],
  );
  const revalidate = useCallback(
    () => (run.status === "running" || hasActiveWork ? FORK_REVALIDATE_MS : null),
    [run.status, hasActiveWork],
  );
  const { resource, reload } = useAsyncResource(load, revalidate, `search:${run.id}`);
  const rows = lastValue(resource);
  // The run's own fact, not the arrival of rows: a search still being written has a
  // tree the reader must wait for rather than a journal to fall back to.
  const searched = run.hasSearchTree;
  const fetched = searched
    ? (rows && rows.length > 0 ? buildTree(rows) : null)
    : (detail.headRun ? headRunToTree(detail.headRun) : null);
  return {
    tree: liveTree ?? fetched,
    headRun: detail.headRun,
    // Only a SEARCH writes both stores, and `head_runs.rationale` means two
    // different things depending on which kind of run wrote it — a search's
    // preset-or-label, or a pre-swarm split's prose "why". Holding both halves is
    // the discriminator; see the note on `resolutions` in ./fork-runs.
    resolution: searched ? swarmResolutionOf(detail.headRun?.rationale) ?? undefined : undefined,
    fanIn: fanInVertices(detail.headRun),
    why: nodeRationales(detail.headRun),
    refusal: runRefusal(run, detail.headRun),
    // The tree read is what a reader is waiting on, so its failure is the one
    // reported. A journal that failed beside a tree that arrived costs the fan-in
    // marks and nothing else, and reporting it would hide the picture over a
    // caption.
    resource: searched ? resource : detail.resource,
    reload: searched ? reload : detail.reload,
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

/** The canvas card's hairline, top and bottom — the difference between the box
 *  the column measures and the box the graph is laid out in. */
const CARD_BORDER = 2;

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
  runs, params, trees, journals, resolutions, focusedId, selection, onFocus, onSelectNode, expandTo,
}: {
  runs: readonly ForkRunSummary[];
  params: ReadonlyMap<string, ForkRunParams>;
  trees: ReadonlyMap<string, ForkNode>;
  /** Per-run node journals — what makes a fan-in vertex visible in the picture. */
  journals: ReadonlyMap<string, HeadRunView>;
  resolutions: ReadonlyMap<string, SwarmResolution>;
  focusedId: string;
  selection: ExplorerSelection | null;
  onFocus: (runId: string) => void;
  onSelectNode: (selection: ExplorerSelection) => void;
  /** Full-screen permalink for the focused run, or null outside a workspace. */
  expandTo: string | null;
}) {
  /** Three measurements, each of a box that cannot be the one it constrains.
   *  `cell` is the column's whole height and never shrinks, so it is a stable
   *  budget; `chrome` is the header stack above the graph; `size` is the graph
   *  box, read for its WIDTH only — its height is set here, so measuring it for
   *  height would be a loop that could only ever ratchet down. */
  const { attach: attachCell, size: cell } = useElementSize();
  const { attach: attachChrome, size: chrome } = useElementSize();
  const { attach, size } = useElementSize();

  // Memoised on the identities the render actually depends on: the tree objects
  // only swap when their rows changed, so a poll that changed nothing does not
  // rebuild the scene. A fresh array here would redraw every tree per poll.
  // The band's note is the resolution line only: the dispatch parameters laid across
  // every band are a sentence of numbers over the tree they describe. They are
  // still what tells two runs of the same task apart, so the bar below states
  // them for the FOCUSED run — one run at a time, where there is room.
  const regions = useMemo(
    () => runs.flatMap((run) => {
      const root = trees.get(run.id);
      if (!root) return [];
      const journal = journals.get(run.id) ?? null;
      return [{
        runId: run.id, root, title: run.task,
        note: describeSettle(run, params.get(run.id), resolutions.get(run.id)),
        fanIn: fanInVertices(journal),
        why: nodeRationales(journal),
      }];
    }),
    [runs, trees, params, journals, resolutions],
  );

  const focused = runs.find((run) => run.id === focusedId) ?? null;
  const focusedResolution = resolutions.get(focusedId);
  const paramRows = forkParamRows(params.get(focusedId));
  const refusal = focused === null ? null : runRefusal(focused, journals.get(focusedId) ?? null);
  /** What the searches WANT, measured off the same layout the canvas draws with
   *  — never a second stacking rule that could disagree with it. Null where
   *  there is no tree to want anything: the box then holds a sentence, and a
   *  sentence is centred in the room it is given. */
  const natural = useMemo(
    () => (regions.length === 0 ? null : naturalCanvasHeight(regions)),
    [regions],
  );
  /** The column's remaining height, capped at that. Zero until the cell has
   *  been measured, which the graph box below renders as "sizing" rather than
   *  as an empty canvas.
   *
   *  The card's own hairline is subtracted because `cell` is measured OUTSIDE
   *  it and the graph is laid out inside: without it the graph is two pixels
   *  taller than the card can hold and `overflow-hidden` takes them off the
   *  bottom of the key. */
  const budget = Math.max(0, cell.h - CARD_BORDER - chrome.h);
  const canvasH = natural === null ? budget : Math.min(budget, natural);

  return (
    // Two boxes, not one. The outer is the column's whole height and is what
    // the canvas budget is measured against; the card inside HUGS what it
    // holds, so a workspace of short searches no longer draws a bordered box
    // with several hundred pixels of nothing under its trees.
    <div ref={attachCell} className="h-full min-h-0">
      <div className="flex max-h-full flex-col rounded-lg border p-border p-surface overflow-hidden">
        <div ref={attachChrome} className="shrink-0">
          {/* The header WRAPS as a group. Every part of it was on one line with a
              single truncating title between fixed neighbours, so at a 313px
              column the count label broke over two lines, the parameters were
              hidden outright below `@xl`, and the task was cut mid-word with the
              rest of it nowhere. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 border-b p-border">
            <span className="shrink-0 whitespace-nowrap text-[10px] uppercase tracking-normal p-text-3">
              {regions.length === 1 ? "1 search" : `${regions.length} searches`}
            </span>
            <span className="min-w-0 flex-1 truncate text-[10px] p-text-3" title={focused?.task ?? ""}>
              {focused?.task ?? ""}
            </span>
            {expandTo && (
              <Link to={expandTo} title="Open the selected search full-screen"
                className="shrink-0 flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md p-text-3 hover:p-text transition-colors">
                <ArrowsOutIcon size={11} />Expand
              </Link>
            )}
            {/* The dispatch parameters, wrapping with the rest rather than
                disappearing below a container width. They are the only thing on
                this row that tells two runs of the same task apart, so hiding
                them narrow was hiding the answer on the surface most likely to
                be read narrow. */}
            {paramRows.length > 0 && (
              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] p-text-3 font-mono @xl:w-auto">
                {paramRows.map((row) => (
                  <span key={row.label} className="whitespace-nowrap">
                    {row.label} <span className="p-text-2">{row.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          {/* The resolution the focused run resolved, above the tree it produced. Its own
              row rather than another clause in the header's sentence: six axes and a
              derived settle do not fit beside a task title, and a reader comparing two
              runs of one task is reading exactly this. */}
          <SwarmResolutionPanel resolution={focusedResolution} judges={judgeEnsembleLabel(params.get(focusedId))} />
          {/* A run that reached nothing says so HERE, above its own band, and the canvas
              below keeps every band it had. Replacing the canvas would hide the other
              searches because one of them was refused, and the whole point of one canvas
              is that the comparison stays on screen. */}
          {refusal !== null && <RunRefusalNote refusal={refusal} />}
        </div>
        {/* The graph gets every pixel the searches can USE and no more: the
            column's remaining height, capped at what the scene wants at 1:1.
            `flex-1` alone gave a three-node merge the whole column, which is the
            fixed-height-card defect from the other direction. */}
        <div ref={attach} className="relative shrink-0 min-h-0" style={{ height: canvasH }}>
          {regions.length === 0 ? (
            <div className="h-full flex items-center justify-center px-6 text-center text-[11px] p-text-3">
              No branch was ever written for these searches. Each stopped before its first
              expansion landed.
            </div>
          ) : size.w > 0 && canvasH > 0 ? (
            <SwarmTree
              regions={regions} width={size.w} height={canvasH}
              selectedRunId={focusedId} selection={selection}
              onSelectRun={onFocus}
              onSelectNode={onSelectNode}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-[11px] p-text-3">Sizing canvas…</div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The resolution a run resolved: which preset, and the tuple that preset resolved TO.
 *
 * The tuple and not the name alone. `resolve(preset) → SwarmConfig` is a table, and
 * the same name resolving differently is precisely what a reader needs to see — so
 * the six axes are printed beside the name, each carrying the parameter that
 * belongs to its value, and `settle` beside them is DERIVED from two of those axes
 * rather than chosen.
 *
 * Three resolutions and three renderings. A preset that cannot be constructed as printed
 * says so and quotes what the table has not stated, because an empty axis list
 * would read as "unknown" when what is true is "undeclared". A composition reaches
 * the client as its provenance label alone — its resolved axes live in a records
 * digest with no read model — and the panel says that rather than leaving a reader
 * to assume the axes were the defaults.
 */
export function SwarmResolutionPanel(
  { resolution, judges = null }: { resolution: SwarmResolution | undefined; judges?: string | null },
) {
  if (resolution === undefined) return null;
  const caps = resolution.kind === "preset"
    ? `depth ${resolution.depth} · branches ${resolution.branches}`
    : null;
  return (
    <div data-swarm-resolution={resolution.kind}
      className="shrink-0 border-b p-border px-3 py-2">
      {/* One line naming the run, and ONE accent on it. Everything else in this
          panel is a fact about the tuple; the name is the thing a reader is
          looking for, so it is the only thing coloured. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[9px] uppercase tracking-wider p-text-3 shrink-0">
          {resolution.kind === "custom" ? "composition" : "preset"}
        </span>
        <span className="font-mono text-[11px] font-medium p-accent-fg min-w-0 break-words">
          {resolution.kind === "custom" ? resolution.label : resolution.preset}
        </span>
        {resolution.kind === "preset" && (
          <span className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] p-badge-neutral"
            title="Derived from the score and advance axes rather than chosen — settleOf(config), the same total function the engine reads.">
              settle {resolution.settle}
          </span>
        )}
      </div>

      {/* THE TUPLE, as a tuple. Six `axis:value` chips in one wrapping sentence
          read as a run of mono text at any width and as a wall of it at 313px,
          which is the crowding the owner named. A grid of labelled cells fitted
          to the available width — no breakpoint, `auto-fit` decides — gives every
          axis its own column, so a value has room to WRAP rather than truncate
          and no axis is ever the one that got hidden. */}
      {resolution.kind === "preset" && (
        <dl className="mt-1.5 grid gap-x-3 gap-y-1.5 [grid-template-columns:repeat(auto-fit,minmax(5.25rem,1fr))]">
          {swarmAxisRows(resolution.config).map((row) => (
            <div key={row.axis} className="min-w-0" title={`${row.axis} — ${AXIS_MEANING[row.axis]}`}>
              <dt className="text-[9px] uppercase tracking-wider p-text-3">{row.axis}</dt>
              <dd className="font-mono text-[11px] p-text break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {resolution.kind === "undeclared" && (
        <p className="mt-1.5 text-[10px] p-warning leading-snug">
          This preset does not resolve, so the run has no axis tuple to show — {resolution.undeclared}.
        </p>
      )}
      {resolution.kind === "custom" && (
        <p className="mt-1.5 text-[10px] p-text-3 leading-snug">
          A composition's resolved axes are digested into its records row, which has no
          read model, so only the provenance label reached this surface.
        </p>
      )}

      {(caps !== null || judges !== null) && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[10px] p-text-3">
          {caps !== null && (
            <span className="whitespace-nowrap" title="The caps the preset resolved, not the caps this run spent.">
              caps <span className="p-text-2">{caps}</span>
            </span>
          )}
          {judges !== null && (
            <span className="whitespace-nowrap" data-swarm-judges>
              judges <span className="p-text-2">{judges}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What each axis DECIDES, one line each, quoted from the declarations in
 * `core/src/strategy/swarm.ts` rather than paraphrased here — the panel is the
 * only place a first-time reader meets these six words, and a gloss that drifts
 * from the axis it names is worse than none.
 */
const AXIS_MEANING = {
  unit: "what one node produces",
  context: "what a child starts from",
  expand: "how children are produced — `aggregate` is fan-in, k parents into one child",
  score: "how a node is valued",
  advance: "where the next unit of budget goes",
  carry: "what survives across iterations",
} as const satisfies Record<SwarmAxis, string>;

/**
 * A run that reached nothing, said as a refusal rather than left to a picture of
 * nothing.
 *
 * Reason first — the vocabulary every refusal in this tree carries, so a reader
 * branches on the class rather than parsing the prose — then the cause, which is a
 * branch's own error message wherever one recorded it.
 *
 * A BANNER above the tree, never a replacement for it, and that is the whole of the
 * design decision here. A refused run still has a root, and often has branches that
 * failed for a reason worth reading; swapping the canvas for a card would hide them,
 * and on the shared canvas it would hide every OTHER search because one of them was
 * refused. What the banner fixes is the actual defect: a one-dot canvas under a
 * settled-looking label, which reads as "the search found nothing" and is a claim
 * about the world rather than about this run.
 */
export function RunRefusalNote({ refusal }: { refusal: RunRefusal }) {
  return (
    <div data-run-refusal={refusal.reason}
      className="shrink-0 flex items-baseline gap-2 px-3 py-1.5 border-b p-border text-[10px]">
      <span aria-hidden className="mt-1 size-1.5 rounded-full p-dot-danger shrink-0" />
      <span className="font-mono p-danger shrink-0">{refusal.reason}</span>
      <span className="p-text-2 leading-snug min-w-0">{refusal.error}</span>
    </div>
  );
}
