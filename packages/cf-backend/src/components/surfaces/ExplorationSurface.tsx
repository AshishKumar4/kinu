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
  GitForkIcon, TreeStructureIcon, WrenchIcon, BrainIcon, ArrowsOutIcon,
} from "@phosphor-icons/react";
import type { ForkRunSummary, HeadRunHeadView, HeadRunView, HeadStep } from "@proteus/core";
import { ForkTree } from "@/components/fork-tree";
import { cleanNodeLabel, findForkNode, isCompeted, terminalForkNode, treeStats } from "@/components/fork-tree-model";
import { buildTree, type MctsRow } from "@/lib/fork-tree-rows";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import {
  DetailSection, EmptyState, EMPTY_HINTS, formatScore, MarkdownContent, Metric, scoreColor,
} from "./shared";
import { findHead, headRunToTree, useLiveForkRuns } from "./fork-runs";
import * as v from "valibot";

export interface ExplorationSurfaceProps {
  /** The tree of the search in flight, fed by `mcts-progress` broadcasts. Used
   *  in place of a fetch when it IS the selected run, so a running search
   *  redraws per iteration rather than per poll. */
  liveTree: ForkNode | null;
  /** A turn is in flight — new forks and branches land while it is. */
  isStreaming: boolean;
  /** Detached work can create or continue a fork without a streaming turn. */
  backgroundJobs: readonly BackgroundJob[];
  rpc: Rpc;
}

export function ExplorationSurface({ liveTree, isStreaming, backgroundJobs, rpc }: ExplorationSurfaceProps) {
  const { agentId } = useParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { resource, reload, runs, hasActiveWork } = useLiveForkRuns(rpc, isStreaming, backgroundJobs);

  if (runs === null) {
    return resource.status === "error"
      ? <LoadFailure what="the fork runs" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-8"><Loader size="sm" /></div>;
  }
  if (runs.length === 0) {
    return <EmptyState icon={<GitForkIcon size={28} />} title="No forks yet" hint={EMPTY_HINTS.forks} />;
  }

  // The newest fork is what the operator came to look at, so it is selected on
  // arrival; once they pick another, a later poll must not yank the pane back.
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0]!;

  return (
    <div className="h-full min-h-0 flex flex-col gap-2 animate-fade-in">
      {resource.status === "error" && (
        <LoadFailure what="fresh fork runs" message={resource.message} onRetry={reload} />
      )}
      {/* Stacked, the list is content-height (capped, then it scrolls) so it
          cannot stretch into dead space above the tree; side by side it fills
          its column. */}
      <div className="flex-1 min-h-0 grid gap-3 grid-rows-[auto_minmax(0,1fr)] @3xl:grid-rows-1 @3xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
      <div className="min-h-0 max-h-44 @3xl:max-h-none overflow-y-auto rounded-lg border p-border p-surface p-1.5 space-y-0.5">
        {runs.map((run) => (
          <ForkRunRow key={run.id} run={run} selected={selected.id === run.id}
            onSelect={() => setSelectedId(run.id)} />
        ))}
      </div>
      <ForkRunDetail
        key={selected.id} run={selected} rpc={rpc}
        liveTree={liveTree?.id === selected.id ? liveTree : null}
        hasActiveWork={hasActiveWork}
        expandTo={agentId ? `/mcts/${agentId}?run=${encodeURIComponent(selected.id)}` : null}
      />
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

/** How the fork settled, as a property of the row rather than as navigation —
 *  which is exactly where an implementation detail belongs. */
export function describeSettle(run: ForkRunSummary): string {
  const branches = `${run.branches} branch${run.branches === 1 ? "" : "es"}`;
  if (run.settle === "merged") return `merged · ${branches}`;
  const winner = run.winnerScore === null ? "" : ` · winner ${formatScore(run.winnerScore)}`;
  return `competed · ${branches}${winner}`;
}

function ForkRunRow(
  { run, selected, onSelect }: { run: ForkRunSummary; selected: boolean; onSelect: () => void },
) {
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}
      className={`w-full flex items-start gap-2 text-left rounded-md px-2 py-1.5 transition-colors ${selected ? "p-fill" : "hover:p-card"}`}>
      <span className={`mt-1 size-1.5 rounded-full shrink-0 ${RUN_DOT[run.status]} ${run.status === "running" ? "animate-pulse" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] p-text-2 truncate" title={run.task}>{run.task}</div>
        <div className="text-[10px] p-text-3 tabular-nums">
          {describeSettle(run)} · {new Date(run.startedAt).toLocaleDateString()}
        </div>
      </div>
    </button>
  );
}

/* ── one fork: its tree, and whatever the selected branch actually was ── */

/**
 * The selected run's tree, from whichever store holds it.
 *
 * A competed run whose search is the one in flight is served by the broadcast
 * tree instead of a fetch — the engine pushes a node per iteration, and
 * polling for that would be both slower and noisier.
 */
export function useForkRunTree(
  run: ForkRunSummary, rpc: Rpc, liveTree: ForkNode | null, hasActiveWork: boolean,
) {
  const load = useCallback(async (): Promise<{ tree: ForkNode | null; headRun: HeadRunView | null }> => {
    if (run.settle === "competed") {
      const rows = await rpc<MctsRow[]>("getSearchTree", [run.id]);
      return { tree: rows.length > 0 ? buildTree(rows) : null, headRun: null };
    }
    const found = await rpc<HeadRunView | null>("getHeadRun", [run.id]);
    return { tree: found ? headRunToTree(found) : null, headRun: found };
  }, [rpc, run.id, run.settle]);

  const revalidate = useCallback(
    () => (run.status === "running" || hasActiveWork ? 1500 : null),
    [run.status, hasActiveWork],
  );
  const { resource, reload } = useAsyncResource(load, revalidate, `${run.settle}:${run.id}`);
  const loaded = lastValue(resource);
  return { tree: liveTree ?? loaded?.tree ?? null, headRun: loaded?.headRun ?? null, resource, reload };
}

/**
 * What to inspect before anything is clicked.
 *
 * A competition opens on the branch it settled on — "which one won" is the
 * first question, and the tree already draws the spine that leads there. A
 * merge has no winner, so it opens on the split itself, where the merge
 * narrative is. Either way the pane says something: an empty inspector beside
 * a full tree is a third of the surface spent on a prompt to click.
 */
function defaultSelection(tree: ForkNode): ForkNode {
  return isCompeted(tree) ? terminalForkNode(tree) ?? tree : tree;
}

function ForkRunDetail(
  { run, rpc, liveTree, hasActiveWork, expandTo }:
  { run: ForkRunSummary; rpc: Rpc; liveTree: ForkNode | null; hasActiveWork: boolean; expandTo: string | null },
) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 700, h: 460 });

  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const resize = () => setDims({ w: el.clientWidth, h: Math.max(340, el.clientHeight - 8) });
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => ro.disconnect();
  }, []);

  const { tree, headRun, resource, reload } = useForkRunTree(run, rpc, liveTree, hasActiveWork);

  // Only ever the FIRST selection for this run: the component is keyed on the
  // run id, so a poll that grows the tree must not drag the pane off whatever
  // the reader is reading.
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || tree === null) return;
    picked.current = true;
    setSelectedNodeId(defaultSelection(tree).id);
  }, [tree]);

  if (tree === null) {
    return (
      <div className="min-h-0 rounded-lg border p-border p-surface p-4 flex flex-col justify-center">
        {resource.status === "error"
          ? <LoadFailure what="this fork" message={resource.message} onRetry={reload} />
          : resource.status === "loading"
            ? <div className="flex justify-center py-8"><Loader size="sm" /></div>
            : <EmptyState icon={<GitForkIcon size={28} />} title="Nothing recorded for this fork"
                hint="The run is in the ledger but its branches were never written. It was interrupted before the first one landed." />}
      </div>
    );
  }

  const stats = treeStats(tree);
  const selectedNode = selectedNodeId ? findForkNode(tree, selectedNodeId) : null;
  return (
    <div className="min-h-0 flex flex-col gap-2">
      {resource.status === "error" && (
        <LoadFailure what="the latest fork tree" message={resource.message} onRetry={reload} />
      )}
      <div className="flex-1 min-h-0 grid gap-3 grid-rows-[minmax(340px,1fr)_auto] @6xl:grid-rows-1 @6xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
      <div className="min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 text-xs p-text-2 shrink-0">
          <span>Branches: <span className="p-text font-mono">{Math.max(0, stats.nodes - 1)}</span></span>
          <span>Depth: <span className="p-text font-mono">{stats.depth}</span></span>
          <span className="p-text-3">{describeSettle(run)}</span>
          {expandTo && (
            <Link to={expandTo} title="Open this fork full-screen"
              className="ml-auto flex items-center gap-1 px-2 py-1 text-[11px] rounded-md p-text-3 hover:p-text transition-colors">
              <ArrowsOutIcon size={12} />Expand
            </Link>
          )}
        </div>
        <div ref={graphRef} className="flex-1 min-h-0 overflow-hidden rounded-lg border p-border p-surface">
          {dims.w > 0 && (
            <ForkTree root={tree} width={dims.w} height={dims.h}
              onNodeClick={(node) => setSelectedNodeId(node.id)} selectedNode={selectedNode} />
          )}
        </div>
      </div>
      <BranchInspector
        node={selectedNode} tree={tree} run={run} headRun={headRun} rpc={rpc}
        onClose={() => setSelectedNodeId(null)}
        onOpenNode={(id) => setSelectedNodeId(findForkNode(tree, id)?.id ?? null)}
      />
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

/* ── the inspector ─────────────────────────────────────────────── */

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
 * One pane for both mechanisms. Every section renders only where its data
 * exists, so a competed branch shows its score, rollouts and search path while
 * a head shows its steps, tool calls and decisions — without either pretending
 * to be the other.
 */
function BranchInspector({
  node, tree, run, headRun, rpc, onClose, onOpenNode,
}: {
  node: ForkNode | null;
  tree: ForkNode;
  run: ForkRunSummary;
  headRun: HeadRunView | null;
  rpc: Rpc;
  onClose: () => void;
  onOpenNode: (id: string) => void;
}) {
  if (!node) {
    return (
      <aside className="rounded-lg border p-border p-surface p-4 min-h-0 flex flex-col justify-center">
        <EmptyState
          icon={<TreeStructureIcon size={28} />}
          title="Select a branch"
          hint={run.settle === "competed"
            ? "Pick a node to inspect its result, score, search path and child branches."
            : "Pick a branch to inspect its steps, tool calls and decisions."}
        />
      </aside>
    );
  }

  const competed = isCompeted(tree);
  const head = headRun ? findHead(headRun, node.id) : null;
  const path = pathTo(tree, node.id);
  const title = cleanNodeLabel(node.action || node.observation, node.task || node.id);

  return (
    <aside className="min-h-0 max-h-[70vh] @6xl:max-h-none rounded-lg border p-border p-surface overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b p-border shrink-0">
        <div className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full shrink-0 ${statusDot(node.status)}`} />
          <span className="text-[10px] uppercase p-text-3 tracking-normal">{statusLabel(node, competed)}</span>
          <span className="text-[10px] p-text-3">depth {node.depth}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>Close</Button>
        </div>
        <div className="mt-2 min-w-0">
          <div className="text-sm font-semibold p-text leading-snug line-clamp-3" title={title}>{title}</div>
          <div className="text-[10px] p-text-3 font-mono mt-1 truncate">{node.id}</div>
        </div>
      </div>

      <div className="p-4 overflow-y-auto min-h-0 space-y-4">
        {competed
          ? <CompetedVerdict node={node} path={path} />
          : <MergedVerdict node={node} head={head} />}

        {node.parentId === null && headRun?.merge && (
          <DetailSection title="Merge">
            <p className="text-[11px] p-text-2 leading-relaxed whitespace-pre-wrap break-words">{headRun.merge.narrative}</p>
            <div className="text-[10px] p-text-3 mt-1 font-mono">
              {headRun.merge.headCount} branches · {headRun.merge.totalTokens} tokens
            </div>
          </DetailSection>
        )}

        {node.observation && node.parentId !== null && (
          <DetailSection title={competed ? "Branch answer" : "Summary"}>
            <div className="rounded-lg border p-border p-card px-3 py-2 text-[11px] p-text-2 leading-relaxed max-h-80 overflow-y-auto">
              <MarkdownContent content={node.observation} />
            </div>
          </DetailSection>
        )}

        {head && <HeadTrace head={head} />}
        {competed && <CompetedExtras node={node} rpc={rpc} />}

        {path.length > 1 && (
          <DetailSection title={competed ? "Search path" : "Path"}>
            <div className="space-y-1">
              {path.map((step, i) => (
                <button key={step.id} type="button" onClick={() => onOpenNode(step.id)}
                  className={`w-full flex items-start gap-2 rounded-md px-2 py-1 text-left transition-colors ${step.id === node.id ? "p-fill" : "hover:p-card"}`}>
                  <span className="text-[9px] p-text-3 font-mono w-5 text-right shrink-0">{i}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] p-text-2 truncate">{cleanNodeLabel(step.action, "(root)")}</div>
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
                <button key={child.id} type="button" onClick={() => onOpenNode(child.id)}
                  className="w-full flex items-start gap-2 rounded-md px-2 py-1 p-fill text-left hover:p-card transition-colors">
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
      </div>
    </aside>
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
  return (
    <div className="grid grid-cols-2 gap-2">
      <Metric label="Steps" value={head.steps.length} />
      <Metric label="Tools" value={head.toolCalls.length} />
      <Metric label="Tokens" value={head.tokenInput + head.tokenOutput} />
      <Metric label="Wall" value={`${head.wallClockMs}ms`} />
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
        <details className="rounded-lg border p-border p-card px-3 py-2">
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
        ) : head.toolCalls.length > 0 ? (
          <div className="space-y-1">
            {head.toolCalls.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px]">
                <WrenchIcon size={10} className="p-text-3 shrink-0" />
                <code className="p-text-2">{t.name}</code>
                {t.status && <span className={/error|exit=[1-9]/.test(t.status) ? "p-danger" : "p-text-3"}>{t.status}</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] p-text-3">No step trace captured for this branch.</div>
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
