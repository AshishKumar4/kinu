/**
 * Exploration runs, as the surface reads them.
 *
 * Two jobs, both pure enough to test without a DOM:
 *
 *  1. **The adapters.** A search is a tree whatever its axes resolved to, so the
 *     two stores are folded into ONE node resolution here and the renderer never learns
 *     which store a tree came from. `search_nodes` is the tree the engine selected
 *     down; `head_journal` is one row per node, carrying the reason that node
 *     exists. An agent-unit search writes BOTH, so neither store is chosen by a
 *     tag — the search rows are the tree wherever there are any, and the journal
 *     answers the questions the rows cannot.
 *
 *  2. **The revalidation policy.** Nothing pushes either store to the client:
 *     both are written row by row as the search runs, and a view that loads once
 *     renders the first instant of it and then lies for the rest. An open tab
 *     always revalidates — fast while work is visibly live, at a slow keep-fresh
 *     cadence otherwise. Never zero: a search can start from a detached job, a
 *     drain or an autonomous turn, none of which stream through this tab's chat
 *     socket.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  ExplorationCanvasRun, ForkRunParams, ForkRunSummary, HeadRunView, Page, SeekCursor,
} from "@kinu.run/core";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { usePagedScroll } from "@/hooks/use-paged-scroll";
import { buildTree } from "@/lib/fork-tree-rows";
import type { BackgroundJob, ForkNode, Rpc } from "@/lib/protocol";
import { swarmResolutionOf, type SwarmResolution } from "./swarm-resolution";

export const FORK_RUN_LIMIT = 30;

/** One allocation for a caller with no activity channel — the CLI-facing reads
 *  and every test that only wants the polled halves. */
const EMPTY_ACTIVITY: ReadonlyMap<string, number> = new Map();

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

/**
 * Roots that just moved and whose movement the polled list cannot explain.
 *
 * The canvas draws its bands by walking the POLLED list and looking up each
 * run's tree, so a live tree or a live journal write for a root the list does not
 * carry draws nothing at all — and the list is on its idle clock exactly when
 * this matters, because a search it has never heard of and a search it believes
 * is over are both searches it has no reason to poll fast for.
 *
 * Two shapes, and the second is not about new searches. A root the list has
 * NEVER heard of is a new search. A root it holds in a state that is not
 * `running` is a search it believes is finished — which is what a RESUMED run
 * looks like the instant it re-enters, because a resume reuses its rootId and
 * flips a reclaimed row back to running.
 *
 * Sorted, so a caller can use the answer as a memo key and re-read once per
 * CHANGE of this set rather than once per journal write. `null` entries mean the
 * list has not loaded, and nothing is unexplained until there is an answer to
 * contradict.
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

/**
 * The single live run-list resource. `MCTSExplorer` drills into ONE run, so the
 * list is all it needs; the embedded canvas uses {@link useExplorationCanvas},
 * which also brings every tree, its journal and its params.
 *
 * `listForkRuns` is PAGED and takes a `PageRequest`. This read passed the limit as
 * a bare number and typed the answer as an array, which is two silent failures in
 * one line: `(30)?.limit` is undefined so the server answered its own default page
 * size and the requested thirty was discarded, and the `Page` that came back was
 * then handed to `runs?.some(...)` — a `Page` has no `some`, so the revalidation
 * clock threw on the first successful load against a real server. The gallery's
 * socket stub answered `[]` for every `get*`/`list*`, which is an array, so the
 * frames could not see it.
 */
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
  /** Per-branch write counters from the `head_activity` broadcast. Read here
   *  only as a SIGNAL that some search moved — the rows come from the read
   *  below, never from the wire. */
  headActivity: ReadonlyMap<string, number> = EMPTY_ACTIVITY,
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

  /** Every search's tree. The search rows are the tree wherever the engine wrote
   *  any; the journal's depth-1 projection stands in only for a run that has no
   *  search rows at all. Never chosen by a settle tag: an agent-unit swarm writes
   *  BOTH stores, so a tag that admits one store per run cannot decide this. */
  const trees = useMemo(() => {
    const folded = new Map<string, ForkNode>();
    for (const entry of entries ?? []) {
      if (entry.tree.length > 0) folded.set(entry.run.id, buildTree([...entry.tree]));
      else if (entry.head !== null) folded.set(entry.run.id, headRunToTree(entry.head));
    }
    for (const [rootId, tree] of liveTrees) folded.set(rootId, tree);
    return folded;
  }, [entries, liveTrees]);

  /**
   * A search moved in a way the list cannot explain, so read it again NOW rather
   * than waiting out the idle clock. Measured on the live frame: 13.2 seconds
   * from the ledger gaining the row to the row appearing, against a 1.5s budget.
   *
   * Keyed on the SET, so this fires once per change of it rather than once per
   * step — a run the list already holds AS RUNNING is not news, and re-reading
   * per journal write would be a poll storm dressed as a push.
   */
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

  const params = useMemo(() => {
    const byRoot = new Map<string, ForkRunParams>();
    for (const entry of entries ?? []) {
      if (entry.params) byRoot.set(entry.run.id, entry.params);
    }
    return byRoot;
  }, [entries]);

  /** Each search's per-node journal — the only record of why any individual node
   *  exists, and therefore of which of them fanned a level in. */
  const journals = useMemo(() => {
    const byRoot = new Map<string, HeadRunView>();
    for (const entry of entries ?? []) {
      if (entry.head !== null) byRoot.set(entry.run.id, entry.head);
    }
    return byRoot;
  }, [entries]);

  /**
   * Each search's resolved resolution — the preset it resolved and the tuple it resolved
   * to. Derived ONCE here rather than per surface, so the canvas, the run list and
   * the full-screen explorer cannot come to disagree about what a run's axes were.
   *
   * Read only for a run that has BOTH halves, and the gate is load-bearing rather
   * than defensive. `head_runs.rationale` holds two different things: for a search
   * it is `resolved.label ?? resolved.preset`, and for a pre-swarm branching-heads
   * run it is the author's prose "why split". A run with a journal and no search
   * rows is the second kind, and reading its prose as a composition's label
   * rendered `custom "Three call sites, three readers — cheaper in parallel than in
   * sequence."` over a run that was never a search. Only a search writes both
   * stores, so holding both IS the discriminator.
   */
  const resolutions = useMemo(() => {
    const byRoot = new Map<string, SwarmResolution>();
    for (const entry of entries ?? []) {
      if (entry.head === null || entry.tree.length === 0) continue;
      const resolution = swarmResolutionOf(entry.head.rationale);
      if (resolution !== null) byRoot.set(entry.run.id, resolution);
    }
    return byRoot;
  }, [entries]);

  return {
    resource, reload, hasActiveWork, trees, params, journals, resolutions,
    runs: entries === null ? null : entries.map((entry) => entry.run),
    /** A first page that already said 'end' is exhausted before the pager runs,
     *  and the pager has no way to know that. Never set by a failure. */
    exhausted: first !== null && (first.status === "end" || tail.exhausted),
    loadingMore: tail.loading,
    pageError: tail.error,
    loadMore: tail.loadMore,
  };
}

/**
 * One permalink target, independent of the bounded recent-run list.
 *
 * The same composed row the canvas pages, so the drill-down can read the run's own
 * dispatch parameters without fetching a page of thirty runs and their trees.
 */
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
 * Which half of the run the surface leads with, by the name of the store that holds
 * it: `search` for a run with a tree, `transcripts` for one with journalled nodes
 * only.
 *
 * A run is no longer one of two dispatch policies — a swarm whose nodes are agents has
 * BOTH halves — so this names what the run leads with rather than what it "was". The
 * recovered parameters answer it where they survive; the run's own facts answer it
 * where they do not.
 */
export function settlePolicyOf(run: ForkRunSummary, params: ForkRunParams | undefined): string {
  const hasSearch = params ? params.search !== null : run.hasSearchTree;
  return hasSearch ? "search" : "transcripts";
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
 * Per half, and BOTH halves where the run has both: a search has an expansion budget,
 * a branching factor, a depth cap and the exploration constant it selected with, while
 * journalled nodes have a strategy label and a count. Nulls are dropped rather than
 * rendered as "—": an unrecorded knob and a knob left at its default are different
 * facts, and only the first is knowable here.
 */
export function forkParamRows(params: ForkRunParams | undefined): ForkParamRow[] {
  if (!params) return [];
  const rows: ForkParamRow[] = [];
  const search = params.search;
  if (search !== null) {
    rows.push({ label: "budget", value: `${search.budget} expansions` });
    rows.push({ label: "branches", value: String(search.branches) });
    if (search.maxDepth !== null) rows.push({ label: "max depth", value: String(search.maxDepth) });
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
 * The judge ensemble a run ASKED for and the one it ran, as one phrase.
 *
 * Realised first, and the word "requested" wherever the realised size is not known
 * to equal it. Rendering the request as a per-branch figure is the original defect:
 * a run that asked for twenty and ran three read as one that ran twenty, and a run
 * whose ensemble was never observed read the same way. The two numbers are not
 * independent knobs — `judgeSamples` shares one per-evaluation call pool with check
 * generation, so a code-bearing branch realises `min(samples, maxEvalLLMCalls − 1)`
 * — and a clamp binding in silence is the defect class this repository keeps
 * fixing.
 *
 * ONE definition, because it is read in two places: the dispatch parameter strip,
 * and the resolved-resolution panel beside a search's axes. Null when the run named no
 * ensemble at all, which is every run that scored by anything other than a judge.
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
