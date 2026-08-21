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
import {
  GitForkIcon, TreeStructureIcon, ArrowsOutIcon, ArrowLeftIcon, CaretRightIcon, CaretDownIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ForkRunParams, ForkRunSummary, HeadRunView } from "@kinu.run/core";
import { SwarmTree, naturalCanvasHeight } from "@/components/swarm-tree";
import { NodeTranscript } from "@/components/NodeTranscript";
import { cleanNodeLabel, type ExplorerSelection } from "@/components/swarm-tree-model";
import { explorationForkTree, type MctsRow } from "@/lib/fork-tree-rows";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ScrollBoundary } from "@/components/ui/ScrollBoundary";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useElementSize } from "@/hooks/use-element-size";
import { EmptyState, EMPTY_HINTS, formatScore, timeAgo } from "./shared";
import {
  forkParamRows, FORK_REVALIDATE_MS, judgeEnsembleLabel,
  useExplorationCanvas, type ForkParamRow,
} from "./fork-runs";
import {
  fanInVertices, nodeRationales, runLiveness, runRefusal, swarmAxisRows, swarmResolutionOf,
  type RunLevel, type RunLiveness, type RunRefusal, type SwarmAxis, type SwarmResolution,
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
  /**
   * What the detail pane is showing: a run, and optionally one node inside it.
   *
   * Null means "nothing opened yet", which is not the same as "no run": the pane
   * falls back to the focused run, so it always describes something. Null still
   * matters below `@6xl`, where the pane takes the canvas's place and must not
   * do so until the reader asked for it.
   *
   * A NODE is a field of this rather than a state beside it because a branch is
   * read inside the run it belongs to — the run's own liveness is the context
   * that makes one branch's trace mean anything.
   */
  const [inspect, setInspect] = useState<{ runId: string; nodeId: string | null } | null>(null);

  const {
    resource, reload, runs, params, trees, journals, resolutions,
    exhausted, loadingMore, pageError, loadMore,
  } = useExplorationCanvas(rpc, isStreaming, backgroundJobs, liveTrees, headActivity);
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
  /**
   * What the detail pane is showing. The focused run wherever nothing has been
   * opened, so the pane is never empty and choosing a run from the list always
   * changes it — which is the whole of the "clicking a run does nothing"
   * report: focusing a band that was already focused was the click's ONLY
   * effect, and on a workspace with one search that is no effect at all.
   */
  const inspecting = inspect ?? { runId: focused.id, nodeId: null };
  const opened = runs.find((run) => run.id === inspecting.runId) ?? focused;

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 animate-fade-in">
      {resource.status === "error" && (
        <LoadFailure what="fresh fork runs" message={resource.message} onRetry={reload} />
      )}
      {/* Three panes once there is room for them: the runs, the canvas, the run
          under inspection. The canvas takes the whole height of its column and
          every spare pixel of width, which is the proportion the tree needs and
          the one a stack of fixed-height cards could never give it.

          Narrower than that, three columns would leave the tree ~200px, so the
          detail pane takes the canvas's place while it is open — and stacked
          narrowest of all, the list is content-height (capped, then it scrolls)
          so it cannot stretch into dead space above the canvas. */}
      <div className="flex-1 min-h-0 grid gap-3 grid-rows-[auto_minmax(0,1fr)] @3xl:grid-rows-1 @3xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] @6xl:grid-cols-[minmax(200px,250px)_minmax(0,1fr)_minmax(330px,400px)]">
        <div ref={listRef}
          className="min-h-0 max-h-44 @3xl:max-h-none overflow-y-auto rounded-lg border p-border p-surface p-1.5 space-y-0.5">
          {runs.map((run) => (
            <ForkRunRow key={run.id} run={run}
              liveness={runLiveness(journals.get(run.id) ?? null)}
              refusal={runRefusal(run, journals.get(run.id) ?? null)}
              selected={focused.id === run.id}
              onSelect={() => { setFocusedRunId(run.id); setInspect({ runId: run.id, nodeId: null }); }} />
          ))}
          <ScrollBoundary what="forks" count={runs.length}
            loading={loadingMore} exhausted={exhausted} error={pageError} onRetry={loadMore} />
        </div>
        <div className={`min-h-0 ${inspect === null ? "" : "hidden @6xl:block"}`}>
          <ForkCanvas
            runs={runs} params={params} trees={trees} journals={journals} resolutions={resolutions}
            focusedId={focused.id} selection={inspect?.nodeId == null ? null : { runId: inspect.runId, nodeId: inspect.nodeId }}
            activity={headActivity}
            onFocus={(runId) => { setFocusedRunId(runId); setInspect({ runId, nodeId: null }); }}
            onSelectNode={(next) => { setFocusedRunId(next.runId); setInspect(next); }}
            expandTo={agentId ? `/mcts/${agentId}?run=${encodeURIComponent(focused.id)}` : null}
          />
        </div>
        <div className={`min-h-0 ${inspect === null ? "hidden @6xl:block" : ""}`}>
          <RunDetailView
            run={opened}
            params={params.get(opened.id)}
            resolution={resolutions.get(opened.id)}
            journal={journals.get(opened.id) ?? null}
            tree={trees.get(opened.id) ?? null}
            branchId={inspecting.nodeId}
            trees={trees} rpc={rpc} headActivity={headActivity}
            onOpenBranch={(nodeId) => setInspect({ runId: opened.id, nodeId })}
            onClose={() => setInspect(null)}
          />
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

/** What became of the run, said as an outcome rather than as a settle policy —
 *  the distinction the old label collapsed. `partial` is the honest word for a
 *  run that stopped without an answer. */
const RUN_OUTCOME = {
  running: "running",
  completed: "settled",
  failed: "failed",
  partial: "stopped without an answer",
} satisfies Record<ForkRunSummary["status"], string>;

/**
 * What the run is DOING, in one line.
 *
 * The one sentence the run list, the detail pane and the band caption all say, so
 * they cannot come to disagree about a run three surfaces are describing at once.
 *
 * It replaced `describeSettle`, which said what the run was CONFIGURED as:
 * `preset=ideate · settle=merge · 0 branches`, on the row, over the canvas and on
 * every band. That was the sentence the owner's *"User doesnt have to be shoved
 * all these stuff into their faces"* was about, and none of it answered the
 * question a reader of this surface actually has. The resolution is still one
 * click away in {@link SwarmConfigDisclosure}; what leads is the state.
 *
 * A refusal's REASON leads where there is one, because a run that reached nothing
 * has no state worth stating before its cause.
 */
export function runStateLine(
  run: ForkRunSummary, liveness: RunLiveness | null, refusal: RunRefusal | null,
): string {
  const parts = [refusal === null ? RUN_OUTCOME[run.status] : refusal.reason];
  if (liveness !== null) parts.push(nodeTally(liveness));
  if (run.winnerScore !== null) parts.push(`winner ${formatScore(run.winnerScore)}`);
  return parts.join(" · ");
}

/**
 * One run, as a row.
 *
 * What it says is what became of the run and what its nodes are doing — and
 * NOTHING about how it was dispatched. The row used to lead with
 * `preset=ideate · settle=merge · 0 branches`, and the owner's ruling on that is
 * the reason this file changed: *"User doesnt have to be shoved all these stuff
 * into their faces. They can maybe look at the config IF they want to."* The
 * resolution and the axes now live behind the disclosure on the selected run,
 * where a reader who wants them can ask.
 *
 * A running run leads with its liveness, because "running" on its own is the
 * label the owner read as dead six times. A settled one leads with its outcome.
 */
function ForkRunRow(
  { run, liveness, refusal, selected, onSelect }: {
    run: ForkRunSummary;
    liveness: RunLiveness | null;
    refusal: RunRefusal | null;
    selected: boolean;
    onSelect: () => void;
  },
) {
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}
      data-fork-run={run.id}
      className={`w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 transition-colors ${selected ? "p-fill" : "p-card-hover"}`}>
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "animate-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] p-text-2 truncate" title={run.task}>{run.task}</div>
        <div className="text-[10px] p-text-3 tabular-nums truncate"
          title={refusal === null ? undefined : refusal.error}>
          {runStateLine(run, liveness, refusal)}
        </div>
        <div className="text-[10px] p-text-3 tabular-nums">
          {new Date(run.startedAt).toLocaleString()}
        </div>
      </div>
    </button>
  );
}

/**
 * The nodes, counted by what they are doing. One phrase, and only the parts that
 * are non-zero: `5 running · 2 reported` on a live search, `8 reported` on a
 * settled one. A tally of zeroes would assert that nodes exist and are idle,
 * which is the false reading the owner was given.
 *
 * Takes the counts and not the whole liveness, so a LEVEL is tallied by the same
 * function as a run. Two sentences for the same four numbers is how "5 running"
 * at the top comes to disagree with the levels under it.
 */
function nodeTally(counted: Pick<RunLiveness, "running" | "reported" | "failed" | "total">): string {
  const parts: string[] = [];
  if (counted.running > 0) parts.push(`${counted.running} running`);
  if (counted.reported > 0) parts.push(`${counted.reported} reported`);
  if (counted.failed > 0) parts.push(`${counted.failed} stopped`);
  return parts.length === 0 ? `${counted.total} nodes` : parts.join(" · ");
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
 * BOTH halves fold, through the one fold the canvas uses. Choosing between them
 * — search rows if there are any, the journal only if there are none — drew a
 * running swarm as its root alone: the root's tree row lands at dispatch, so
 * "there are search rows" is true from the first millisecond and every node
 * still working was in the half that was never read.
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
  // Which half a reader is WAITING on, and the resolution's discriminator. Not
  // which half the tree is folded from — both are.
  const searched = run.hasSearchTree;
  const fetched = explorationForkTree({ tree: rows ?? [], head: detail.headRun });
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

/* ── one RUN, opened ───────────────────────────────────────────── */

/**
 * A run, opened.
 *
 * The owner's report on what this slot used to be: *"this section — does it only
 * show the node? WHY? It should show everything about a particular run in detail
 * including it's live branches being updated live."* It showed nothing at all
 * until a node was clicked on the canvas, and then it showed one node.
 *
 * So the pane is the RUN: its objective, what its nodes are doing right now,
 * every report that landed, and its configuration behind a disclosure. A branch
 * opens INSIDE it — {@link ForkBranchView} nested rather than swapped in —
 * because a branch's trace only means something beside the run's own state, and
 * leaving the run to read a node is what made the surface a node viewer.
 *
 * Everything it renders comes from the page's one read: `head` is the journal,
 * which is the only store that holds a node that has not reported, and `tree` is
 * the folded tree, which is where a node's score lives.
 */
function RunDetailView({
  run, params, resolution, journal, tree, branchId, trees, rpc, headActivity, onOpenBranch, onClose,
}: {
  run: ForkRunSummary;
  params: ForkRunParams | undefined;
  resolution: SwarmResolution | undefined;
  journal: HeadRunView | null;
  tree: ForkNode | null;
  /** The branch open inside this run, or null for the run itself. */
  branchId: string | null;
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  onOpenBranch: (branchId: string | null) => void;
  /** Give the column back to the canvas. Only reachable below `@6xl`, where the
   *  pane took the canvas's place; wider, the two are side by side and there is
   *  nothing to give back. */
  onClose: () => void;
}) {
  const liveness = runLiveness(journal);
  const refusal = runRefusal(run, journal);
  return (
    <div className="h-full min-h-0 flex flex-col rounded-lg border p-border p-surface overflow-hidden">
      <div className="shrink-0 flex items-start gap-2 border-b p-border px-3 py-2">
        <span className={`mt-1.5 size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "animate-pulse" : ""}`} />
        <div className="min-w-0 flex-1">
          <RunObjective task={run.task} />
          <div className="mt-0.5 text-[10px] p-text-3 tabular-nums">
            {/* The tally is stated in the liveness panel below, so the header
                carries the outcome and the winner only — one number in two places
                is how a surface starts contradicting itself. */}
            {runStateLine(run, null, refusal)}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Back to the canvas"
          title="Back to the canvas" className="shrink-0 @6xl:hidden">
          <XIcon size={12} />
        </Button>
      </div>
      {refusal !== null && <RunRefusalNote refusal={refusal} />}
      {liveness !== null && <RunLivenessPanel live={liveness} running={run.status === "running"} />}
      <div className="shrink-0 border-b p-border px-3 py-1.5">
        <SwarmConfigDisclosure resolution={resolution}
          paramRows={forkParamRows(params)} judges={judgeEnsembleLabel(params)} />
      </div>
      {branchId === null
        ? <RunNodeList journal={journal} tree={tree} activity={headActivity} onOpen={onOpenBranch} />
        : <ForkBranchView run={run} branchId={branchId} trees={trees} rpc={rpc}
            headActivity={headActivity} nodeCount={journal?.heads.length ?? run.branches}
            onBack={() => onOpenBranch(null)} onOpenBranch={onOpenBranch} />}
    </div>
  );
}

/** How much objective reads as a heading rather than as a wall. Matched to
 *  `NodeTranscript`'s own clamp, because they are the same kind of text in the
 *  same column and two different thresholds would read as a bug. */
const OBJECTIVE_CLAMP = 240;

/** The run's objective, pinned and expandable — the same treatment a node's task
 *  gets, for the same reason: it is a paragraph often enough that clamping it is
 *  right, and the thing every other fact in the pane is about. */
function RunObjective({ task }: { task: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = task.length > OBJECTIVE_CLAMP;
  return (
    <>
      <div className={`text-[11px] p-text-2 leading-relaxed break-words ${long && !expanded ? "line-clamp-2" : ""}`}>
        {task}
      </div>
      {long && (
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
          className="mt-0.5 inline-flex items-center gap-1 text-[10px] p-text-3 hover:p-text transition-colors cursor-pointer">
          {expanded ? <CaretDownIcon size={9} /> : <CaretRightIcon size={9} />}
          {expanded ? "Show less" : `Show all ${task.length} characters`}
        </button>
      )}
    </>
  );
}

/**
 * Is it alive, and where is the work.
 *
 * The one thing a running search could not say about itself. `runRefusal` is null
 * while a run is running — correctly — so the surface's whole vocabulary for a
 * live run was the word `running` and a picture, which the owner read as dead on
 * six separate occasions.
 *
 * Level by level, from the journal's own depth, because "5 running" over a
 * depth-3 search does not say which level is moving. The newest event is the
 * number that actually answers "is it alive": a run whose last step was four
 * seconds ago is working whatever its status column says, and one whose last step
 * was an hour ago is not.
 */
export function RunLivenessPanel({ live, running }: { live: RunLiveness; running: boolean }) {
  return (
    <div data-run-liveness className="shrink-0 border-b p-border px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[10px] tabular-nums">
        <span className="p-text-2">{nodeTally(live)}</span>
        <span className="p-text-3">
          {running ? "last step " : "last activity "}{timeAgo(live.lastEventAt)}
        </span>
      </div>
      {/* One line per level, and only when there is more than one: a flat search
          says everything it has to say in the tally above, and a second row
          repeating it is the clutter this surface is being cleared of. */}
      {live.levels.length > 1 && (
        <div className="mt-1 space-y-0.5">
          {live.levels.map((level) => <RunLevelRow key={level.depth} level={level} />)}
        </div>
      )}
    </div>
  );
}

function RunLevelRow({ level }: { level: RunLevel }) {
  return (
    <div className="flex items-baseline gap-2 text-[10px] tabular-nums">
      <span className="w-12 shrink-0 p-text-3">level {level.depth}</span>
      <span className="min-w-0 p-text-2">{nodeTally(level)}</span>
    </div>
  );
}

/**
 * Every node of the run, and what it is doing.
 *
 * The reachable list the canvas is not: a node is a dot on a graph there, and a
 * reader who wants to open the one that just reported has to find it. Newest
 * activity first, so the node that just moved is the node at the top.
 *
 * From the JOURNAL, never from the tree: the journal is the only store holding a
 * node that has not reported, and a list built from settled rows is the same
 * blindness that drew a running swarm as its root alone.
 */
function RunNodeList({ journal, tree, activity, onOpen }: {
  journal: HeadRunView | null;
  tree: ForkNode | null;
  activity: ReadonlyMap<string, number>;
  onOpen: (nodeId: string) => void;
}) {
  const scores = useMemo(() => nodeScores(tree), [tree]);
  const nodes = useMemo(
    () => [...(journal?.heads ?? [])].sort(
      (a, b) => (b.lastStepAt ?? b.spawnedAt) - (a.lastStepAt ?? a.spawnedAt),
    ),
    [journal],
  );
  if (nodes.length === 0) {
    return (
      <div className="min-h-0 flex-1 flex items-center justify-center p-4">
        <EmptyState icon={<TreeStructureIcon size={24} />} title="No node has been journalled yet"
          hint="Nodes appear here as the search spawns them, before any of them reports." />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5 space-y-0.5">
      {nodes.map((node) => (
        <RunNodeRow key={node.id} node={node} score={scores.get(node.id) ?? null}
          moving={activity.has(node.id)} onOpen={() => onOpen(node.id)} />
      ))}
    </div>
  );
}

/** Every scored node of the folded tree, by id. A node the journal has and the
 *  tree has not is a node still running, and it carries no score by design. */
function nodeScores(tree: ForkNode | null): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  const walk = (node: ForkNode): void => {
    if (node.value !== null) scores.set(node.id, node.value);
    for (const child of node.children) walk(child);
  };
  if (tree !== null) walk(tree);
  return scores;
}

function RunNodeRow({ node, score, moving, onOpen }: {
  node: HeadRunView["heads"][number];
  score: number | null;
  /** This node has written to its journal since the surface mounted — the
   *  `head_activity` push, the same signal the canvas pulses a node on. */
  moving: boolean;
  onOpen: () => void;
}) {
  const live = node.status === "running";
  return (
    <button type="button" onClick={onOpen} data-run-node={node.id}
      className="w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 p-card-hover transition-colors">
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${NODE_DOT(node.status)} ${live && moving ? "animate-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] p-text-2 truncate" title={node.task}>
          {cleanNodeLabel(node.task, node.id)}
        </div>
        <div className="text-[10px] p-text-3 tabular-nums truncate">
          {node.status}
          {score !== null && ` · ${formatScore(score)}`}
          {live
            ? ` · ${node.lastStepAt === null ? "no step yet" : `last step ${timeAgo(node.lastStepAt)}`}`
            : node.wallClockMs > 0 && ` · ${Math.round(node.wallClockMs / 1000)}s`}
        </div>
        {/* The finding, not a summary of the node. One line of it here and the
            whole of it in the transcript: this list is scanned for which node
            found something, and a node with a report but no visible trace of one
            is why the owner could not tell a working search from a dead one. */}
        {node.summary !== null && (
          <div className="mt-0.5 text-[10px] p-text-2 line-clamp-2 leading-snug">{node.summary}</div>
        )}
        {node.errorMessage !== null && (
          <div className="mt-0.5 text-[10px] p-danger line-clamp-2 leading-snug">{node.errorMessage}</div>
        )}
      </div>
    </button>
  );
}

/** A node's dot, over the journal's own vocabulary. `interrupted` is
 *  non-terminal and gets the quiet dot rather than a failure's. */
function NODE_DOT(status: string): string {
  if (status === "running") return "p-dot-warning";
  if (status === "completed") return "p-dot-success";
  if (status === "errored" || status === "aborted") return "p-dot-danger";
  return "p-dot-neutral";
}

/* ── one branch, opened inside its run ─────────────────────────── */

/**
 * A branch, opened.
 *
 * The owner's ask was for the chat, not a card: *"it should just be like a chat
 * view except there are no user inputs or user messages."* So the body is
 * {@link NodeTranscript}, which renders every step through the SAME
 * `MessageView` the main thread uses; what stays here is the way back to the run
 * it belongs to.
 *
 * The metadata card this replaced (a verdict grid, a clamped summary, and a step
 * list that truncated reasoning to three lines and tool output to 160
 * characters) could not answer "what did this branch actually do", which is the
 * whole reason a reader opens one.
 *
 * It closes back to the RUN, not to the canvas: the run is where the reader came
 * from and the frame this now sits inside, so the header says which run and the
 * control returns to it.
 */
function ForkBranchView({
  run, branchId, trees, rpc, headActivity, nodeCount, onBack, onOpenBranch,
}: {
  run: ForkRunSummary;
  branchId: string;
  /** Every drawn tree, keyed by run — the transcript names a node from it when
   *  the store has no record of that node at all. */
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  /** How many nodes the list behind this one holds. The JOURNAL's count, because
   *  `ForkRunSummary.branches` counts settled search rows: on a live run those
   *  disagree by every node still working, and "all 2 nodes" over a list of nine
   *  is the same kind of wrong number as the tree that drew two of them. */
  nodeCount: number;
  onBack: () => void;
  onOpenBranch: (branchId: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 flex flex-col">
      <div className="shrink-0 flex items-center gap-1 border-b p-border px-2 py-1">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] p-text-3 hover:p-text transition-colors cursor-pointer">
          <ArrowLeftIcon size={10} />all {nodeCount === 1 ? "1 node" : `${nodeCount} nodes`}
        </button>
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
  activity,
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
  /** Per-node journal write counters — what makes a working node visible IN THE
   *  PICTURE. This reached the branch panel and stopped there, so the canvas
   *  could not say which of a hundred nodes was moving. */
  activity: ReadonlyMap<string, number>;
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
  //
  // A band's caption says what its run is DOING — the same sentence the list and
  // the detail pane say. It used to carry the resolution and the branch count,
  // which put `preset=audit (undeclared) · 2 branches` across the top of every
  // tree on the canvas: config over a picture, on the surface whose whole
  // complaint was config over a picture. The resolution is in the disclosure.
  const regions = useMemo(
    () => runs.flatMap((run) => {
      const root = trees.get(run.id);
      if (!root) return [];
      const journal = journals.get(run.id) ?? null;
      return [{
        runId: run.id, root, title: run.task,
        note: runStateLine(run, runLiveness(journal), runRefusal(run, journal)),
        fanIn: fanInVertices(journal),
        why: nodeRationales(journal),
      }];
    }),
    [runs, trees, journals],
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
            {/* The dispatch parameters and the resolved axis tuple, BEHIND a
                disclosure. They were laid out over the canvas: a labelled grid
                of six axes, a caps line and a row of dispatch numbers, above
                every tree, always. The owner's ruling was that this is the
                user's face being shoved into, and that config is something a
                reader asks for. So the header keeps one chip naming the run —
                the one fact that tells two runs of the same task apart — and the
                rest opens. */}
            <SwarmConfigDisclosure resolution={focusedResolution}
              paramRows={paramRows} judges={judgeEnsembleLabel(params.get(focusedId))} />
          </div>
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
              {/* Said in the present tense for a search that is still going, because
                  the past tense is a false claim about it: "each stopped before its
                  first expansion landed" was printed over runs that were working,
                  which is the sentence the liveness panel replaces. */}
              {focused?.status === "running"
                ? "No branch has been written yet. The first expansion has not landed."
                : "No branch was ever written for these searches. Each stopped before its first expansion landed."}
            </div>
          ) : size.w > 0 && canvasH > 0 ? (
            <SwarmTree
              regions={regions} width={size.w} height={canvasH}
              selectedRunId={focusedId} selection={selection}
              activity={activity}
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
 * The run's configuration, ASKED FOR.
 *
 * The whole of what the exploration surface knows about how a run was dispatched
 * — the preset or composition it resolved, the six axes it resolved to, the caps,
 * the judge clamp and the dispatch parameters — behind one summary chip.
 *
 * It used to be unconditional chrome above every tree, and the owner's ruling on
 * that is quoted at {@link ForkRunRow}. The chip is not nothing, though: the
 * resolved name is the one fact that distinguishes two runs of the same task, so
 * it stays visible and only the tuple folds away.
 *
 * ONE component for both surfaces. The full-screen explorer had its own copy of
 * the always-open panel, which is how the same clutter reached the reader twice.
 */
export function SwarmConfigDisclosure(
  { resolution, paramRows = [], judges = null }: {
    resolution: SwarmResolution | undefined;
    paramRows?: readonly ForkParamRow[];
    judges?: string | null;
  },
) {
  if (resolution === undefined && paramRows.length === 0) return null;
  const name = resolution === undefined
    ? "config"
    : resolution.kind === "custom" ? resolution.label : resolution.preset;
  return (
    <details data-swarm-config className="group shrink-0 min-w-0">
      <summary
        className="flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] p-text-3 hover:p-text transition-colors [&::-webkit-details-marker]:hidden"
        title="The preset this run resolved, the axes it resolved to, and what it was dispatched with">
        <CaretRightIcon size={9} className="shrink-0 transition-transform group-open:rotate-90" />
        <span className="font-mono p-text-2 truncate max-w-[10rem]">{name}</span>
        <span className="shrink-0">config</span>
      </summary>
      <SwarmResolutionBody resolution={resolution} paramRows={paramRows} judges={judges} />
    </details>
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
function SwarmResolutionBody(
  { resolution, paramRows, judges }: {
    resolution: SwarmResolution | undefined;
    paramRows: readonly ForkParamRow[];
    judges: string | null;
  },
) {
  const caps = resolution?.kind === "preset"
    ? `depth ${resolution.depth} · branches ${resolution.branches}`
    : null;
  return (
    <div data-swarm-resolution={resolution?.kind ?? "none"}
      className="mt-1 rounded-md border p-border p-recessed px-3 py-2">
      {resolution !== undefined && (
        <>
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
        </>
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

      {/* What the run was DISPATCHED with, beside what its preset resolved to.
          Two different facts — the caps a preset states are not the budget a
          caller passed — and they belong in the same disclosure because a reader
          who opens one wants both. */}
      {paramRows.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t p-border pt-1.5 font-mono text-[10px] p-text-3">
          {paramRows.map((row) => (
            <span key={row.label} className="whitespace-nowrap">
              {row.label} <span className="p-text-2">{row.value}</span>
            </span>
          ))}
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
