/**
 * One search, full screen.
 *
 * The same tree the Exploration surface draws in Column C, with the room a
 * hundred-node search actually needs, plus the resolution the run resolved above it.
 * `?run=<rootId>` names which search; with no `run` it opens the newest, which is
 * what Expand sends for the selected row anyway. Drill-down, not a second
 * rendering: the tree, its loader, its resolution panel and the adapters are the
 * surface's own, imported rather than re-implemented.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { ArrowLeftIcon, GitForkIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { SwarmTree } from "@/components/swarm-tree";
import { NodeTranscript } from "@/components/NodeTranscript";
import {
  findForkNode, terminalForkNode, treeStats, type ExplorerSelection,
} from "@/components/swarm-tree-model";
import { EmptyState, EMPTY_HINTS, formatScore } from "@/components/surfaces/shared";
import {
  runStateLine, RunLivenessPanel, RunRefusalNote, SwarmConfigDisclosure, useForkRunTree,
} from "@/components/surfaces/ExplorationSurface";
import {
  selectForkRun, useExactForkRun, useLiveForkRuns,
} from "@/components/surfaces/fork-runs";
import { runLiveness } from "@/components/surfaces/swarm-resolution";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useKinu } from "@/hooks/use-kinu";
import { useElementSize } from "@/hooks/use-element-size";
import type { ForkRunSummary } from "@kinu.run/core";

export default function MCTSExplorer() {
  const { agentId } = useParams();
  const [params] = useSearchParams();
  const runId = params.get("run");
  const state = useKinu(agentId);
  const { attach, size: dims } = useElementSize();

  const { resource, reload, runs, hasActiveWork } = useLiveForkRuns(
    state.rpc,
    state.isStreaming,
    state.backgroundJobs,
  );
  const exact = useExactForkRun(state.rpc, runId, hasActiveWork);
  /**
   * With no `?run=`, the newest search is what the reader came to look at — but
   * only the FIRST time. `runs[0]` moves the moment a newer search lands, and
   * `ExplorerBody` is keyed on the run's id, so a poll during a live workspace
   * tore the whole tree and transcript down and rebuilt them on a different
   * search, taking the reader's node selection with it. Column C already states
   * this rule for itself: focused on arrival, and a later poll must not move it.
   */
  const [implied, setImplied] = useState<string | null>(null);
  const newest = selectForkRun(runs, null);
  useEffect(() => {
    if (implied === null && newest !== null) setImplied(newest.id);
  }, [implied, newest]);
  const run = runId === null
    ? (runs?.find((entry) => entry.id === implied) ?? newest)
    : exact.run;
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
        <span className="font-semibold text-sm p-text shrink-0">Search explorer</span>
        {/* The NAME leads and the task is what it hands over on hover: at 640px
            this is the row that decided whether the title broke mid-word or
            simply ran out of room, and a name is short by construction. */}
        {run && <span className="min-w-0 flex-1 text-xs p-text-2 truncate" title={run.task}>{run.name}</span>}
      </div>
      {run && selectionResource.status === "error" && (
        <LoadFailure what="fresh exploration runs" message={selectionResource.message} onRetry={reloadSelection} className="px-5 py-2 border-b p-border" />
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
  state: ReturnType<typeof useKinu>;
  attach: (el: HTMLDivElement | null) => void;
  dims: { w: number; h: number };
  hasActiveWork: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const {
    tree, headRun, resolution, fanIn, why, refusal, resource, reload,
  } = useForkRunTree(run, state.rpc, state.mctsTrees.get(run.id) ?? null, hasActiveWork);
  const liveness = runLiveness(headRun);
  const stats = tree ? treeStats(tree) : null;
  const winner = tree ? terminalForkNode(tree) : null;
  const selected = tree && selectedId ? findForkNode(tree, selectedId) : null;
  // One search, so one band. The canvas renderer takes a list because the
  // Exploration surface draws every search at once; drilling into one is that
  // same renderer with a list of one, never a second rendering of the tree.
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
      {/* Which preset this search resolved and the tuple it resolved to, BEHIND a
          disclosure — the same one Column C uses, so the reader meets the config
          in one place and only when they ask for it. It was an always-open panel
          laid across the top of the full-screen tree, which is the clutter the
          owner named on this exact view.

          No `judges`: the clamp is a DISPATCH parameter, and this page reads one run
          by id through `getForkRun`, which answers a summary. `getExplorationCanvas`
          is the only read that carries parameters and it is page-scoped, so there is
          no per-run parameter read to make here. Column C shows the clamp because it
          holds that page. */}
      <div className="shrink-0 border-b p-border px-5 py-1.5">
        <SwarmConfigDisclosure resolution={resolution} />
      </div>
      {/* Why this run reached nothing, above its tree rather than instead of it: a
          refused run still has a root and often has branches that failed for a
          reason worth reading. */}
      {refusal !== null && <RunRefusalNote refusal={refusal} />}
      {/* And for a run that has NOT reached nothing yet, what its nodes are doing.
          The full-screen view had the same silence as the surface: a `still
          running` chip in the footer and no statement of how many nodes were
          working or when anything last happened. */}
      {liveness !== null && <RunLivenessPanel live={liveness} running={run.status === "running"} />}
      {/* Canvas and transcript side by side WHERE THERE IS ROOM: the whole point
          of a full-screen explorer is room, and a selected node that only
          produced a one-line footer chip was the reason opening one told the
          reader nothing.

          Below `md` there is no room for both. The transcript was a hard 28rem
          `shrink-0`, so on a 640px screen it took 70% of the width and left the
          tree 190px — the surface's whole subject squeezed into a gutter. It
          stacks instead, bounded to just over half the height, and stays out of
          the way entirely until a node is opened. */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div ref={attach} className="flex-1 min-h-0 relative overflow-hidden p-surface">
          {tree && resource.status === "error" && (
            <LoadFailure what="the latest fork tree" message={resource.message} onRetry={reload}
              className="absolute z-10 left-4 right-4 top-4 p-surface border p-border rounded-md px-3 py-2" />
          )}
          {!tree ? (
            resource.status === "error" ? (
              <LoadFailure what="this search" message={resource.message} onRetry={reload} />
            ) : resource.status === "loading" ? (
              <div className="flex items-center justify-center h-full">
                <div className="flex items-center gap-2 text-sm p-text-2"><Loader size="sm" />Loading tree…</div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center">
                <EmptyState icon={<GitForkIcon size={28} />} title="Nothing recorded for this search"
                  hint="Neither store holds a row under this run's id." />
              </div>
            )
          ) : dims.w > 0 && dims.h > 0 ? (
            <SwarmTree
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
        <div className={`${selectedId === null ? "hidden md:flex" : "flex"} w-full max-h-[55%] shrink-0 flex-col min-h-0 border-t p-border p-2 md:h-auto md:max-h-none md:w-[28rem] md:border-t-0 md:border-l`}>
          <NodeTranscript
            selection={selection}
            trees={state.mctsTrees} rpc={state.rpc} headActivity={state.headActivity}
            onSelect={setSelectedId} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-2.5 border-t p-border">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
          <span className="p-text-2">Branches: <span className="p-text font-medium">{Math.max(0, (stats?.nodes ?? 1) - 1)}</span></span>
          <span className="p-text-2">Depth: <span className="p-text font-medium">{stats?.depth ?? 0}</span></span>
          {/* The resolution line is stated once, in the panel above the tree and on the
              band's own title. A third copy here disagreed with both: it fell back to
              the dispatch policy because it was never handed the resolution, so a swarm
              read `settle=mcts` under a panel that said what its axes resolved to. */}
          {winner?.value != null && (
            <span className="p-text-2">Winner: <span className="p-success font-medium">{formatScore(winner.value)}</span></span>
          )}
          {run.status === "running" && (
            <span className="flex items-center gap-1 p-warning">
              <span className="size-1.5 rounded-full bg-current p-dot-pulse" />still running
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
