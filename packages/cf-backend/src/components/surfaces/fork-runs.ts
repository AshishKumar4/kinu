/**
 * Both stores (`search_nodes`, `head_journal`) fold into one node resolution; an agent-unit search writes both.
 * An open tab always revalidates: a search can start from a detached job that never streams through this socket.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  ExplorationCanvasRun, ForkRunParams, ForkRunSummary, Page, SeekCursor,
} from "@kinu.run/core";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { explorationForkTree, swarmResolutionOf } from "@kinu.run/core";
import type { ForkNode, Rpc } from "@kinu.run/core";
import type { BackgroundJob } from "@kinu.run/core/protocol";

export type ExplorationFrontier = NonNullable<ExplorationCanvasRun["frontier"]>;

const FORK_RUN_LIMIT = 30;

const EMPTY_ACTIVITY: ReadonlyMap<string, number> = new Map();

/** A null pick means the entry carries no such half and reads as absence. */
function canvasIndex<T>(
  entries: readonly ExplorationCanvasRun[] | null,
  pick: (entry: ExplorationCanvasRun) => T | null,
): ReadonlyMap<string, T> {
  const byRoot = new Map<string, T>();

  for (const entry of entries ?? []) {
    const value = pick(entry);

    if (value !== null) byRoot.set(entry.run.id, value);
  }

  return byRoot;
}

export const FORK_REVALIDATE_MS = 1500;

export const FORK_IDLE_REVALIDATE_MS = 15_000;

export function hasLiveForkRun(runs: readonly ForkRunSummary[] | null): boolean {
  return runs?.some((run) => run.status === "running") === true;
}

/** Detached jobs do not stream through the chat connection, so they count independently. */
export function hasActiveForkWork(
  isStreaming: boolean,
  backgroundJobs: readonly BackgroundJob[],
): boolean {
  return isStreaming || backgroundJobs.some((job) => job.status === "running");
}

/**
 * Roots the polled list cannot explain: never listed (a new search) or listed as not running (a resume reuses its rootId).
 * Sorted for use as a memo key; `null` entries mean the list has not loaded.
 */
export function unexplainedForkRoots(
  entries: readonly ExplorationCanvasRun[] | null,
  moved: Iterable<string>,
): readonly string[] {
  if (entries === null) return [];

  const live = new Set(entries
    .filter((entry) => entry.run.status === "running")
    .map((entry) => entry.run.id));

  return [...new Set(moved)].filter((rootId) => !live.has(rootId)).sort();
}

/** An explicit permalink never falls through to a different run. */
export function selectForkRun(
  runs: readonly ForkRunSummary[] | null,
  requestedId: string | null,
): ForkRunSummary | null {
  if (runs === null) return null;

  if (requestedId !== null) return runs.find((run) => run.id === requestedId) ?? null;

  return runs[0] ?? null;
}

export function forkRunsRevalidateMs(
  runs: readonly ForkRunSummary[] | null,
  hasActiveWork: boolean,
): number {
  return hasActiveWork || hasLiveForkRun(runs) ? FORK_REVALIDATE_MS : FORK_IDLE_REVALIDATE_MS;
}

export function useLiveForkRuns(
  rpc: Rpc,
  isStreaming: boolean,
  backgroundJobs: readonly BackgroundJob[],
) {
  const hasActiveWork = hasActiveForkWork(isStreaming, backgroundJobs);

  const load = useCallback(
    () => rpc<Page<ForkRunSummary>>("listForkRuns", [{ limit: FORK_RUN_LIMIT }]),
    [rpc],
  );

  const revalidate = useCallback(
    (page: Page<ForkRunSummary> | null) =>
      forkRunsRevalidateMs(page === null ? null : page.items, hasActiveWork),
    [hasActiveWork],
  );

  const { resource, reload } = useAsyncResource(load, revalidate);

  return { resource, reload, runs: lastValue(resource)?.items ?? null, hasActiveWork };
}

export interface ExplorationCanvasInput {
  rpc: Rpc;
  isStreaming: boolean;
  backgroundJobs: readonly BackgroundJob[];
  liveTrees: ReadonlyMap<string, ForkNode>;
  /** Read only as a signal that some search moved; rows come from the read, never the wire. */
  headActivity?: ReadonlyMap<string, number>;
}

/**
 * Each fork arrives with its own params and both halves of its branches in one read.
 * `liveTrees` win over polled projections for the searches they cover.
 */
export function useExplorationCanvas({
  rpc, isStreaming, backgroundJobs, liveTrees, headActivity = EMPTY_ACTIVITY,
}: ExplorationCanvasInput) {
  const hasActiveWork = hasActiveForkWork(isStreaming, backgroundJobs);

  // `readExplorationCanvas` carries both halves per page; fetching the journal
  // separately leaves page two's merged forks outside the window.
  const load = useCallback(
    () => rpc<Page<ExplorationCanvasRun>>("getExplorationCanvas", [{ limit: FORK_RUN_LIMIT }]),
    [rpc],
  );

  const revalidate = useCallback(
    (page: Page<ExplorationCanvasRun> | null) =>
      forkRunsRevalidateMs(page === null ? null : page.items.map((entry) => entry.run), hasActiveWork),
    [hasActiveWork],
  );

  const { resource, reload } = useAsyncResource(load, revalidate);
  const first = lastValue(resource);

  const fetchPage = useCallback(
    (cursor: SeekCursor | undefined) =>
      rpc<Page<ExplorationCanvasRun>>("getExplorationCanvas", [{ cursor, limit: FORK_RUN_LIMIT }]),
    [rpc],
  );

  // The anchor is composite and opaque; only the read model builds it.
  const startFrom = useCallback(
    () => (first !== null && first.status === "more" ? first.next : null),
    [first],
  );

  const tail = usePagedScroll<ExplorationCanvasRun>({ grows: "down", fetchPage, startFrom });

  /** Live page 1 can push rows down over ones the pager holds; dedupe by fork id, first wins. */
  const entries = useMemo(() => {
    if (first === null) return null;
    const seen = new Set<string>();
    const rows: ExplorationCanvasRun[] = [];

    for (const entry of [...first.items, ...tail.fetched]) {
      if (seen.has(entry.run.id)) continue;
      seen.add(entry.run.id);
      rows.push(entry);
    }

    return rows;
  }, [first, tail.fetched]);

  /** Fold both stores: an agent-unit swarm writes both, so reading one drops nodes. */
  const trees = useMemo(() => {
    const folded = new Map<string, ForkNode>();

    for (const entry of entries ?? []) {
      const tree = explorationForkTree(entry);

      if (tree !== null) folded.set(entry.run.id, tree);
    }

    for (const [rootId, tree] of liveTrees) folded.set(rootId, tree);

    return folded;
  }, [entries, liveTrees]);

  /** Re-read immediately when the unexplained set changes, not per journal write. */
  const unexplained = useMemo(
    () => unexplainedForkRoots(
      entries,
      [...liveTrees.keys(), ...headActivity.keys()],
    ).join("\u0000"),
    [entries, liveTrees, headActivity],
  );

  const reloadedFor = useRef("");
  useEffect(() => {
    if (unexplained === "" || reloadedFor.current === unexplained) return;
    reloadedFor.current = unexplained;
    reload();
  }, [unexplained, reload]);

  const params = useMemo(
    () => canvasIndex(entries, (entry) => entry.params),
    [entries],
  );

  /** Absent for runs that settled to one number; only `advance:'pareto'` writes a frontier. */
  const frontiers = useMemo(
    () => canvasIndex(entries, (entry) => entry.frontier),
    [entries],
  );

  const journals = useMemo(
    () => canvasIndex(entries, (entry) => entry.head),
    [entries],
  );

  /**
   * Read only for runs with both halves: for a pre-swarm branching-heads run,
   * `head_runs.rationale` is prose, not a composition label.
   */
  const resolutions = useMemo(
    () => canvasIndex(entries, (entry) =>
      entry.head === null || entry.tree.length === 0
        ? null
        : swarmResolutionOf(entry.head.rationale)),
    [entries],
  );

  return {
    resource, reload, hasActiveWork, trees, params, journals, resolutions, frontiers,
    runs: entries === null ? null : entries.map((entry) => entry.run),
    /** A first page that said 'end' is exhausted before the pager runs. */
    exhausted: first !== null && (first.status === "end" || tail.exhausted),
    loadingMore: tail.loading,
    pageError: tail.error,
    loadMore: tail.loadMore,
  };
}

export function useExactForkRun(
  rpc: Rpc,
  requestedId: string | null,
  hasActiveWork: boolean,
) {
  const load = useCallback(
    () => requestedId === null
      ? Promise.resolve<ExplorationCanvasRun | null>(null)
      : rpc<ExplorationCanvasRun | null>("getForkRun", [requestedId]),
    [requestedId, rpc],
  );

  const revalidate = useCallback(
    (entry: ExplorationCanvasRun | null) => requestedId === null
      ? null
      : forkRunsRevalidateMs(entry === null ? null : [entry.run], hasActiveWork),
    [hasActiveWork, requestedId],
  );

  const { resource, reload } = useAsyncResource<ExplorationCanvasRun | null>(
    load,
    revalidate,
    requestedId ?? undefined,
  );

  const entry = lastValue(resource);

  return { resource, reload, run: entry?.run ?? null, entry };
}

/** Empty when parameters are no longer recorded; callers say so rather than show defaults. */
export interface ForkParamRow {
  readonly label: string;
  readonly value: string;
}

/** Nulls are dropped: an unrecorded knob and a knob left at its default are different facts. */
export function forkParamRows(params: ForkRunParams | undefined): ForkParamRow[] {
  if (!params) return [];
  const rows: ForkParamRow[] = [];
  const search = params.search;

  if (search !== null) {
    rows.push({ label: "budget", value: `${search.budget} expansions` });
    rows.push({ label: "branches", value: String(search.branches) });

    // A depth cap of one means "flat", which the resolution panel shows as a shape.
    if (search.maxDepth !== null && search.maxDepth > 1) {
      rows.push({ label: "max depth", value: String(search.maxDepth) });
    }

    if (search.explorationWeight !== null) {
      rows.push({ label: "exploration c", value: search.explorationWeight.toFixed(2) });
    }

    const judges = judgeEnsembleLabel(params);

    if (judges !== null) rows.push({ label: "judges", value: judges });

    if (search.mode !== null) rows.push({ label: "mode", value: search.mode });
  }

  if (params.transcripts !== null) {
    rows.push({ label: "journalled", value: params.transcripts.mergeStrategy });
    rows.push({ label: "nodes", value: String(params.transcripts.branches) });
  }

  return rows;
}

/**
 * Realised size first; "requested" wherever the realised size is unknown. `judgeSamples` shares the
 * per-evaluation call pool with check generation, so it realises `min(samples, maxEvalLLMCalls − 1)`.
 */
export function judgeEnsembleLabel(params: ForkRunParams | undefined): string | null {
  const search = params?.search;

  if (search === undefined || search === null) return null;
  const requested = search.judgeSamplesRequested;

  if (requested === null) return null;
  const realised = search.judgeSamplesRealised;

  if (realised === null) return `${requested} requested`;

  return realised < requested ? `${realised} of ${requested} requested` : `${realised} per branch`;
}
