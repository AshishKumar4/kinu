/**
 * The Exploration canvas: one page of runs, one row per run, composed from one storage snapshot. Every
 * field derives from the runs on the page (journalled nodes included), so no second window disagrees.
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
import { mapPage, type Page, type SeekCursor } from '../session/page';

export interface ExplorationCanvasRun {
  readonly run: ForkRunSummary;
  /** Null when dispatch parameters are no longer recorded; the surface says so rather than showing defaults. */
  readonly params: ForkRunParams | null;
  /** Non-empty exactly when {@link ForkRunSummary.hasSearchTree}. */
  readonly tree: readonly SearchNode[];
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

const DEFAULT_CANVAS_PAGE = 30;

/** Newest first in traversal and presentation, so a walker appends. */
export function readExplorationCanvas(
  sql: SqlExecutor,
  actor: ActorHandle,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_CANVAS_PAGE,
): Page<ExplorationCanvasRun> {
  return mapPage(listForkRuns(sql, actor, cursor, limit), (runs) => composeRuns(sql, actor, runs));
}

/** One run by id (the permalink read), through the same composer so the two reads cannot disagree. */
export function readExplorationRun(sql: SqlExecutor, actor: ActorHandle, rootId: string): ExplorationCanvasRun | null {
  const run = readForkRun(sql, actor, rootId);

  return run === null ? null : composeRuns(sql, actor, [run])[0] ?? null;
}

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
    // Both halves: a swarm whose nodes are agents wrote both. Gated on the run's own facts.
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