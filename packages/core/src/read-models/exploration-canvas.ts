/**
 * The Exploration canvas, one page at a time.
 *
 * The surface used to fetch the fork list, then the selected run's tree, then
 * that run's detail — one request per thing on screen, each on its own
 * revalidation clock. That is why only one tree could ever be drawn: showing all
 * of a workspace's trees side by side would have meant N growing round trips,
 * and the list, the parameters and the trees could disagree about what exists.
 *
 * So the composition happens here, once, against one snapshot of the storage.
 * And it composes into ONE ROW PER RUN rather than three parallel collections
 * the caller re-associates by id. That is not tidiness: the collections were
 * separately bounded, by different ordering keys, and at the boundary the canvas
 * drew a listed run with no tree beside a tree for a run it had not listed.
 * Three collections that have to agree about which runs exist is a fact that
 * can be stated twice, so it is now stated once.
 *
 * The page is the run list's page. Every other field is derived from the runs on
 * it, so nothing here is bounded a second time and there is no second window to
 * disagree with — INCLUDING the journalled half. A run's journalled nodes are not
 * in `search_nodes`, and the surface used to fetch them as a separately bounded
 * `getHeadRuns` read: page two of the canvas then held runs whose nodes were
 * outside that window, so they drew as "no branches were ever written" while the
 * journal held them. Every half of a run now arrives on the page the run is on.
 */

import type { SqlExecutor } from '../types/primitives';
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

/** A page of the canvas. Thirty is what the bare `LIMIT` was, kept so the first
 *  page is the window the surface already sized its list for. */
const DEFAULT_CANVAS_PAGE = 30;

/**
 * A page of runs, newest first, each with its parameters and every half it has.
 *
 * Newest-first in BOTH traversal and presentation, so a walker appends.
 */
export function readExplorationCanvas(
  sql: SqlExecutor,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_CANVAS_PAGE,
): Page<ExplorationCanvasRun> {
  return mapPage(listForkRuns(sql, cursor, limit), (runs) => composeRuns(sql, runs));
}

/**
 * ONE run by id, composed exactly as the page composes it — the permalink read.
 *
 * The same shape rather than a summary, because the drill-down that opens one run
 * is the surface with the most room to show what that run was dispatched with, and
 * the parameters used to travel only on the canvas page: reading one run's judge
 * clamp meant fetching thirty runs and their trees to render one. Through the same
 * composer, so the two reads cannot come to disagree about one run.
 */
export function readExplorationRun(sql: SqlExecutor, rootId: string): ExplorationCanvasRun | null {
  const run = readForkRun(sql, rootId);
  return run === null ? null : composeRuns(sql, [run])[0] ?? null;
}

/** Both halves and the parameters of each named run, in one read per store. */
function composeRuns(
  sql: SqlExecutor,
  runs: readonly ForkRunSummary[],
): ExplorationCanvasRun[] {
  const params = new Map(
    readForkRunParams(sql, runs.map((run) => run.id)).map((entry) => [entry.rootId, entry]),
  );
  const journal = new HeadJournal(sql);
  return runs.map((run) => ({
    run,
    params: params.get(run.id) ?? null,
    // BOTH halves, because a run has whichever of them it wrote and a swarm whose
    // nodes are agents wrote both. Gated on the run's own facts rather than on a
    // settlement tag: the tag admitted one half per run, so the swarm's tree — four
    // rows and a winner — was dropped before the response was serialised, and no
    // client could recover what the server never sent.
    tree: run.hasSearchTree ? readSearchTree(sql, run.id) : [],
    head: run.hasNodeTranscripts ? journal.readRun(run.id) : null,
    frontier: readParetoFrontier(sql, run.id),
  }));
}


function readParetoFrontier(sql: SqlExecutor, rootId: string): ParetoFrontier | null {
  const table = sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'swarm_node_records'`;
  if (table.length === 0) return null;
  const candidates = readSwarmNodeRecords(sql, rootId).flatMap(({ nodeId, record }) =>
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