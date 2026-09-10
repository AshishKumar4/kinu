/**
 * The Exploration canvas, one page at a time.
 *
 * One request per thing on screen — the fork list, then the selected run's tree,
 * then that run's detail — each on its own revalidation clock, is what caps a
 * canvas at ONE tree: showing all of a workspace's trees side by side means N
 * growing round trips, and the list, the parameters and the trees can disagree
 * about what exists.
 *
 * So the composition happens here, once, against one snapshot of the storage.
 * And it composes into ONE ROW PER RUN rather than three parallel collections
 * the caller re-associates by id. That is not tidiness: separately bounded
 * collections, each with its own ordering key, disagree at the boundary — a
 * listed run with no tree drawn beside a tree for a run that was never listed.
 * Which runs exist is one fact, so it is stated once.
 *
 * The page is the run list's page. Every other field is derived from the runs on
 * it, so nothing here is bounded a second time and there is no second window to
 * disagree with — INCLUDING the journalled half. A run's journalled nodes are not
 * in `search_nodes`, and fetching them as a separately bounded `getHeadRuns`
 * read leaves page two's runs outside that window: they draw as "no branches
 * were ever written" while the journal holds them. Every half of a run arrives
 * on the page the run is on.
 */

import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { SearchNode } from '../types/mcts';
import { HeadJournal } from '../heads/journal';
import type { HeadRunView } from '../heads/types';
import { listForkRuns, readForkRun, type ForkRunSummary } from './fork-runs';
import { readForkRunParams, type ForkRunParams } from './fork-params';
import { readSearchTree } from './search-tree';
import { paretoFront, type ParetoAxis, type ParetoEvidence } from '../strategy/objective';
import { readSwarmNodeRecords } from '../strategy/swarm-resume';
import { mapPage, type Page, type SeekCursor } from './page';

/** One run on the canvas, with everything the canvas draws for it. */
export interface ExplorationCanvasRun {
  readonly run: ForkRunSummary;
  /** Null when this run's dispatch parameters are no longer recorded — the surface
   *  says so rather than showing plausible defaults. */
  readonly params: ForkRunParams | null;
  /** This run's tree, in the order {@link readSearchTree} delivers it. Non-empty
   *  exactly when {@link ForkRunSummary.hasSearchTree}. */
  readonly tree: readonly SearchNode[];
  /** This run's journalled nodes and their turns. Non-null exactly when
   *  {@link ForkRunSummary.hasNodeTranscripts}. */
  /** Null unless the run durably recorded complete Pareto evidence. */
  readonly frontier: ParetoFrontier | null;
  readonly head: HeadRunView | null;
}

/** Durable Pareto evidence, ordered by stable node id after nondominance filtering. */
export interface ParetoFrontier {
  readonly axes: readonly ParetoAxis[];
  readonly candidates: readonly {
    readonly nodeId: string;
    readonly evidence: ParetoEvidence;
  }[];
}

/** A page of the canvas. Thirty is the window the surface sizes its list for,
 *  so the first page is exactly that window. */
const DEFAULT_CANVAS_PAGE = 30;

/**
 * A page of runs, newest first, each with its parameters and every half it has.
 *
 * Newest-first in BOTH traversal and presentation, so a walker appends.
 */
export function readExplorationCanvas(
  sql: SqlExecutor,
  actor: ActorHandle,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_CANVAS_PAGE,
): Page<ExplorationCanvasRun> {
  return mapPage(listForkRuns(sql, actor, cursor, limit), (runs) => composeRuns(sql, actor, runs));
}

/**
 * ONE run by id, composed exactly as the page composes it — the permalink read.
 *
 * The same shape rather than a summary, because the drill-down that opens one run
 * is the surface with the most room to show what that run was dispatched with, and
 * parameters that travel only on the canvas page would make reading one run's
 * judge clamp mean fetching thirty runs and their trees to render one. Through
 * the same composer, so the two reads cannot come to disagree about one run.
 */
export function readExplorationRun(sql: SqlExecutor, actor: ActorHandle, rootId: string): ExplorationCanvasRun | null {
  const run = readForkRun(sql, actor, rootId);
  return run === null ? null : composeRuns(sql, actor, [run])[0] ?? null;
}

/** Both halves and the parameters of each named run, in one read per store. */
function composeRuns(
  sql: SqlExecutor,
  actor: ActorHandle,
  runs: readonly ForkRunSummary[],
): ExplorationCanvasRun[] {
  const params = new Map(
    readForkRunParams(sql, actor, runs.map((run) => run.id)).map((entry) => [entry.rootId, entry]),
  );
  const journal = new HeadJournal(sql, actor);
  return runs.map((run) => ({
    run,
    params: params.get(run.id) ?? null,
    // BOTH halves, because a run has whichever of them it wrote and a swarm whose
    // nodes are agents wrote both. Gated on the run's own facts rather than on a
    // settlement tag: the tag admitted one half per run, so the swarm's tree — four
    // rows and a winner — was dropped before the response was serialised, and no
    // client could recover what the server never sent.
    tree: run.hasSearchTree ? readSearchTree(sql, actor, run.id) : [],
    head: run.hasNodeTranscripts ? journal.readRun(run.id) : null,
    frontier: readParetoFrontier(sql, actor, run.id),
  }));
}


function readParetoFrontier(
  sql: SqlExecutor, actor: ActorHandle, rootId: string,
): ParetoFrontier | null {
  const table = sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'swarm_node_records'`;
  if (table.length === 0) return null;
  const candidates = readSwarmNodeRecords(sql, actor, rootId).flatMap(({ nodeId, record }) =>
    record.outcome?.kind === 'pareto'
      ? [{ nodeId, axes: record.outcome.axes, evidence: record.outcome.evidence }]
      : []);
  const axes = candidates[0]?.axes;
  if (!axes) return null;
  if (candidates.some((candidate) => JSON.stringify(candidate.axes) !== JSON.stringify(axes))) {
    return null;
  }
  return {
    axes,
    candidates: paretoFront(
      axes,
      candidates
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map(({ nodeId, evidence }) => ({ nodeId, evidence })),
    ),
  };
}