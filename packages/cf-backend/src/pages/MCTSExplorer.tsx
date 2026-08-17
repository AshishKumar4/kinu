/**
 * One fork, full screen.
 *
 * The same tree the Exploration surface draws in Column C, with the room a
 * hundred-node search actually needs. `?run=<rootId>` names which fork; with
 * no `run` it opens the newest, which is what Expand sends for the selected
 * row anyway. Drill-down, not a second rendering: the tree, its loader and the
 * adapters are the surface's own, imported rather than re-implemented.
 */
import { useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { ArrowLeftIcon, GitForkIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { ForkTree } from "@/components/fork-tree";
import { NodeTranscript } from "@/components/NodeTranscript";
import {
  findForkNode, terminalForkNode, treeStats, type ExplorerSelection,
} from "@/components/fork-tree-model";
import { EmptyState, EMPTY_HINTS, formatScore } from "@/components/surfaces/shared";
import { describeSettle, useForkRunTree } from "@/components/surfaces/ExplorationSurface";
import { selectForkRun, useExactForkRun, useLiveForkRuns } from "@/components/surfaces/fork-runs";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useProteus } from "@/hooks/use-proteus";
import { useElementSize } from "@/hooks/use-element-size";
import type { ForkRunSummary } from "@proteus/core";

export default function MCTSExplorer() {
  const { agentId } = useParams();
  const [params] = useSearchParams();
  const runId = params.get("run");
  const state = useProteus(agentId);
  const { attach, size: dims } = useElementSize();

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
        <ExplorerBody key={run.id} run={run} state={state} attach={attach} dims={dims}
          hasActiveWork={hasActiveWork} />
      ) : (
        <div ref={attach} className="flex-1 relative overflow-hidden p-surface">
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
  run, state, attach, dims, hasActiveWork,
}: {
  run: ForkRunSummary;
  state: ReturnType<typeof useProteus>;
  attach: (el: HTMLDivElement | null) => void;
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
  // One fork, so one band. The canvas renderer takes a list because the
  // Exploration surface draws every fork at once; drilling into one is that
  // same renderer with a list of one, never a second rendering of the tree.
  const regions = useMemo(
    () => tree ? [{ runId: run.id, root: tree, title: run.task, note: describeSettle(run) }] : [],
    [tree, run],
  );
  const selection: ExplorerSelection | null =
    selectedId === null ? null : { runId: run.id, nodeId: selectedId };

  return (
    <>
      {/* Canvas and transcript side by side: the whole point of a full-screen
          explorer is room, and a selected node that only produced a one-line
          footer chip was the reason opening one told the reader nothing. */}
      <div className="flex-1 min-h-0 flex">
        <div ref={attach} className="flex-1 min-h-0 relative overflow-hidden p-surface">
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
          ) : dims.w > 0 && dims.h > 0 ? (
            <ForkTree
              regions={regions} width={dims.w} height={dims.h}
              selectedRunId={run.id} selection={selection}
              onSelectNode={(next) => setSelectedId(next.nodeId)} />
          ) : (
            // A zero measurement must never render as nothing. `dims.w > 0 &&` alone
            // produced a blank canvas under a correct header and footer, which read
            // as "the tree is empty" rather than "we have not measured yet" — the
            // whole reason the Expand view looked broken instead of loading.
            <div className="h-full flex items-center justify-center">
              <div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" />Sizing canvas…</div>
            </div>
          )}
        </div>
        <div className="w-[28rem] shrink-0 border-l p-border flex flex-col min-h-0 p-2">
          <NodeTranscript
            selection={selection}
            trees={state.mctsTrees} rpc={state.rpc} headActivity={state.headActivity}
            onSelect={setSelectedId} />
        </div>
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
        {/* The selected node's NAME now heads the transcript beside this row, so
            only the two numbers the transcript does not carry stay here: a
            branch's score and its rollout count are properties of the search,
            not of the agent's behaviour. */}
        {selected && (selected.value !== null || selected.visits !== null) && (
          <div className="flex items-center gap-4 text-xs animate-fade-in">
            <TreeStructureIcon size={13} className="p-text-3" />
            {selected.value !== null && <span className="p-text-2">score <span className="p-text font-medium">{formatScore(selected.value)}</span></span>}
            {selected.visits !== null && <span className="p-text-2">n={selected.visits}</span>}
          </div>
        )}
      </div>
    </>
  );
}
