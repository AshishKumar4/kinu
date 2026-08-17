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
import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  GitForkIcon, TreeStructureIcon, WrenchIcon, BrainIcon, ArrowsOutIcon, ArrowLeftIcon,
} from "@phosphor-icons/react";
import type {
  ForkRunParams, ForkRunSummary, HeadRunHeadView, HeadRunView, HeadStep,
} from "@proteus/core";
import { ForkTree } from "@/components/fork-tree";
import { cleanNodeLabel, findForkNode, isCompeted, treeStats } from "@/components/fork-tree-model";
import { buildTree, type MctsRow } from "@/lib/fork-tree-rows";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import {
  DetailSection, EmptyState, EMPTY_HINTS, formatScore, MarkdownContent, Metric, scoreColor,
} from "./shared";
import {
  findHead, forkParamRows, FORK_REVALIDATE_MS, headRunToTree, settlePolicyOf,
  useExplorationCanvas,
} from "./fork-runs";
import * as v from "valibot";

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
}

export function ExplorationSurface({ liveTrees, isStreaming, backgroundJobs, rpc }: ExplorationSurfaceProps) {
  const { agentId } = useParams();
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  /** The branch being watched, or null for the canvas. Selecting a branch OPENS
   *  it — the canvas gives way to it the way the chat column gives way to a
   *  subordinate's conversation — because a running fork is an agent doing work,
   *  not a row of metadata. */
  const [openBranch, setOpenBranch] = useState<{ runId: string; branchId: string } | null>(null);

  const { resource, reload, runs, params, trees, hasActiveWork } =
    useExplorationCanvas(rpc, isStreaming, backgroundJobs, liveTrees);

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
  const opened = openBranch === null ? null : runs.find((run) => run.id === openBranch.runId) ?? null;

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 animate-fade-in">
      {resource.status === "error" && (
        <LoadFailure what="fresh fork runs" message={resource.message} onRetry={reload} />
      )}
      {/* Stacked, the list is content-height (capped, then it scrolls) so it
          cannot stretch into dead space above the canvas; side by side it fills
          its column. */}
      <div className="flex-1 min-h-0 grid gap-3 grid-rows-[auto_minmax(0,1fr)] @3xl:grid-rows-1 @3xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
        <div className="min-h-0 max-h-44 @3xl:max-h-none overflow-y-auto rounded-lg border p-border p-surface p-1.5 space-y-0.5">
          {runs.map((run) => (
            <ForkRunRow key={run.id} run={run} params={params.get(run.id)}
              selected={focused.id === run.id}
              onSelect={() => { setOpenBranch(null); setFocusedRunId(run.id); }} />
          ))}
        </div>
        {opened !== null && openBranch !== null
          ? <ForkBranchView
              run={opened} branchId={openBranch.branchId} rpc={rpc}
              tree={trees.get(opened.id) ?? null}
              hasActiveWork={hasActiveWork}
              onBack={() => setOpenBranch(null)}
              onOpenBranch={(branchId) => setOpenBranch({ runId: opened.id, branchId })}
            />
          : <ForkCanvas
              runs={runs} params={params} trees={trees} rpc={rpc}
              focusedId={focused.id} hasActiveWork={hasActiveWork}
              onFocus={setFocusedRunId}
              onOpenBranch={(runId, branchId) => setOpenBranch({ runId, branchId })}
              expandTo={(runId) => agentId ? `/mcts/${agentId}?run=${encodeURIComponent(runId)}` : null}
            />}
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
 * How long ago, in the coarsest unit that is still honest. Liveness is the whole
 * point of this line, and "4m ago" answers "is it stuck" where a timestamp does
 * not.
 */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/**
 * What a branch is doing, right now — the thing the owner asked for by name:
 * *"I should be able to actually click and 'view' a subagent/fork here and see
 * what it is doing live."*
 *
 * A fork's branches ARE agents: same inference loop, same tool surface, running
 * on the same workspace. So opening one takes over the pane the way a
 * subordinate's conversation takes over the chat column, rather than filling a
 * 360px card with metadata beside a tree. A running branch says when it started
 * and when it last recorded a step — the difference between working and wedged —
 * and its steps stream in as the journal receives them, because it revalidates
 * while the run is live.
 */
function ForkBranchView({
  run, branchId, tree, rpc, hasActiveWork, onBack, onOpenBranch,
}: {
  run: ForkRunSummary;
  branchId: string;
  tree: ForkNode | null;
  rpc: Rpc;
  hasActiveWork: boolean;
  onBack: () => void;
  onOpenBranch: (branchId: string) => void;
}) {
  const { headRun, resource, reload } = useForkRunDetail(run, rpc, hasActiveWork);
  const drawn = tree ?? (headRun ? headRunToTree(headRun) : null);
  const node = drawn ? findForkNode(drawn, branchId) : null;
  const head = headRun ? findHead(headRun, branchId) : null;
  const competed = drawn ? isCompeted(drawn) : false;
  const now = Date.now();

  return (
    <div className="min-h-0 rounded-lg border p-border p-surface overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b p-border shrink-0">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeftIcon size={12} className="mr-1" />All trees
          </Button>
          {node && (
            <>
              <span className={`size-1.5 rounded-full shrink-0 ${statusDot(node.status)} ${node.status === "running" ? "animate-pulse" : ""}`} />
              <span className="text-[10px] uppercase p-text-3 tracking-normal">
                {statusLabel(node, competed)}
              </span>
              <span className="text-[10px] p-text-3">depth {node.depth}</span>
            </>
          )}
        </div>
        <div className="mt-2 min-w-0">
          <div className="text-sm font-semibold p-text leading-snug line-clamp-2">
            {cleanNodeLabel(node?.action ?? head?.task, head?.task ?? branchId)}
          </div>
          <div className="text-[10px] p-text-3 mt-1 truncate">
            in <span className="font-mono">{run.task}</span> · {describeSettle(run)}
          </div>
          {head && (
            <div className="text-[10px] p-text-3 mt-1 font-mono">
              started {ago(head.spawnedAt, now)}
              {head.lastStepAt === null
                ? head.status === "running" ? " · no step recorded yet" : ""
                : ` · last step ${ago(head.lastStepAt, now)}`}
              {head.steps.length > 0 && ` · ${head.steps.length} steps`}
            </div>
          )}
        </div>
      </div>

      <div className="p-4 overflow-y-auto min-h-0 space-y-4">
        {resource.status === "error" && (
          <LoadFailure what="this branch" message={resource.message} onRetry={reload} />
        )}
        {node === null && resource.status === "loading" && (
          <div className="flex justify-center py-8"><Loader size="sm" /></div>
        )}
        {node && (competed
          ? <CompetedVerdict node={node} path={pathTo(drawn!, node.id)} />
          : <MergedVerdict node={node} head={head} />)}
        {node?.observation && (
          <DetailSection title={competed ? "Branch answer" : "Summary"}>
            <div className="border p-border p-card px-3 py-2 text-[11px] p-text-2 leading-relaxed">
              <MarkdownContent content={node.observation} />
            </div>
          </DetailSection>
        )}
        {head && <HeadTrace head={head} />}
        {node && competed && <CompetedExtras node={node} rpc={rpc} />}
        {drawn && node && (
          <BranchNavigation root={drawn} node={node} competed={competed} onOpen={onOpenBranch} />
        )}
        {node === null && resource.status === "ready" && (
          <EmptyState icon={<TreeStructureIcon size={28} />} title="This branch is no longer in the run"
            hint="It was pruned or the run was rewritten while you were reading it." />
        )}
      </div>
    </div>
  );
}

/**
 * The canvas: every tree the workspace has grown, on one scrolling surface.
 *
 * The surface used to render exactly one tree — the run selected in the list —
 * so a workspace with five forks showed one of them and the other four existed
 * only as rows. Choosing from the list now FOCUSES a tree rather than filtering
 * to it: the whole history stays on screen and the reader keeps the comparison
 * that made them open the tab.
 *
 * Bands stacked down the canvas rather than columns across it, because a tree is
 * drawn depth-to-the-right and is therefore wide and short. Each band carries
 * its run's dispatch parameters, so two runs of the same task are told apart by
 * what they were asked to do rather than by their ids.
 */
function ForkCanvas({
  runs, params, trees, rpc, focusedId, hasActiveWork, onFocus, onOpenBranch, expandTo,
}: {
  runs: readonly ForkRunSummary[];
  params: ReadonlyMap<string, ForkRunParams>;
  trees: ReadonlyMap<string, ForkNode>;
  rpc: Rpc;
  focusedId: string;
  hasActiveWork: boolean;
  onFocus: (runId: string) => void;
  onOpenBranch: (runId: string, branchId: string) => void;
  expandTo: (runId: string) => string | null;
}) {
  const bands = useRef(new Map<string, HTMLDivElement>());

  // Focus scrolls, it does not filter. Only on a change of focus: a poll that
  // grows a tree must not drag the canvas back to the focused band.
  useEffect(() => {
    bands.current.get(focusedId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedId]);

  return (
    <div className="min-h-0 overflow-y-auto rounded-lg border p-border p-surface p-2 space-y-2">
      {runs.map((run) => (
        <ForkCanvasBand
          key={run.id} run={run} params={params.get(run.id)} tree={trees.get(run.id) ?? null}
          rpc={rpc} hasActiveWork={hasActiveWork} focused={run.id === focusedId}
          expandTo={expandTo(run.id)}
          onFocus={() => onFocus(run.id)}
          onOpenBranch={(branchId) => onOpenBranch(run.id, branchId)}
          register={(el) => {
            if (el) bands.current.set(run.id, el); else bands.current.delete(run.id);
          }}
        />
      ))}
    </div>
  );
}

/** How tall one band's tree gets. Enough for a depth-4 search to read without
 *  scrolling inside itself, short enough that three bands are visible at once —
 *  the comparison the canvas exists for. */
const BAND_H = 300;

function ForkCanvasBand({
  run, params, tree, rpc, hasActiveWork, focused, expandTo, onFocus, onOpenBranch, register,
}: {
  run: ForkRunSummary;
  params: ForkRunParams | undefined;
  tree: ForkNode | null;
  rpc: Rpc;
  hasActiveWork: boolean;
  focused: boolean;
  expandTo: string | null;
  onFocus: () => void;
  onOpenBranch: (branchId: string) => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  const graphRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const resize = () => setWidth(el.clientWidth);
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => ro.disconnect();
  }, []);

  const { headRun } = useForkRunDetail(run, rpc, hasActiveWork);
  const drawn = tree ?? (headRun ? headRunToTree(headRun) : null);
  const stats = drawn ? treeStats(drawn) : null;
  const paramRows = forkParamRows(params);

  return (
    <div ref={register}
      className={`rounded-md border p-2 transition-colors ${focused ? "p-border-accent p-elevated" : "p-border p-card"}`}>
      <button type="button" onClick={onFocus} className="w-full text-left">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className={`size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "animate-pulse" : ""}`} />
          <span className="text-[11px] font-medium p-text truncate max-w-[60%]" title={run.task}>{run.task}</span>
          <span className="text-[10px] p-text-3 font-mono">{describeSettle(run, params)}</span>
          {expandTo && (
            <Link to={expandTo} title="Open this fork full-screen"
              onClick={(event) => event.stopPropagation()}
              className="ml-auto flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md p-text-3 hover:p-text transition-colors">
              <ArrowsOutIcon size={11} />Expand
            </Link>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] p-text-3 font-mono">
          {paramRows.length > 0
            ? paramRows.map((row) => (
                <span key={row.label}>{row.label} <span className="p-text-2">{row.value}</span></span>
              ))
            : <span className="italic">dispatch parameters no longer recorded</span>}
          {stats && <span>depth <span className="p-text-2">{stats.depth}</span></span>}
        </div>
      </button>
      <div ref={graphRef} className="mt-2 overflow-hidden rounded-md border p-border p-surface"
        style={{ height: BAND_H }}>
        {drawn === null
          ? <div className="h-full flex items-center justify-center px-4 text-center text-[11px] p-text-3">
              No branches were ever written for this run. It stopped before the first one landed.
            </div>
          : width > 0 && (
              <ForkTree root={drawn} width={width} height={BAND_H - 8}
                onNodeClick={(node) => {
                  onFocus();
                  // The root IS the split, not a branch — there is nothing
                  // running behind it to open.
                  if (node.parentId !== null) onOpenBranch(node.id);
                }}
                selectedNode={null} />
            )}
      </div>
    </div>
  );
}

function pathTo(root: ForkNode, id: string): ForkNode[] {
  const walk = (node: ForkNode, trail: ForkNode[]): ForkNode[] | null => {
    const next = [...trail, node];
    if (node.id === id) return next;
    for (const child of node.children) {
      const found = walk(child, next);
      if (found) return found;
    }
    return null;
  };
  return walk(root, []) ?? [];
}

/* ── branch vocabulary and navigation ──────────────────────────── */

function statusLabel(node: ForkNode, competed: boolean): string {
  if (node.status === "running") return "running";
  if (node.status === "failed") return "failed";
  if (!competed) return node.parentId === null ? "the split" : "branch";
  if (node.status === "terminal") return "winner";
  if (node.status === "pruned") return "pruned";
  return "candidate";
}

function statusDot(status: ForkNode["status"]): string {
  if (status === "terminal") return "p-dot-success";
  if (status === "failed") return "p-dot-danger";
  if (status === "running") return "p-dot-warning";
  return "p-dot-neutral";
}

/**
 * Walking the tree from inside a branch: the line that led here, and the
 * branches that came off it.
 *
 * The canvas is how you find a branch; this is how you follow one. Both were in
 * the old side panel, which is the pane the branch view replaced — the reader
 * still needs to get from a winner to the candidate it beat without going back
 * out to the tree and hunting for it.
 */
function BranchNavigation({
  root, node, competed, onOpen,
}: {
  root: ForkNode;
  node: ForkNode;
  competed: boolean;
  onOpen: (branchId: string) => void;
}) {
  const path = pathTo(root, node.id);
  return (
    <>
      {path.length > 1 && (
        <DetailSection title={competed ? "Search path" : "Path"}>
          <div className="space-y-1">
            {path.map((step, i) => (
              <button key={step.id} type="button" disabled={step.parentId === null}
                onClick={() => onOpen(step.id)}
                className={`w-full flex items-start gap-2 rounded-md px-2 py-1 text-left transition-colors ${step.id === node.id ? "p-fill" : "p-card-hover"} disabled:cursor-default`}>
                <span className="text-[9px] p-text-3 font-mono w-5 text-right shrink-0">{i}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] p-text-2 truncate">{cleanNodeLabel(step.action, "(the split)")}</div>
                  <div className="text-[9px] p-text-3 font-mono">
                    {step.id.slice(0, 12)}{step.value !== null && ` · ${formatScore(step.value)}`}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </DetailSection>
      )}

      {node.children.length > 0 && (
        <DetailSection title="Branches from here">
          <div className="space-y-1">
            {node.children.map((child) => (
              <button key={child.id} type="button" onClick={() => onOpen(child.id)}
                className="w-full flex items-start gap-2 rounded-md px-2 py-1 p-fill text-left p-card-hover transition-colors">
                <span className={`mt-1 size-1.5 rounded-full shrink-0 ${statusDot(child.status)}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] p-text-2 truncate" title={cleanNodeLabel(child.action, child.id)}>
                    {cleanNodeLabel(child.action, "(branch)")}
                  </div>
                  <div className="text-[9px] p-text-3 font-mono">
                    {child.id.slice(0, 12)}
                    {child.value !== null && ` · ${formatScore(child.value)}`}
                    {child.visits !== null && ` · ${child.visits} visits`}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </DetailSection>
      )}
    </>
  );
}

const COMPETED_VERDICT = {
  terminal: "Selected as the best branch in this search.",
  pruned: "No longer being explored after scoring and comparison.",
  failed: "The branch failed or could not be evaluated usefully.",
  running: "Still running.",
  open: "Still available for further exploration.",
} satisfies Record<ForkNode["status"], string>;

function CompetedVerdict({ node, path }: { node: ForkNode; path: ForkNode[] }) {
  const visits = node.visits ?? 0;
  const parentVisits = path.length >= 2 ? Math.max(1, path[path.length - 2]!.visits ?? 1) : Math.max(1, visits);
  const uct = visits > 0
    ? (node.value ?? 0) + Math.SQRT2 * Math.sqrt(Math.log(parentVisits) / visits)
    : Infinity;
  return (
    <div className="rounded-lg border p-border p-elevated p-3">
      <div className="flex items-start gap-3">
        <div className={`text-3xl font-semibold leading-none tabular-nums ${scoreColor(node.value ?? 0)}`}>
          {node.value === null ? "—" : formatScore(node.value)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium p-text">Search verdict</div>
          <div className="text-[11px] p-text-3 leading-relaxed mt-0.5">{COMPETED_VERDICT[node.status]}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <Metric label="Explored" value={`${visits}x`} />
        <Metric label="Priority" value={isFinite(uct) ? uct.toFixed(2) : "new"} />
        <Metric label="Depth" value={node.depth} />
        <Metric label="Next branches" value={node.children.length} />
      </div>
    </div>
  );
}

/** A merged fork ranked nothing, so the headline is what the branch DID — the
 *  numbers a head actually carries — never a score it never earned. */
function MergedVerdict({ node, head }: { node: ForkNode; head: HeadRunHeadView | null }) {
  if (!head) {
    return (
      <div className="rounded-lg border p-border p-elevated p-3">
        <div className="text-[11px] font-medium p-text">The split</div>
        <div className="text-[11px] p-text-3 leading-relaxed mt-0.5">
          {node.children.length} branch{node.children.length === 1 ? "" : "es"} ran in parallel and were merged
          into one answer. Nothing here was ranked against anything else.
        </div>
      </div>
    );
  }
  // Tool calls are counted off the trace, which is the only place they exist:
  // a head's calls are a property of the step that made them.
  const toolCalls = head.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Metric label="Steps" value={head.steps.length} />
      <Metric label="Tools" value={toolCalls} />
      <Metric label="Tokens" value={head.tokenInput + head.tokenOutput} />
      <Metric label="Wall" value={head.wallClockMs > 0 ? `${head.wallClockMs}ms` : "running"} />
    </div>
  );
}

/** The code draft and full task text only a search node carries — the tree
 *  rows do not bring them down at depth. */
function CompetedExtras({ node, rpc }: { node: ForkNode; rpc: Rpc }) {
  const load = useCallback(
    () => rpc<{ task: string; codeUsed: string | null } | null>("getMctsNodeDetail", [node.id]),
    [rpc, node.id],
  );
  const { resource } = useAsyncResource(load);
  const detail = lastValue(resource);
  const codeUsed = detail?.codeUsed ?? node.codeUsed ?? null;
  const task = detail?.task ?? node.task ?? "";
  return (
    <>
      {codeUsed && (
        <DetailSection title="Code draft">
          <pre className="text-[10px] p-text-2 leading-relaxed whitespace-pre-wrap break-words max-h-56 overflow-y-auto rounded-md p-fill border p-border p-2">
            {codeUsed}
          </pre>
        </DetailSection>
      )}
      {task && (
        <details className="border p-border p-card px-3 py-2">
          <summary className="cursor-pointer text-[10px] uppercase tracking-normal p-text-3">Original task</summary>
          <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words mt-2">{task}</p>
        </details>
      )}
    </>
  );
}

/* ── a branch's trace (merged forks) ───────────────────────────── */

/** Compact one-line digest of a tool call's input/output value. */
function digestValue<Value>(value: Value): string {
  if (value == null) return "";
  if (v.is(v.string(), value)) return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

// One reasoning step: ordinal + optional reasoning + prose + its tool calls
// (name with input → output).
function StepRow({ step, n }: { step: HeadStep; n: number }) {
  return (
    <div className="flex gap-2">
      <span className="text-[9px] p-text-3 tabular-nums pt-0.5 w-4 shrink-0 text-right">{n}</span>
      <div className="min-w-0 flex-1 space-y-1 border-l p-border pl-2">
        {step.reasoning && (
          <div className="flex items-start gap-1 text-[10px] p-text-3 italic">
            <BrainIcon size={10} className="shrink-0 mt-0.5" />
            <span className="line-clamp-3 whitespace-pre-wrap">{step.reasoning}</span>
          </div>
        )}
        {step.text && <div className="text-[10px] p-text-2 whitespace-pre-wrap break-words">{step.text}</div>}
        {step.toolCalls.map((t, i) => {
          const inp = digestValue(t.input);
          const out = digestValue(t.output);
          return (
            <div key={i} className="text-[10px] flex items-start gap-1">
              <WrenchIcon size={10} className="p-text-3 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <code className="p-accent">{t.name}</code>
                {inp && <span className="p-text-3 break-all"> ({inp.length > 120 ? inp.slice(0, 120) + "…" : inp})</span>}
                {out && <div className="p-text-3 break-all line-clamp-2">→ {out.length > 160 ? out.slice(0, 160) + "…" : out}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HeadTrace({ head }: { head: HeadRunHeadView }) {
  return (
    <>
      {head.rationale && (
        <DetailSection title="Rationale">
          <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words">{head.rationale}</p>
        </DetailSection>
      )}

      {head.errorMessage && (
        <DetailSection title="Error">
          <div className="text-[11px] p-danger break-words">{head.errorMessage}</div>
        </DetailSection>
      )}

      <DetailSection title="Progress">
        {head.steps.length > 0 ? (
          <div className="space-y-1.5">
            {head.steps.map((s, i) => <StepRow key={i} step={s} n={i + 1} />)}
          </div>
        ) : (
          // "No steps" and "lost the trace" are different facts, and only the
          // liveness the header shows can tell them apart — so say which this is
          // rather than the one sentence that used to cover both.
          <div className="text-[11px] p-text-3">
            {head.status === "running"
              ? "Nothing recorded yet — this branch has started but has not finished its first step."
              : "This branch recorded no steps before it stopped."}
          </div>
        )}
      </DetailSection>

      {head.decisions.length > 0 && (
        <DetailSection title="Decisions">
          <div className="space-y-1">
            {head.decisions.map((d, i) => (
              <div key={i} className="rounded-md p-fill border p-border p-2 text-[10px]">
                <div className="p-text-2">{d.question}</div>
                <div className="p-accent mt-0.5">→ {d.choice}</div>
                {d.rationale && <div className="p-text-3 mt-0.5">{d.rationale}</div>}
              </div>
            ))}
          </div>
        </DetailSection>
      )}
    </>
  );
}
