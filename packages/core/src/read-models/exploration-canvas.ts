/**
 * The Exploration canvas, in one read.
 *
 * The surface used to fetch the fork list, then the selected run's tree, then
 * that run's detail — one request per thing on screen, each on its own
 * revalidation clock. That is why only one tree could ever be drawn: showing all
 * of a workspace's trees side by side would have meant N growing round trips,
 * and the list, the parameters and the trees could disagree about what exists.
 *
 * So the composition happens here, once, against one snapshot of the storage:
 * every recent fork, what each was dispatched with, and the rows for the trees
 * that keep theirs in `search_nodes`. Merged runs carry no rows on this path —
 * their branches are journalled, and `HeadJournal.listRuns` is that projection.
 */

import type { SqlExecutor } from '../types/primitives.js';
import type { SearchNode } from '../types/mcts.js';
import { listForkRuns, type ForkRunSummary } from './fork-runs.js';
import { readForkRunParams, type ForkRunParams } from './fork-params.js';
import { readSearchForest } from './search-tree.js';

export interface ExplorationCanvasView {
  /** Every recent fork, newest first, whichever settle policy it chose. */
  readonly runs: readonly ForkRunSummary[];
  /** Dispatch parameters per run. Absent for runs whose parameters are no longer
   *  recorded — the surface says so rather than showing invented defaults. */
  readonly params: readonly ForkRunParams[];
  /** Search nodes for every competed run, each row carrying the `root_id` that
   *  says which tree it belongs to. Fold per root, never across. */
  readonly search: readonly SearchNode[];
}

export function readExplorationCanvas(sql: SqlExecutor, limit = 30): ExplorationCanvasView {
  const runs = listForkRuns(sql, limit);
  return {
    runs,
    params: readForkRunParams(sql, runs.map((run) => run.id)),
    search: readSearchForest(sql, limit),
  };
}
