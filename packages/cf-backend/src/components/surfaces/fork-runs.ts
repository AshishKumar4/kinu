/**
 * Fork runs, as the Exploration surface reads them.
 *
 * Two jobs, both pure enough to test without a DOM:
 *
 *  1. **The adapters.** A fork is a tree whichever way it settled, so the two
 *     stores are folded into ONE node shape here and the renderer never learns
 *     which store a tree came from. A merge is that tree at depth 1 — the
 *     split's task at the root, one head per child; a competition is the same
 *     tree deeper, carrying scores and rollouts the merge simply does not have.
 *
 *  2. **The revalidation policy.** Nothing pushes either store to the client:
 *     both are written row by row as the fork runs, and a view that loads once
 *     renders the first instant of a split and then lies for the rest of it.
 *     An open tab always revalidates — fast while work is visibly live, at a
 *     slow keep-fresh cadence otherwise. Never zero: a split can start from a
 *     detached job, a drain or an autonomous turn, none of which stream
 *     through this tab's chat socket.
 */
import { useCallback, useMemo } from "react";
import type {
  ExplorationCanvasRun, ForkRunParams, ForkRunSummary, HeadRunView, Page, SeekCursor,
} from "@proteus/core";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { buildTree } from "@/lib/fork-tree-rows";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";

export const FORK_RUN_LIMIT = 30;

/** Matches the run timeline's mid-turn cadence: fast enough to read as live,
 *  slow enough that a long fork is not a poll storm. */
export const FORK_REVALIDATE_MS = 1500;

/** The idle cadence: one cheap RPC while the tab is actually open — the price
 *  of never again showing a settled snapshot as if it were the present. */
export const FORK_IDLE_REVALIDATE_MS = 15_000;

/** A fork is still being written until it leaves `running` — branches, scores,
 *  token counts and the merge all land while it is. */
export function hasLiveForkRun(runs: readonly ForkRunSummary[] | null): boolean {
  return !!runs?.some((run) => run.status === "running");
}

/** All workspace activity that can create or continue a fork. Detached jobs
 * do not stream through the chat connection, so they must count independently. */
export function hasActiveForkWork(
  isStreaming: boolean,
  backgroundJobs: readonly BackgroundJob[],
): boolean {
  return isStreaming || backgroundJobs.some((job) => job.status === "running");
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

/**
 * How long before the fork list re-reads.
 *
 * `hasActiveWork` is everything the workspace can see in flight — a streaming
 * chat turn or a running background job. Either counts even with nothing
 * loaded yet: a fork can start at any step, and the run that appears is
 * exactly what the operator opened the tab for.
 */
export function forkRunsRevalidateMs(
  runs: readonly ForkRunSummary[] | null,
  hasActiveWork: boolean,
): number {
  return hasActiveWork || hasLiveForkRun(runs) ? FORK_REVALIDATE_MS : FORK_IDLE_REVALIDATE_MS;
}

/** The single live fork-list resource. `MCTSExplorer` drills into ONE run, so
 *  the list is all it needs; the embedded canvas uses
 *  {@link useExplorationCanvas}, which also brings every tree and its params. */
export function useLiveForkRuns(
  rpc: Rpc,
  isStreaming: boolean,
  backgroundJobs: readonly BackgroundJob[],
) {
  const hasActiveWork = hasActiveForkWork(isStreaming, backgroundJobs);
  const load = useCallback(
    () => rpc<ForkRunSummary[]>("listForkRuns", [FORK_RUN_LIMIT]),
    [rpc],
  );
  const revalidate = useCallback(
    (runs: ForkRunSummary[] | null) => forkRunsRevalidateMs(runs, hasActiveWork),
    [hasActiveWork],
  );
  const { resource, reload } = useAsyncResource(load, revalidate);
  return { resource, reload, runs: lastValue(resource), hasActiveWork };
}

/**
 * Every tree the workspace has grown, on one canvas — one read per page.
 *
 * Each fork arrives WITH its own dispatch parameters and BOTH halves of its own
 * branches — the search rows of a competition, the journalled heads of a merge —
 * so the canvas cannot draw a tree for a fork the list does not have, label a
 * fork with another's parameters, or show a merged fork as empty because its
 * branches were in a separately bounded read. All of that used to arrive as
 * parallel collections re-associated here by root id, bounded separately, which
 * is exactly how the canvas came to draw a listed fork with no tree beside a
 * tree for a fork it had not listed.
 *
 * `liveTrees` are the socket-fed trees, keyed by search, and they WIN over both
 * polled projections for the searches they cover: a running search pushes a tree
 * per iteration, which no poll can match.
 */
export function useExplorationCanvas(
  rpc: Rpc,
  isStreaming: boolean,
  backgroundJobs: readonly BackgroundJob[],
  liveTrees: ReadonlyMap<string, ForkNode>,
) {
  const hasActiveWork = hasActiveForkWork(isStreaming, backgroundJobs);
  // One read per page, both halves of every fork on it. The canvas draws EVERY
  // fork, and a merged fork keeps its branches in the journal rather than in
  // `search_nodes`, so the missing half used to be fetched separately — per band
  // (N requests growing with the workspace's history), then as one bounded
  // `getHeadRuns` beside a paginated list, which left page two's merged forks
  // outside the window. `readExplorationCanvas` carries both.
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
    (cursor: SeekCursor) =>
      rpc<Page<ExplorationCanvasRun>>("getExplorationCanvas", [{ cursor, limit: FORK_RUN_LIMIT }]),
    [rpc],
  );
  // The first page's own `next`. This read's anchor is composite and opaque —
  // only the read model knows how to spell it — so it is never built here.
  const startFrom = useCallback(
    () => (first !== null && first.status === "more" ? first.next : null),
    [first],
  );
  const tail = usePagedScroll<ExplorationCanvasRun>({ grows: "down", fetchPage, startFrom });

  /**
   * The first page keeps revalidating while work is live, so a fork that starts
   * mid-scroll pushes the page-1 boundary down over a row the pager already
   * holds. Deduped by fork id, first occurrence winning, so the live page stays
   * authoritative for the rows it covers.
   */
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

  /** Every fork's tree, whichever store recorded it. */
  const trees = useMemo(() => {
    const folded = new Map<string, ForkNode>();
    for (const entry of entries ?? []) {
      if (entry.tree.length > 0) folded.set(entry.run.id, buildTree([...entry.tree]));
      else if (entry.head !== null) folded.set(entry.run.id, headRunToTree(entry.head));
    }
    for (const [rootId, tree] of liveTrees) folded.set(rootId, tree);
    return folded;
  }, [entries, liveTrees]);

  const params = useMemo(() => {
    const byRoot = new Map<string, ForkRunParams>();
    for (const entry of entries ?? []) {
      if (entry.params) byRoot.set(entry.run.id, entry.params);
    }
    return byRoot;
  }, [entries]);

  return {
    resource, reload, hasActiveWork, trees, params,
    runs: entries === null ? null : entries.map((entry) => entry.run),
    /** A first page that already said 'end' is exhausted before the pager runs,
     *  and the pager has no way to know that. Never set by a failure. */
    exhausted: first !== null && (first.status === "end" || tail.exhausted),
    loadingMore: tail.loading,
    pageError: tail.error,
    loadMore: tail.loadMore,
  };
}

/** One permalink target, independent of the bounded recent-fork list. */
export function useExactForkRun(
  rpc: Rpc,
  requestedId: string | null,
  hasActiveWork: boolean,
) {
  const load = useCallback(
    () => requestedId === null
      ? Promise.resolve<ForkRunSummary | null>(null)
      : rpc<ForkRunSummary | null>("getForkRun", [requestedId]),
    [requestedId, rpc],
  );
  const revalidate = useCallback(
    (run: ForkRunSummary | null) => requestedId === null
      ? null
      : forkRunsRevalidateMs(run === null ? null : [run], hasActiveWork),
    [hasActiveWork, requestedId],
  );
  const { resource, reload } = useAsyncResource<ForkRunSummary | null>(
    load,
    revalidate,
    requestedId ?? undefined,
  );
  return { resource, reload, run: lastValue(resource) };
}

/**
 * A head's lifecycle in the tree's own vocabulary.
 *
 * Never `terminal`: that state means "the branch the fork settled on", and a
 * merge settles on all of them at once. Claiming a winner here would be the
 * one thing this unification must not do.
 */
function headStatus(status: string): ForkNode["status"] {
  if (status === "running") return "running";
  return status === "completed" ? "open" : "failed";
}

/**
 * One merged fork as a depth-1 tree.
 *
 * `value` and `visits` are null throughout, deliberately: a merge ranks
 * nothing and rolls nothing out, and the renderer drops every encoding that
 * would otherwise be drawn from a zero no head earned.
 */
export function headRunToTree(run: HeadRunView): ForkNode {
  return {
    id: run.rootId,
    parentId: null,
    depth: 0,
    value: null,
    visits: null,
    status: run.status === "running" ? "running" : "open",
    action: run.task || run.rationale || "(fork)",
    task: run.task,
    observation: run.merge?.narrative ?? run.rationale,
    children: run.heads.map((head) => ({
      id: head.id,
      parentId: run.rootId,
      depth: 1,
      value: null,
      visits: null,
      status: headStatus(head.status),
      action: head.task,
      task: head.task,
      observation: head.summary ?? head.errorMessage ?? "",
      children: [],
    })),
  };
}

/* ── what the run was dispatched with ──────────────────────────── */

/**
 * The policy the run was dispatched under, by the name the store recorded it
 * with: `mcts` for a search, `merge` for a fork.
 *
 * `ForkRunSummary.settle` is `competed`/`merged`, which is the OUTCOME — what
 * happened to the branches. The surface showed only that, so a reader could not
 * tell which policy had been asked for, and the two are not interchangeable: one
 * ranks its branches by execution and keeps a winner, the other synthesises all
 * of them and ranks nothing. Recovered parameters carry the policy verbatim;
 * without them the outcome still determines it, because only mcts competes.
 */
export function settlePolicyOf(run: ForkRunSummary, params: ForkRunParams | undefined): string {
  return params?.policy ?? (run.settle === "competed" ? "mcts" : "merge");
}

/** One parameter as a label and a value. Empty when the run's parameters are no
 *  longer recorded — the caller says so rather than showing plausible defaults. */
export interface ForkParamRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The parameters the run was dispatched with, in the order they matter.
 *
 * Per policy, because these are genuinely different objects. A search has an
 * iteration budget, a branching factor, a depth cap and the exploration constant
 * it selected with; a merge has a merge strategy and a head count and no budget
 * at all. Nulls are dropped rather than rendered as "—": an unrecorded knob and
 * a knob left at its default are different facts, and only the first is knowable
 * here.
 */
export function forkParamRows(params: ForkRunParams | undefined): ForkParamRow[] {
  if (!params) return [];
  if (params.policy === "merge") {
    return [
      { label: "merge", value: params.mergeStrategy },
      { label: "forks", value: String(params.branches) },
    ];
  }
  const rows: ForkParamRow[] = [
    { label: "budget", value: `${params.budget} iterations` },
    { label: "branches", value: String(params.branches) },
  ];
  if (params.maxDepth !== null) rows.push({ label: "max depth", value: String(params.maxDepth) });
  if (params.explorationWeight !== null) {
    rows.push({ label: "exploration c", value: params.explorationWeight.toFixed(2) });
  }
  if (params.judgeSamplesRequested !== null) {
    // Realised first, and the word "requested" wherever the realised size is not
    // known to equal it. Rendering the request as a per-branch figure is the
    // original defect: a run that asked for 20 and ran 3 read as one that ran 20,
    // and a run whose call budget was never recorded reads the same way.
    const realised = params.judgeSamplesRealised;
    const requested = params.judgeSamplesRequested;
    rows.push({
      label: "judges",
      value: realised === null
        ? `${requested} requested`
        : realised < requested
          ? `${realised} of ${requested} requested`
          : `${realised} per branch`,
    });
  }
  if (params.mode !== null) rows.push({ label: "mode", value: params.mode });
  return rows;
}
