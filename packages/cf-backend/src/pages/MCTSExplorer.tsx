/** One search full screen. `?run=<rootId>` names it; with no `run` it opens the newest. */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { ArrowLeftIcon, GitForkIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { SwarmTree } from "@/components/swarm-tree";
import { NodeTranscript } from "@/components/NodeTranscript";
import {
  findForkNode, terminalForkNode, treeStats, type ExplorerSelection,
} from "@kinu.run/core";
import { EmptyState, formatScore } from "@/components/surfaces/shared";
import {
  runStateLine, FrontierPanel, RunLivenessPanel, RunRefusalNote, SwarmConfigDisclosure, useForkRunTree,
} from "@/components/surfaces/ExplorationSurface";
import {
  forkParamRows, judgeEnsembleLabel, selectForkRun, useExactForkRun, useLiveForkRuns,
  type ExplorationFrontier,
} from "@/components/surfaces/fork-runs";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useKinu } from "@/hooks/use-kinu";
import { useElementSize } from "@/hooks/use-element-size";
import { runLiveness } from "@kinu.run/core";
import type { ForkRunParams, ForkRunSummary } from "@kinu.run/core";

function CanvasNotice({ failure, loading, what, waiting, empty, onRetry }: {
  failure: string | null;
  loading: boolean;
  what: string;
  waiting: string;
  empty: string;
  onRetry: () => void;
}) {
  if (failure !== null) return <LoadFailure what={what} message={failure} onRetry={onRetry} />;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" />{waiting}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex items-center justify-center">
      <EmptyState icon={<GitForkIcon size={28} />} title={empty} />
    </div>
  );
}

export default function MCTSExplorer() {
  const { agentId } = useParams();
  const [params] = useSearchParams();
  const runId = params.get("run");
  const state = useKinu(agentId);
  const { attach, size: dims } = useElementSize();

  const { resource, reload, runs, hasActiveWork } = useLiveForkRuns(
    state.rpc,
    state.liveness.kind === "live",
    state.backgroundJobs,
  );

  const exact = useExactForkRun(state.rpc, runId, hasActiveWork);
  // The newest run is chosen only the first time: `runs[0]` moves when a newer search lands, and
  // `ExplorerBody` is keyed on the run id, so following it would rebuild the tree on every poll.
  const [implied, setImplied] = useState<string | null>(null);
  const newest = selectForkRun(runs, null);
  useEffect(() => {
    if (implied === null && newest !== null) setImplied(newest.id);
  }, [implied, newest]);

  const run = runId === null
    ? (runs?.find((entry) => entry.id === implied) ?? newest)
    : exact.run;

  // The permalink read carries the composed row (parameters, frontier); the list carries summaries.
  const entry = runId === null ? null : exact.entry;
  const selectionResource = runId === null ? resource : exact.resource;
  const reloadSelection = runId === null ? reload : exact.reload;

  const requestedRunMissing = runId !== null
    && exact.resource.status === "ready"
    && exact.run === null;

  return (
    <div className="h-full flex flex-col p-bg">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3.5 border-b p-border">
        <Link to={`/workspace/${agentId}`} className="shrink-0"><Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={14} />}>Back</Button></Link>
        <div className="hidden sm:block h-4 w-px shrink-0 bg-[var(--c-border)]" />
        <GitForkIcon size={16} className="p-accent shrink-0" />
        <span className="font-semibold text-sm p-text shrink-0">Swarm explorer</span>
        {run && <span className="min-w-0 flex-1 text-xs p-text-2 truncate" title={run.task}>{run.name}</span>}
      </div>
      {run && selectionResource.status === "error" && (
        <LoadFailure what="fresh exploration runs" message={selectionResource.message} onRetry={reloadSelection} className="px-5 py-2 border-b p-border" />
      )}
      {run ? (
        <ExplorerBody key={run.id} run={run} state={state} attach={attach} dims={dims}
          hasActiveWork={hasActiveWork} params={entry?.params ?? undefined} frontier={entry?.frontier ?? null} />
      ) : (
        <div ref={attach} className="flex-1 relative overflow-hidden p-surface">
          <CanvasNotice
            failure={selectionResource.status === "error" ? selectionResource.message : null}
            loading={selectionResource.status === "loading"}
            what="the swarms" waiting="Loading swarms…"
            empty={requestedRunMissing ? "Swarm not found" : "No swarms"}
            onRetry={reloadSelection} />
        </div>
      )}
    </div>
  );
}

function ExplorerBody({
  run, state, attach, dims, hasActiveWork, params, frontier,
}: {
  run: ForkRunSummary;
  state: ReturnType<typeof useKinu>;
  attach: (el: HTMLDivElement | null) => void;
  dims: { w: number; h: number };
  hasActiveWork: boolean;
  /** Present on the permalink path only; the list read answers summaries. */
  params: ForkRunParams | undefined;
  /** Null for every run that settled to one number. */
  frontier: ExplorationFrontier | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    tree, headRun, resolution, fanIn, why, refusal, resource, reload,
  } = useForkRunTree(run, state.rpc, state.mctsTrees.get(run.id) ?? null, hasActiveWork);

  const liveness = runLiveness(headRun);
  const stats = tree ? treeStats(tree) : null;
  const winner = tree ? terminalForkNode(tree) : null;
  const selected = tree && selectedId ? findForkNode(tree, selectedId) : null;

  const regions = useMemo(
    () => tree
      ? [{
        runId: run.id, root: tree, title: run.task, name: run.name,
        note: runStateLine(run, liveness, refusal),
        fanIn, why,
      }]
      : [],
    [tree, run, liveness, refusal, fanIn, why],
  );

  const selection: ExplorerSelection | null =
    selectedId === null ? null : { runId: run.id, nodeId: selectedId };

  return (
    <>
      <div className="shrink-0 border-b p-border px-5 py-1.5">
        <SwarmConfigDisclosure resolution={resolution}
          paramRows={forkParamRows(params)} judges={judgeEnsembleLabel(params)} />
      </div>
      {refusal !== null && <RunRefusalNote refusal={refusal} />}
      {liveness !== null && <RunLivenessPanel live={liveness} running={run.status === "running"} />}
      {frontier !== null && <FrontierPanel frontier={frontier} onOpen={setSelectedId} />}
      {/* Side by side from `md`; below it the transcript stacks, bounded to about half the height. */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div ref={attach} className="flex-1 min-h-0 relative overflow-hidden p-surface">
          {tree && resource.status === "error" && (
            <LoadFailure what="the latest fork tree" message={resource.message} onRetry={reload}
              className="absolute z-10 left-4 right-4 top-4 p-surface border p-border rounded-md px-3 py-2" />
          )}
          {!tree && (
            <CanvasNotice
              failure={resource.status === "error" ? resource.message : null}
              loading={resource.status === "loading"}
              what="this swarm" waiting="Loading tree…" empty="Nothing recorded for this swarm"
              onRetry={reload} />
          )}
          {tree && (dims.w > 0 && dims.h > 0 ? (
            <SwarmTree
              regions={regions} width={dims.w} height={dims.h}
              selectedRunId={run.id} selection={selection}
              onSelectNode={(next) => setSelectedId(next.nodeId)} />
          ) : (
            // A zero measurement must never render as nothing: a blank canvas reads as an empty tree.
            <div className="h-full flex items-center justify-center">
              <div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" />Sizing canvas…</div>
            </div>
          ))}
        </div>
        <div className={`${selectedId === null ? "hidden md:flex" : "flex"} w-full max-h-[55%] shrink-0 flex-col min-h-0 border-t p-border p-2 md:h-auto md:max-h-none md:w-[28rem] md:border-t-0 md:border-l`}>
          <NodeTranscript
            selection={selection}
            trees={state.mctsTrees} rpc={state.rpc} headActivity={state.headActivity}
            headDeltas={state.headDeltas}
            onSelect={setSelectedId} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-2.5 border-t p-border">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
          <span className="p-text-2">Branches: <span className="p-text font-medium">{Math.max(0, (stats?.nodes ?? 1) - 1)}</span></span>
          <span className="p-text-2">Depth: <span className="p-text font-medium">{stats?.depth ?? 0}</span></span>
          {winner?.value != null && (
            <span className="p-text-2">Winner: <span className="p-success font-medium">{formatScore(winner.value)}</span></span>
          )}
          {frontier !== null && (
            <span className="p-text-2">Front: <span className="p-text font-medium">{frontier.candidates.length} {frontier.candidates.length === 1 ? "candidate" : "candidates"}</span></span>
          )}
          {run.status === "running" && (
            <span className="flex items-center gap-1 p-accent">
              <span className="size-1.5 rounded-full bg-current p-dot-pulse" />still running
            </span>
          )}
        </div>
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
