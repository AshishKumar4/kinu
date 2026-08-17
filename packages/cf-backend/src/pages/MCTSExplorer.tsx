/**
 * One fork, full screen.
 *
 * The same tree the Exploration surface draws in Column C, with the room a
 * hundred-node search actually needs. `?run=<rootId>` names which fork; with
 * no `run` it opens the newest, which is what Expand sends for the selected
 * row anyway. Drill-down, not a second rendering: the tree, its loader and the
 * adapters are the surface's own, imported rather than re-implemented.
 */
import { useState, useRef, useEffect } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { ArrowLeftIcon, GitForkIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { ForkTree } from "@/components/fork-tree";
import { cleanNodeLabel, findForkNode, terminalForkNode, treeStats } from "@/components/fork-tree-model";
import { EmptyState, EMPTY_HINTS, formatScore } from "@/components/surfaces/shared";
import { describeSettle, useForkRunTree } from "@/components/surfaces/ExplorationSurface";
import { selectForkRun, useExactForkRun, useLiveForkRuns } from "@/components/surfaces/fork-runs";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useProteus } from "@/hooks/use-proteus";
import type { ForkRunSummary } from "@proteus/core";

export default function MCTSExplorer() {
  const { agentId } = useParams();
  const [params] = useSearchParams();
  const runId = params.get("run");
  const state = useProteus(agentId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 1200, h: 700 });

  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const { resource, reload, runs, hasActiveWork } = useLiveForkRuns(
    state.rpc,
    state.isStreaming,
    state.backgroundJobs,
  );
  const exact = useExactForkRun(state.rpc, runId, hasActiveWork);
  const run = runId === null ? selectForkRun(runs, null) : exact.run;
  const selectionResource = runId === null ? resource : exact.resource;
  const reloadSelection = runId === null ? reload : exact.reload;
  const requestedRunMissing = runId !== null
    && exact.resource.status === "ready"
    && exact.run === null;

  return (
    <div className="h-full flex flex-col p-bg">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b p-border">
        <Link to={`/workspace/${agentId}`}><Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={14} />}>Back</Button></Link>
        <div className="h-4 w-px bg-[var(--c-border)]" />
        <GitForkIcon size={16} className="p-accent" />
        <span className="font-semibold text-sm p-text">Fork explorer</span>
        {run && <span className="text-xs p-text-2 truncate" title={run.task}>{run.task}</span>}
      </div>
      {run && selectionResource.status === "error" && (
        <LoadFailure what="fresh fork runs" message={selectionResource.message} onRetry={reloadSelection} className="px-5 py-2 border-b p-border" />
      )}
      {run ? (
        <ExplorerBody key={run.id} run={run} state={state} containerRef={containerRef} dims={dims}
          hasActiveWork={hasActiveWork} />
      ) : (
        <div ref={containerRef} className="flex-1 relative overflow-hidden p-surface">
          {selectionResource.status === "error" ? (
            <LoadFailure what="the fork runs" message={selectionResource.message} onRetry={reloadSelection} />
          ) : selectionResource.status === "loading" ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" />Loading forks…</div>
            </div>
          ) : requestedRunMissing ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState icon={<GitForkIcon size={28} />} title="Fork not found"
                hint="This run is not in the workspace's fork history." />
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <EmptyState icon={<GitForkIcon size={28} />} title="No forks yet" hint={EMPTY_HINTS.forks} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExplorerBody({
  run, state, containerRef, dims, hasActiveWork,
}: {
  run: ForkRunSummary;
  state: ReturnType<typeof useProteus>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  dims: { w: number; h: number };
  hasActiveWork: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { tree, resource, reload } = useForkRunTree(
    run,
    state.rpc,
    state.mctsTrees.get(run.id) ?? null,
    hasActiveWork,
  );
  const stats = tree ? treeStats(tree) : null;
  const winner = tree ? terminalForkNode(tree) : null;
  const selected = tree && selectedId ? findForkNode(tree, selectedId) : null;

  return (
    <>
      <div ref={containerRef} className="flex-1 relative overflow-hidden p-surface">
        {tree && resource.status === "error" && (
          <LoadFailure what="the latest fork tree" message={resource.message} onRetry={reload}
            className="absolute z-10 left-4 right-4 top-4 p-surface border p-border rounded-md px-3 py-2" />
        )}
        {!tree ? (
          resource.status === "error" ? (
            <LoadFailure what="this fork" message={resource.message} onRetry={reload} />
          ) : resource.status === "loading" ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" />Loading tree…</div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <EmptyState icon={<GitForkIcon size={28} />} title="Nothing recorded for this fork"
                hint="The run stopped before its first branch was recorded." />
            </div>
          )
        ) : dims.w > 0 && (
          <ForkTree root={tree} width={dims.w} height={dims.h}
            onNodeClick={(node) => setSelectedId(node.id)} selectedNode={selected} />
        )}
      </div>
      <div className="flex items-center justify-between px-5 py-2.5 border-t p-border">
        <div className="flex items-center gap-6 text-xs">
          <span className="p-text-2">Branches: <span className="p-text font-medium">{Math.max(0, (stats?.nodes ?? 1) - 1)}</span></span>
          <span className="p-text-2">Depth: <span className="p-text font-medium">{stats?.depth ?? 0}</span></span>
          <span className="p-text-3">{describeSettle(run)}</span>
          {winner?.value != null && (
            <span className="p-text-2">Winner: <span className="p-success font-medium">{formatScore(winner.value)}</span></span>
          )}
          {run.status === "running" && (
            <span className="flex items-center gap-1 p-warning">
              <span className="size-1.5 rounded-full bg-current animate-pulse" />still running
            </span>
          )}
        </div>
        {selected && (
          <div className="flex items-center gap-4 text-xs animate-fade-in">
            <TreeStructureIcon size={13} className="p-text-3" />
            <span className="p-text truncate max-w-[28rem]" title={selected.action}>{cleanNodeLabel(selected.action, "(root)")}</span>
            {selected.value !== null && <span className="p-text-2">{formatScore(selected.value)}</span>}
            {selected.visits !== null && <span className="p-text-2">n={selected.visits}</span>}
          </div>
        )}
      </div>
    </>
  );
}
