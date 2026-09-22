/**
 * Exploration: every run's search tree in one list and one canvas. A run can fill both
 * `search_nodes` and `head_journal`, so rows report `hasSearchTree` and `hasNodeTranscripts`.
 */
import { useState, useCallback, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  GitForkIcon, TreeStructureIcon, ArrowsOutIcon, ArrowLeftIcon, CaretRightIcon, CaretDownIcon,
  XIcon,
} from "@phosphor-icons/react";
import { isRateLimitedTurnError } from "@kinu.run/core";
import type { ForkRunParams, ForkRunSummary, HeadRunView } from "@kinu.run/core";
import { SwarmTree, naturalCanvasHeight } from "@/components/swarm-tree";
import { NodeTranscript, statusDot } from "@/components/NodeTranscript";
import type { HeadDeltas } from "@kinu.run/core";
import { cleanNodeLabel, type ExplorerSelection } from "@kinu.run/core";
import { explorationForkTree, type MctsRow } from "@kinu.run/core";
import type { ForkNode, Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ScrollBoundary } from "@/components/ui/ScrollBoundary";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
import { useElementSize } from "@/hooks/use-element-size";
import { EmptyState, formatScore } from "./shared";
import { timeAgo } from "@kinu.run/core";
import {
  forkParamRows, FORK_REVALIDATE_MS, judgeEnsembleLabel,
  useExplorationCanvas, type ExplorationFrontier, type ForkParamRow,
} from "./fork-runs";
import {
  fanInVertices, formatEvidenceValue, nodeRationales, runLiveness, runRefusal, swarmAxisRows, swarmResolutionOf,
  type RunLevel, type RunLiveness, type RunRefusal, type SwarmAxis, type SwarmResolution,
} from "@kinu.run/core";

export interface ExplorationSurfaceProps {
  /** Live trees from `mcts-progress`, keyed by search; they replace polled rows so a
   *  running search redraws per iteration. */
  liveTrees: ReadonlyMap<string, ForkNode>;
  isStreaming: boolean;
  /** Detached work can create or continue a fork without a streaming turn. */
  backgroundJobs: readonly BackgroundJob[];
  rpc: Rpc;
  /** Per-branch journal-write counter from the `head_activity` broadcast. */
  headActivity: ReadonlyMap<string, number>;
  headDeltas?: HeadDeltas;
}

export function ExplorationSurface({
  liveTrees, isStreaming, backgroundJobs, rpc, headActivity, headDeltas,
}: ExplorationSurfaceProps) {
  const { agentId } = useParams();
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  /** Null means nothing opened; below `@6xl` the pane replaces the canvas only once set. */
  const [inspect, setInspect] = useState<{ runId: string; nodeId: string | null } | null>(null);

  const {
    resource, reload, runs, params, trees, journals, resolutions, frontiers,
    exhausted, loadingMore, pageError, loadMore,
  } = useExplorationCanvas({ rpc, isStreaming, backgroundJobs, liveTrees, headActivity });

  // The list is the scroll container in both layouts.
  const listRef = useGrowingScroll({
    grows: "down", content: runs, fetched: runs, onReachEdge: loadMore,
  });

  if (runs === null) {
    return resource.status === "error"
      ? <LoadFailure what="the fork runs" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }

  if (runs.length === 0) {
    return <EmptyState icon={<GitForkIcon size={28} />} title="No swarms" />;
  }

  // Focus the newest fork on arrival only; later polls must not move the focus.
  const focused = runs.find((run) => run.id === focusedRunId) ?? runs[0];
  /** Falls back to the focused run so the pane is never empty. */
  const inspecting = inspect ?? { runId: focused.id, nodeId: null };
  const opened = runs.find((run) => run.id === inspecting.runId) ?? focused;

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 animate-fade-in">
      {resource.status === "error" && (
        <LoadFailure what="fresh fork runs" message={resource.message} onRetry={reload} />
      )}
      {/* Three panes at `@6xl`. Narrower, the detail pane replaces the canvas while open;
          stacked, the list is height-capped. */}
      <div className="flex-1 min-h-0 grid gap-3 grid-rows-[auto_minmax(0,1fr)] @3xl:grid-rows-1 @3xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] @6xl:grid-cols-[minmax(200px,250px)_minmax(0,1fr)_minmax(330px,400px)]">
        <div ref={listRef}
          className="min-h-0 max-h-44 @3xl:max-h-none overflow-y-auto rounded-xl border p-border p-surface p-1.5 space-y-0.5">
          {runs.map((run) => (
            <ForkRunRow key={run.id} run={run}
              kind={runKind(resolutions.get(run.id))}
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
            runs={runs} trees={trees} journals={journals}
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
            frontier={frontiers.get(opened.id) ?? null}
            branchId={inspecting.nodeId}
            trees={trees} rpc={rpc} headActivity={headActivity} headDeltas={headDeltas}
            onOpenBranch={(nodeId) => setInspect({ runId: opened.id, nodeId })}
            onClose={() => setInspect(null)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * `running` uses the pulsing accent as elsewhere in the product; in light mode
 * `--c-warning` is indistinguishable from `--c-text-3`.
 */
const RUN_DOT = {
  running: "p-dot-accent",
  completed: "p-dot-success",
  failed: "p-dot-danger",
  partial: "p-dot-neutral",
} satisfies Record<ForkRunSummary["status"], string>;

/**
 * The run's current state in one line, shared by the list, detail pane and band caption
 * so they agree. A refusal's reason follows its stored status.
 */
export function runStateLine(
  run: ForkRunSummary, liveness: RunLiveness | null, refusal: RunRefusal | null,
): string {
  const parts: string[] = [run.status];

  if (refusal !== null && refusal.reason !== run.status) parts.push(refusal.reason);

  if (liveness !== null) parts.push(nodeTally(liveness));

  if (run.winnerScore !== null) parts.push(`winner ${formatScore(run.winnerScore)}`);

  return parts.join(" · ");
}

/** The preset's name, or `custom` for a composition. */
function runKind(resolution: SwarmResolution | undefined): string | null {
  if (resolution === undefined) return null;

  return resolution.kind === "preset" ? resolution.preset : "custom";
}

/** The name leads; the full task is the tooltip. Config stays behind the disclosure. */
function ForkRunRow(
  { run, kind, liveness, refusal, selected, onSelect }: {
    run: ForkRunSummary;
    kind: string | null;
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
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "p-dot-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="p-row-text p-text truncate" title={run.task}>
          {run.name}
          {kind !== null && <span className="p-text-3"> · {kind}</span>}
        </div>
        <div className="p-meta p-text-3 tabular-nums truncate"
          title={refusal === null ? undefined : refusal.error}>
          {runStateLine(run, liveness, refusal)}
        </div>
        <div className="p-meta p-text-3 tabular-nums">
          {new Date(run.startedAt).toLocaleString()}
        </div>
      </div>
    </button>
  );
}

/**
 * Non-zero counts only: a tally of zeroes would claim idle nodes exist. Shared by run
 * and level so the two cannot disagree.
 */
function nodeTally(counted: Pick<RunLiveness, "running" | "reported" | "failed" | "total">): string {
  const parts: string[] = [];

  if (counted.running > 0) parts.push(`${counted.running} running`);

  if (counted.reported > 0) parts.push(`${counted.reported} reported`);

  if (counted.failed > 0) parts.push(`${counted.failed} stopped`);

  return parts.length === 0 ? `${counted.total} nodes` : parts.join(" · ");
}

/**
 * Fetched for every run with `hasNodeTranscripts`; the journal is the only record of
 * fan-in and of the resolved preset.
 */
function useForkRunDetail(run: ForkRunSummary, rpc: Rpc, hasActiveWork: boolean) {
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
 * A live search uses the broadcast tree. Search rows and journal always both fold: the
 * root's row lands at dispatch, so reading one half hides nodes still working.
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
  // Which half a reader is waiting on; the tree folds from both.
  const searched = run.hasSearchTree;
  const fetched = explorationForkTree({ tree: rows ?? [], head: detail.headRun });

  return {
    tree: liveTree ?? fetched,
    headRun: detail.headRun,
    // Only a search writes both stores, and `head_runs.rationale` differs by run kind;
    // see `resolutions` in ./fork-runs.
    resolution: searched ? swarmResolutionOf(detail.headRun?.rationale) ?? undefined : undefined,
    fanIn: fanInVertices(detail.headRun),
    why: nodeRationales(detail.headRun),
    refusal: runRefusal(run, detail.headRun),
    // Only the tree read's failure is reported; a failed journal costs just the fan-in marks.
    resource: searched ? resource : detail.resource,
    reload: searched ? reload : detail.reload,
  };
}

/**
 * The whole run: objective, live node state, reports, config; a branch opens inside it.
 * `head` (journal) holds unreported nodes; `tree` holds scores.
 */
function RunDetailView({
  run, params, resolution, journal, tree, frontier, branchId, trees, rpc, headActivity, headDeltas, onOpenBranch, onClose,
}: {
  run: ForkRunSummary;
  params: ForkRunParams | undefined;
  resolution: SwarmResolution | undefined;
  journal: HeadRunView | null;
  tree: ForkNode | null;
  /** Null unless the run settled to a Pareto front. */
  frontier: ExplorationFrontier | null;
  branchId: string | null;
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  headDeltas?: HeadDeltas;
  onOpenBranch: (branchId: string | null) => void;
  /** Only reachable below `@6xl`, where the pane replaced the canvas. */
  onClose: () => void;
}) {
  const liveness = runLiveness(journal);
  const refusal = runRefusal(run, journal);

  return (
    <div className="h-full min-h-0 flex flex-col rounded-xl border p-border p-surface overflow-hidden">
      <div className="shrink-0 flex items-start gap-2 border-b p-border px-3 py-2">
        <span className={`mt-1.5 size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "p-dot-pulse" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="p-row-text font-medium p-text truncate" title={run.task}>{run.name}</span>
            {runKind(resolution) !== null && (
              <span className="p-annotation p-text-3 shrink-0">· {runKind(resolution)}</span>
            )}
          </div>
          <RunObjective task={run.task} />
          <div className="mt-0.5 p-meta p-text-3 tabular-nums">
            {/* The tally is in the liveness panel; the header carries outcome and winner only. */}
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
      {frontier !== null && <FrontierPanel frontier={frontier} onOpen={onOpenBranch} />}
      <div className="shrink-0 border-b p-border px-3 py-1.5">
        <SwarmConfigDisclosure resolution={resolution}
          paramRows={forkParamRows(params)} judges={judgeEnsembleLabel(params)} />
      </div>
      {branchId === null
        ? <RunNodeList journal={journal} tree={tree} activity={headActivity} onOpen={onOpenBranch} />
        : <ForkBranchView run={run} branchId={branchId} trees={trees} rpc={rpc}
            headActivity={headActivity} headDeltas={headDeltas} nodeCount={journal?.heads.length ?? run.branches}
            onBack={() => onOpenBranch(null)} onOpenBranch={onOpenBranch} />}
    </div>
  );
}

/** Matches `NodeTranscript`'s clamp: same kind of text in the same column. */
const OBJECTIVE_CLAMP = 240;

function RunObjective({ task }: { task: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = task.length > OBJECTIVE_CLAMP;

  return (
    <>
      <div className={`p-row-text p-text-2 break-words ${long && !expanded ? "line-clamp-2" : ""}`}>
        {task}
      </div>
      {long && (
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
          className="mt-0.5 inline-flex items-center gap-1 p-t-control p-text-3 hover:p-text transition-colors cursor-pointer">
          {expanded ? <CaretDownIcon size={9} /> : <CaretRightIcon size={9} />}
          {expanded ? "collapse" : "expand"}
        </button>
      )}
    </>
  );
}

/**
 * Per-level liveness from journal depth. The newest event time is what shows a run is
 * alive; `runRefusal` is null while running.
 */
export function RunLivenessPanel({ live, running }: { live: RunLiveness; running: boolean }) {
  return (
    <div data-run-liveness className="shrink-0 border-b p-border px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 p-meta tabular-nums">
        <span className="p-text-2">{nodeTally(live)}</span>
        <span className="p-text-3">
          {running ? "last step " : "last activity "}{timeAgo(live.lastEventAt)}
        </span>
      </div>
      {/* Per-level rows only when there is more than one level. */}
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
    <div className="flex items-baseline gap-2 p-meta tabular-nums">
      <span className="w-12 shrink-0 p-text-3">level {level.depth}</span>
      <span className="min-w-0 p-text-2">{nodeTally(level)}</span>
    </div>
  );
}

/** A `settle:'front'` run has null `best`; this panel shows what it found. */
export function FrontierPanel({ frontier, onOpen }: {
  frontier: ExplorationFrontier;
  onOpen: (nodeId: string) => void;
}) {
  return (
    <div data-frontier className="shrink-0 border-b p-border px-3 py-2">
      <div className="p-meta p-text-2 tabular-nums">
        front · {frontier.candidates.length === 1 ? "1 candidate" : `${frontier.candidates.length} candidates`}
      </div>
      <div className="mt-1 space-y-0.5">
        {frontier.candidates.map((candidate) => (
          <button key={candidate.nodeId} type="button" onClick={() => onOpen(candidate.nodeId)}
            className="w-full flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-1.5 py-0.5 text-left p-annotation p-card-hover transition-colors cursor-pointer">
            <span className="p-text-2 truncate max-w-[10rem]" title={candidate.nodeId}>{candidate.nodeId}</span>
            {frontier.axes.map((axis) => (
              <span key={axis.id} className="whitespace-nowrap p-text-3" title={`${axis.id}: ${axis.direction}`}>
                {axis.id} <span className="p-text-2">{formatEvidenceValue(candidate.evidence[axis.id])}</span>
              </span>
            ))}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Built from the journal, the only store holding unreported nodes; newest activity first. */
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
        <EmptyState icon={<TreeStructureIcon size={24} />} title="No nodes yet" />
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

/** A node in the journal but not the tree is still running and has no score. */
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
  /** Written to since mount, via the `head_activity` push. */
  moving: boolean;
  onOpen: () => void;
}) {
  const live = node.status === "running";
  // A provider-paced empty turn is capacity, not a fault. Classified via `chat.ts`'s
  // classifier, never a regex here, so rewording cannot reclassify.
  const rateLimited = node.errorMessage !== null && isRateLimitedTurnError(node.errorMessage);

  return (
    <button type="button" onClick={onOpen} data-run-node={node.id}
      className="w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 p-card-hover transition-colors">
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${rateLimited ? "p-dot-warning" : statusDot(node.status)} ${live && moving ? "p-dot-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="p-row-text p-text-2 truncate" title={node.task}>
          {cleanNodeLabel(node.task, node.id)}
        </div>
        <div className="p-meta p-text-3 tabular-nums truncate">
          {node.status}
          {score !== null && ` · ${formatScore(score)}`}
          {live
            ? ` · ${node.lastStepAt === null ? "no step yet" : `last step ${timeAgo(node.lastStepAt)}`}`
            : node.wallClockMs > 0 && ` · ${Math.round(node.wallClockMs / 1000)}s`}
        </div>
        {node.summary !== null && (
          <div className="mt-0.5 p-row-text p-text-2 line-clamp-2">{node.summary}</div>
        )}
        {node.errorMessage !== null && (
          <div data-node-reason={rateLimited ? "rate-limited" : "failed"}
            className={`mt-0.5 p-row-text line-clamp-2 ${rateLimited ? "p-warning" : "p-danger"}`}>
            {rateLimited && <span className="font-medium">Rate limited · </span>}
            {node.errorMessage}
          </div>
        )}
      </div>
    </button>
  );
}

/** The body is `NodeTranscript` (same `MessageView` as the main thread); closes back to the run. */
function ForkBranchView({
  run, branchId, trees, rpc, headActivity, headDeltas, nodeCount, onBack, onOpenBranch,
}: {
  run: ForkRunSummary;
  branchId: string;
  /** Keyed by run; names a node the store has no record of. */
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  headActivity: ReadonlyMap<string, number>;
  headDeltas?: HeadDeltas;
  /** The journal's count; `ForkRunSummary.branches` counts only settled search rows. */
  nodeCount: number;
  onBack: () => void;
  onOpenBranch: (branchId: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 flex flex-col">
      <div className="shrink-0 flex items-center gap-1 border-b p-border px-2 py-1">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 p-t-control p-text-3 hover:p-text transition-colors cursor-pointer">
          <ArrowLeftIcon size={10} />all {nodeCount === 1 ? "1 node" : `${nodeCount} nodes`}
        </button>
      </div>
      <NodeTranscript
        selection={{ runId: run.id, nodeId: branchId }}
        trees={trees} rpc={rpc} headActivity={headActivity} headDeltas={headDeltas}
        onSelect={onOpenBranch} />
    </div>
  );
}

/** Card hairline, top and bottom: the measured box vs. the graph's layout box. */
const CARD_BORDER = 2;

/**
 * Every run as a band on one canvas, sized to its tree. Choosing from the list focuses
 * (refits to) a band rather than filtering.
 */
function ForkCanvas({
  runs, trees, journals, focusedId, selection, onFocus, onSelectNode, expandTo,
  activity,
}: {
  runs: readonly ForkRunSummary[];
  trees: ReadonlyMap<string, ForkNode>;
  /** Per-run node journals; source of fan-in vertices. */
  journals: ReadonlyMap<string, HeadRunView>;
  focusedId: string;
  selection: ExplorerSelection | null;
  onFocus: (runId: string) => void;
  onSelectNode: (selection: ExplorerSelection) => void;
  expandTo: string | null;
  /** Per-node journal write counters; pulse working nodes on the canvas. */
  activity: ReadonlyMap<string, number>;
}) {
  /** `cell`: column height, a stable budget. `chrome`: header stack. `size`: read for width
   *  only, since its height is set here (measuring it would ratchet down). */
  const { attach: attachCell, size: cell } = useElementSize();
  const { attach: attachChrome, size: chrome } = useElementSize();
  const { attach, size } = useElementSize();

  // Memoised on tree identities so a no-op poll does not rebuild the scene. Band
  // captions use the run's state sentence, not its config.
  const regions = useMemo(
    () => runs.flatMap((run) => {
      const root = trees.get(run.id);

      if (!root) return [];
      const journal = journals.get(run.id) ?? null;

      return [{
        runId: run.id, root, title: run.task, name: run.name,
        note: runStateLine(run, runLiveness(journal), runRefusal(run, journal)),
        fanIn: fanInVertices(journal),
        why: nodeRationales(journal),
      }];
    }),
    [runs, trees, journals],
  );

  const focused = runs.find((run) => run.id === focusedId) ?? null;
  const refusal = focused === null ? null : runRefusal(focused, journals.get(focusedId) ?? null);

  /** Measured off the canvas's own layout. Null with no tree: the box holds a centred sentence. */
  const natural = useMemo(
    () => (regions.length === 0 ? null : naturalCanvasHeight(regions)),
    [regions],
  );

  /** Remaining column height minus the card hairline (`cell` is measured outside the card).
   *  Zero until measured. */
  const budget = Math.max(0, cell.h - CARD_BORDER - chrome.h);
  const canvasH = natural === null ? budget : Math.min(budget, natural);
  const measured = size.w > 0 && canvasH > 0;

  return (
    // The outer box is the measured budget; the inner card hugs its content.
    <div ref={attachCell} className="h-full min-h-0">
      <div data-tree-card className="flex max-h-full flex-col rounded-xl border p-border p-surface overflow-hidden">
        <div ref={attachChrome} className="shrink-0">
          {refusal !== null && <RunRefusalNote refusal={refusal} />}
        </div>
        {/* Remaining height capped at the scene's 1:1 size; `flex-1` alone over-sizes small trees. */}
        <div ref={attach} className="relative shrink-0 min-h-0" style={{ height: canvasH }}>
          {regions.length === 0 && (
            <div className="h-full flex items-center justify-center px-6 text-center p-t-status p-text-3">
              {/* Present tense for a running search; past tense would report it as dead. */}
              {focused?.status === "running"
                ? "The search has not written a branch yet."
                : "These searches wrote no branches. Each stopped before its first expansion."}
            </div>
          )}
          {regions.length > 0 && (measured ? (
            <SwarmTree
              regions={regions} width={size.w} height={canvasH}
              selectedRunId={focusedId} selection={selection}
              activity={activity}
              onSelectRun={onFocus}
              onSelectNode={onSelectNode}
            />
          ) : (
            <div className="h-full flex items-center justify-center p-t-status p-text-3">Sizing canvas…</div>
          ))}
          {expandTo && (
            <Link to={expandTo} title="Open the selected search full-screen"
              className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border p-border p-surface px-2 py-0.5 p-t-control p-text-3 hover:p-text transition-colors">
              <ArrowsOutIcon size={11} />Expand
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/** Run config behind one chip; the resolved name stays visible. Shared with the full-screen explorer. */
export function SwarmConfigDisclosure(
  { resolution, paramRows = [], judges = null }: {
    resolution: SwarmResolution | undefined;
    paramRows?: readonly ForkParamRow[];
    judges?: string | null;
  },
) {
  if (resolution === undefined && paramRows.length === 0) return null;

  const resolved = resolution?.kind === "custom" ? resolution.label : resolution?.preset;
  const name = resolved ?? "config";

  return (
    <details data-swarm-config className="group shrink-0 min-w-0">
      <summary
        className="flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-0.5 p-t-control p-text-3 hover:p-text transition-colors [&::-webkit-details-marker]:hidden"
        title="The preset this run resolved, its axes, and its dispatch arguments.">
        <CaretRightIcon size={9} className="shrink-0 transition-transform group-open:rotate-90" />
        <span className="font-mono p-text-2 truncate max-w-[10rem]">{name}</span>
        <span className="shrink-0">config</span>
      </summary>
      <SwarmResolutionBody resolution={resolution} paramRows={paramRows} judges={judges} />
    </details>
  );
}

/**
 * Preset name plus the tuple it resolved to; `settle` is derived from two axes. A
 * composition reaches the client as its provenance label only, and the panel says so.
 */
function SwarmResolutionBody(
  { resolution, paramRows, judges }: {
    resolution: SwarmResolution | undefined;
    paramRows: readonly ForkParamRow[];
    judges: string | null;
  },
) {
  let caps: string | null = null;

  if (resolution?.kind === "preset") {
    caps = resolution.depth === 1
      ? `flat · ${resolution.branches} ${resolution.branches === 1 ? "branch" : "branches"}`
      : `depth ${resolution.depth} · branches ${resolution.branches}`;
  }

  return (
    <div data-swarm-resolution={resolution?.kind ?? "none"}
      className="mt-1 rounded-md border p-border p-recessed px-3 py-2">
      {resolution !== undefined && (
        <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="p-eyebrow shrink-0">
          {resolution.kind === "custom" ? "composition" : "preset"}
        </span>
        <span className="p-annotation font-medium p-accent-fg min-w-0 break-words">
          {resolution.kind === "custom" ? resolution.label : resolution.preset}
        </span>
        {resolution.kind === "preset" && (
          <span className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 p-badge-neutral"
            title="Derived from the score and advance axes.">
              settle {resolution.settle}
          </span>
        )}
      </div>

      {/* `auto-fit` grid so each axis value wraps rather than truncates. */}
      {resolution.kind === "preset" && (
        <dl className="mt-1.5 grid gap-x-3 gap-y-1.5 [grid-template-columns:repeat(auto-fit,minmax(5.25rem,1fr))]">
          {swarmAxisRows(resolution.config).map((row) => (
            <div key={row.axis} className="min-w-0" title={`${row.axis}: ${AXIS_MEANING[row.axis]}`}>
              <dt className="p-eyebrow">{row.axis}</dt>
              <dd className="p-annotation p-text break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {resolution.kind === "custom" && (
        <p className="mt-1.5 p-meta p-text-3">
          This composition recorded only its provenance label.
        </p>
      )}
        </>
      )}

      {(caps !== null || judges !== null) && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 p-annotation p-text-3">
          {caps !== null && (
            <span className="whitespace-nowrap" title="The caps the preset resolved.">
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

      {/* Dispatch parameters beside the preset's stated caps; they differ. */}
      {paramRows.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t p-border pt-1.5 p-annotation p-text-3">
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

/** Quoted from the declarations in `core/src/strategy/swarm.ts`, not paraphrased. */
const AXIS_MEANING = {
  unit: "what one node produces",
  context: "what a child starts from",
  expand: "how children are produced; `aggregate` is fan-in, k parents into one child",
  score: "how a node is valued",
  advance: "where the next unit of budget goes",
  carry: "what survives across iterations",
} as const satisfies Record<SwarmAxis, string>;

/**
 * A banner above the tree, never replacing it: a refused run still has branches worth
 * reading, and on the shared canvas a replacement would hide other runs.
 */
export function RunRefusalNote({ refusal }: { refusal: RunRefusal }) {
  return (
    <div data-run-refusal={refusal.reason}
      className="shrink-0 flex items-baseline gap-2 px-3 py-1.5 border-b p-border p-meta">
      <span aria-hidden className="mt-1 size-1.5 rounded-full p-dot-danger shrink-0" />
      <span className="font-mono p-danger shrink-0">{refusal.reason}</span>
      <span className="p-text-2 leading-snug min-w-0">{refusal.error}</span>
    </div>
  );
}
