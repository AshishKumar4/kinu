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
 * And it composes into ONE ROW PER FORK rather than three parallel collections
 * the caller re-associates by id. That is not tidiness: the collections were
 * separately bounded, by different ordering keys, and at the boundary the canvas
 * drew a listed fork with no tree beside a tree for a fork it had not listed.
 * Three collections that have to agree about which forks exist is a fact that
 * can be stated twice, so it is now stated once.
 *
 * The page is the fork list's page. Every other field is derived from the forks
 * on it, so nothing here is bounded a second time and there is no second window
 * to disagree with.
 */

import type { SqlExecutor } from '../types/primitives.js';
import type { SearchNode } from '../types/mcts.js';
import { listForkRuns, type ForkRunSummary } from './fork-runs.js';
import { readForkRunParams, type ForkRunParams } from './fork-params.js';
import { readSearchTree } from './search-tree.js';
import { mapPage, type Page, type SeekCursor } from './page.js';

/** One fork on the canvas, with everything the canvas draws for it. */
export interface ExplorationCanvasRun {
  readonly run: ForkRunSummary;
  /** Null when this fork's dispatch parameters are no longer recorded — the
   *  surface says so rather than showing plausible defaults. */
  readonly params: ForkRunParams | null;
  /** This fork's tree, in the order {@link readSearchTree} delivers it. Empty
   *  for a merged fork: its branches are journalled, not in `search_nodes`. */
  readonly tree: readonly SearchNode[];
}

/** A page of the canvas. Thirty is what the bare `LIMIT` was, kept so the first
 *  page is the window the surface already sized its list for. */
const DEFAULT_CANVAS_PAGE = 30;

/**
 * A page of forks, newest first, each with its parameters and its tree.
 *
 * Newest-first in BOTH traversal and presentation, so a walker appends.
 */
export function readExplorationCanvas(
  sql: SqlExecutor,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_CANVAS_PAGE,
): Page<ExplorationCanvasRun> {
  return mapPage(listForkRuns(sql, cursor, limit), (runs) => {
    const params = new Map(
      readForkRunParams(sql, runs.map((run) => run.id)).map((entry) => [entry.rootId, entry]),
    );
    return runs.map((run) => ({
      run,
      params: params.get(run.id) ?? null,
      tree: run.settle === 'competed' ? readSearchTree(sql, run.id) : [],
    }));
  });
}
