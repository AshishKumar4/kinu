/** The swarm frames: fork trees, runs in each state, the live and explorer views. */
import { useEffect, useMemo, useRef, useState } from "react";
import { answeringRpc, wireOf, type WorkspaceAnswers, type WorkspaceRpc } from "@/lib/workspace-rpc";
import type { ExplorationCanvasRun, ForkRunSummary } from "@kinu.run/core";
import { serveGalleryRpc } from "@/gallery-agent-stub";
import { FORK_PARAMS, MERGED_RUN, NOW } from "@/gallery-data";
import { CANVAS_ROWS, FORK_ANSWERS, GALLERY_ANSWERS, MCTS_ROWS, RUNNING_RUN, Shell, asSearchNode, explorationAnswers, routedPage, type MountedFrame } from "@/gallery-shared";
import { MCTS_TREES, forkRpc, framed, type FrameTable } from "@/gallery-shared";

/** The surface focuses `runs[0]`, so each frame puts its subject first, selected by root id rather than index. */
function focusRun(rootId: string, rows: readonly ExplorationCanvasRun[] = CANVAS_ROWS): WorkspaceAnswers {
  const wanted = rows.filter((entry) => entry.run.id === rootId);

  return { ...GALLERY_ANSWERS, ...explorationAnswers([...wanted, ...rows.filter((entry) => entry.run.id !== rootId)]) };
}

/** No search tree: a journalled run is a tree at depth 1, and every score encoding must be absent. */
const mergeFirstRpc = answeringRpc(focusRun(
  MERGED_RUN.rootId,
  CANVAS_ROWS.filter((entry) => entry.tree.length === 0),
));

/** `settle` is derived from two of the resolved axes, not chosen. */
const provePresetRpc = answeringRpc(focusRun("pv000"));

/** No named preset resolves to `expand:'aggregate'`, so this is a composition and its axes are not recoverable. */
const swarmFanInRpc = answeringRpc(focusRun("sw000"));

const refusedRunRpc = answeringRpc(focusRun("rf000"));

/** Focused; the settled runs stay listed beneath for comparison. */
const runningSwarmRpc = answeringRpc(focusRun("lv000"));

/** Must read *stopped*, never `running`; the word comes from `read-models/fork-runs.ts`. */
const stoppedRunRpc = answeringRpc(focusRun("root-merge-0"));

/** `head_activity` counters for the live run's working nodes; settled nodes announce nothing. */
const RUNNING_ACTIVITY: ReadonlyMap<string, number> = new Map(
  RUNNING_RUN.heads.filter((head) => head.status === "running").map((head) => [head.id, 3]),
);

/**
 * Five readable stages of a live search over the real 106-node fixture, revealed a prefix at a time.
 * `?stage=N` pins one so a gate need not race a clock; without it the frame advances itself.
 */
const LIVE_STAGE_ROWS = [0, 1, 4, 12, MCTS_ROWS.length] as const;

const LIVE_STAGES = LIVE_STAGE_ROWS.length;

/** The ledger row at `stage`; it decides whether the surface polls fast or idles. */
function liveRun(stage: number): ForkRunSummary {
  const rows = LIVE_STAGE_ROWS[Math.min(stage, LIVE_STAGES - 1)] ?? 0;
  const settled = stage >= LIVE_STAGES - 1;

  return {
    id: "live000",
    name: "/api/health 500s",
    task: "Find why /api/health 500s",
    startedAt: NOW - 3e4,
    status: settled ? "completed" : "running",
    hasSearchTree: true,
    hasNodeTranscripts: true,
    branches: Math.max(0, rows - 1),
    winnerScore: settled ? 0.91 : null,
  };
}

/** Stage 0 has no ledger row: working nodes must not read as absent work before the first canvas row lands. */
function liveCanvasRows(stage: number): readonly ExplorationCanvasRun[] {
  if (stage <= 0) return [];
  const rows = LIVE_STAGE_ROWS[Math.min(stage, LIVE_STAGES - 1)] ?? 0;

  return [{
    run: liveRun(stage),
    params: FORK_PARAMS.find((entry) => entry.rootId === "n000") ?? null,
    tree: MCTS_ROWS.slice(0, rows).map((row) => asSearchNode(row, "live000")),
    head: null,
    frontier: null,
  }];
}

/** One tick per node that has written to its journal; the newest read as working. */
function liveActivity(stage: number): ReadonlyMap<string, number> {
  const rows = LIVE_STAGE_ROWS[Math.min(stage, LIVE_STAGES - 1)] ?? 0;
  const ticks = new Map<string, number>();

  for (const row of MCTS_ROWS.slice(0, rows)) ticks.set(row.id, stage);

  return ticks;
}

/** Stable: `useAsyncResource` keys its load on the `rpc` identity, so the stage is read from a ref at call time. */
function liveRpcOver(stageRef: { readonly current: number }): WorkspaceRpc {
  return (method, args) => {
    const rows = liveCanvasRows(stageRef.current);

    return answeringRpc({ ...GALLERY_ANSWERS, ...explorationAnswers(rows), getSearchTree: () => [...rows[0]?.tree ?? []] })(method, args);
  };
}

/** Clamped; a missing or non-numeric `stage` pins nothing. */
function pinnedLiveStage(search: string): number | null {
  const asked = new URLSearchParams(search).get("stage");
  const wanted = asked === null ? Number.NaN : Number(asked);

  return Number.isFinite(wanted) ? Math.max(0, Math.min(LIVE_STAGES - 1, wanted)) : null;
}

function ForkLiveFrame({ pinned }: { pinned: number | null }) {
  const [stage, setStage] = useState(pinned ?? 0);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const rpc = useMemo(() => liveRpcOver(stageRef), []);
  const activity = useMemo(() => liveActivity(stage), [stage]);
  useEffect(() => {
    if (pinned !== null) return;

    const id = setInterval(
      () => setStage((current) => (current + 1) % LIVE_STAGES),
      1_800,
    );

    return () => clearInterval(id);
  }, [pinned]);

  return (
    <div data-live-stage={stage} className="contents">
      <Shell surface="Swarms" rpc={rpc} headActivity={activity} backgroundJobs={[]} />
    </div>
  );
}

/** Opened by the fixture, not a prop: the card ships shut, and `details` carries openness in the DOM. */
function OpenConfigDisclosures({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const card of document.querySelectorAll<HTMLDetailsElement>("details[data-swarm-config]")) {
        card.open = true;
      }
    }, 300);

    return () => { clearTimeout(timer); };
  }, []);

  return <>{children}</>;
}

/** The only dynamic import in this dispatch: the page pulls d3 and the tree renderer. It reads through `useKinu`, resolved to `gallery-agent-stub` here. */
async function mctsExplorerFrame(run: string | null): Promise<MountedFrame> {
  const { default: SwarmExplorer } = await import("@/pages/SwarmExplorer");
  serveGalleryRpc(wireOf(run === null ? FORK_ANSWERS : focusRun(run)));

  return routedPage(run === null ? "/swarm/api-worker" : `/swarm/api-worker?run=${run}`, "/swarm/:agentId", <SwarmExplorer />);
}

/** This module's frames, by `?frame=`: gallery.tsx mounts the one asked for. */
export const swarmFrames: FrameTable = {
  shell: () => framed(<Shell />),
  forks: () => framed(<Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={forkRpc} />),
  // Config disclosure open; the card ships shut, so there is no product prop for it.
  forkconfig: () => framed(<OpenConfigDisclosures><Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={forkRpc} /></OpenConfigDisclosures>),
  forkmerge: () => framed(<Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={mergeFirstRpc} />),
  forkpreset: () => framed(<Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={provePresetRpc} />),
  forkfanin: () => framed(<Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={swarmFanInRpc} />),
  forkrefused: () => framed(<Shell surface="Swarms" mctsTrees={MCTS_TREES} rpc={refusedRunRpc} />),
  forkstopped: () => framed(<Shell surface="Swarms" rpc={stoppedRunRpc} />),
  forkrunning: () => framed(<Shell surface="Swarms" rpc={runningSwarmRpc} headActivity={RUNNING_ACTIVITY} />),
  forklive: () => framed(<ForkLiveFrame pinned={pinnedLiveStage(location.search)} />),
  forkfull: () => mctsExplorerFrame("n000"),
  forkbig: () => mctsExplorerFrame("n000"),
  forkswarmfull: () => mctsExplorerFrame("sw000"),
  // `&run=` is the permalink's run, as any id the reader typed; none opens the newest.
  forkexplorer: () => mctsExplorerFrame(new URLSearchParams(location.search).get("run")),
};
