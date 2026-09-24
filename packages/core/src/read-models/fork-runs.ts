/**
 * Exploration runs: one chronological list of every search this workspace has run.
 *
 * One root id is one run. A run may write the search tree (`search_nodes`), node transcripts
 * (`head_journal` / `head_runs`), or both (a swarm whose unit is an agent); each half is an
 * independent flag on one row, and paging is over runs, never over either store.
 * Steer-as-Branch runs are excluded by `STEER_BRANCH_RUN_ID_PREFIX`.
 */

import type { SqlExecutor } from '../types/primitives';
import { boundedInt } from '../utils/bounds';
import { seekPage, StaleCursorError, type Page, type SeekCursor } from '../session/page';
import { STEER_BRANCH_RUN_ID_PREFIX } from '../steer-branch';
import type { ActorHandle } from '../identity/actor-handle';

/** `partial`: stopped without a settled answer. */
export type ForkRunStatus = 'running' | 'completed' | 'failed' | 'partial';

export interface ForkRunSummary {
  /** The run's `root_id`; exactly one summary exists per root id. */
  readonly id: string;
  readonly task: string;
  /** The root's own label when its engine wrote one, else derived from the task. */
  readonly name: string;
  /** The first write of either half. */
  readonly startedAt: number;
  readonly status: ForkRunStatus;
  readonly hasSearchTree: boolean;
  readonly hasNodeTranscripts: boolean;
  /** The tree's branch count where there is a tree (every branch gets a row there); else the
   *  journalled count. */
  readonly branches: number;
  /** The terminal node's own score in [0,1], the `winnerValue` `converge` reported; null without a
   *  tree, a terminal node or a score. */
  readonly winnerScore: number | null;
}

const DEFAULT_FORK_PAGE = 20;

const MAX_FORK_PAGE = 200;

/**
 * A page of exploration runs, newest first.
 *
 * The bound applies to the union of root ids, ordered `(startedAt DESC, id DESC)`, and each half
 * is read for those roots; bounding the halves separately tears runs at the page boundary.
 */
export function listForkRuns(
  sql: SqlExecutor,
  actor: ActorHandle,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_FORK_PAGE,
): Page<ForkRunSummary> {
  actor.assertCurrent();
  const page = boundedInt(limit, DEFAULT_FORK_PAGE, 1, MAX_FORK_PAGE);
  const after = cursor === null ? null : parseForkAnchor(cursor.after);
  const over = page + 1;

  const positions = queryPositions({ sql, actorId: actor.actorId, limit: over, rootId: null, after });

  return seekPage(readRuns(sql, actor.actorId, null, positions), page, forkAnchor);
}

/** One exact run, including runs older than the current page. */
export function readForkRun(sql: SqlExecutor, actor: ActorHandle, rootId: string): ForkRunSummary | null {
  actor.assertCurrent();

  const positions = queryPositions({ sql, actorId: actor.actorId, limit: 1, rootId, after: null });

  return readRuns(sql, actor.actorId, rootId, positions)[0] ?? null;
}

/** `startedAt` alone is not a position (two runs can share a millisecond); the id completes it. */
interface ForkAnchor {
  readonly startedAt: number;
  readonly id: string;
}

function forkAnchor(run: ForkRunSummary): string {
  return `${run.startedAt}:${run.id}`;
}

function parseForkAnchor(after: string): ForkAnchor {
  const split = after.indexOf(':');
  const startedAt = Number(after.slice(0, split));
  const id = after.slice(split + 1);

  // Malformed is stale: an empty page would falsely report the runs behind it as exhausted.
  if (split < 1 || !Number.isFinite(startedAt) || id === '') {
    throw new StaleCursorError('fork list', after);
  }

  return { startedAt, id };
}

interface RunPosition {
  readonly rootId: string;
  readonly startedAt: number;
}

interface PositionQuery {
  readonly sql: SqlExecutor;
  readonly actorId: string;
  readonly limit: number;
  readonly rootId: string | null;
  readonly after: ForkAnchor | null;
}

/**
 * The page's runs, by position, newest first. `head_runs` contributes nothing: a run known only
 * to it has no branches. Both halves must stay actor-scoped; `search_nodes` is shared per database.
 */
function queryPositions({ sql, actorId, limit, rootId, after }: PositionQuery): RunPosition[] {
  const at = after?.startedAt ?? null;
  const from = after?.id ?? null;

  return sql<{ root_id: string; started_at: number }>`
    SELECT root_id AS root_id, MIN(started_at) AS started_at
    FROM (
      SELECT root_id AS root_id, MIN(created_at) AS started_at
      FROM search_nodes
      WHERE actor_id = ${actorId}
        AND (${rootId} IS NULL OR root_id = ${rootId})
      GROUP BY root_id
      UNION ALL
      SELECT root_id AS root_id, MIN(spawned_at) AS started_at
      FROM head_journal
      WHERE actor_id = ${actorId}
        AND root_id NOT LIKE ${`${STEER_BRANCH_RUN_ID_PREFIX}%`}
        AND (${rootId} IS NULL OR root_id = ${rootId})
      GROUP BY root_id
    )
    GROUP BY root_id
    HAVING (${at} IS NULL
            OR MIN(started_at) < ${at}
            OR (MIN(started_at) = ${at} AND root_id < ${from}))
    ORDER BY started_at DESC, root_id DESC LIMIT ${limit}`
    .map((row) => ({ rootId: row.root_id, startedAt: row.started_at }));
}

function readRuns(
  sql: SqlExecutor,
  actorId: string,
  rootId: string | null,
  positions: readonly RunPosition[],
): ForkRunSummary[] {
  if (positions.length === 0) return [];
  const wanted = new Set(positions.map((position) => position.rootId));
  const trees = queryTreeHalves(sql, actorId, rootId, wanted);
  const journals = queryTranscriptHalves(sql, actorId, rootId, wanted);

  return positions.flatMap((position) => {
    const tree = trees.get(position.rootId);
    const transcripts = journals.get(position.rootId);
    const status = runStatus(tree, transcripts);

    // Neither half: never fabricate a row.
    if (status === null) return [];

    const task = [tree?.task, transcripts?.rootTask, transcripts?.rationale]
      .map((candidate) => candidate?.trim())
      .find((candidate) => candidate !== undefined && candidate !== '') ?? '(exploration run)';

    return [{
      id: position.rootId,
      // The tree's task wins: `head_runs.rationale` carries the preset name for a swarm.
      task,
      name: runName(tree?.name ?? null, task),
      startedAt: position.startedAt,
      status,
      hasSearchTree: tree !== undefined,
      hasNodeTranscripts: transcripts !== undefined,
      branches: tree?.branches ?? transcripts?.branches ?? 0,
      winnerScore: tree !== undefined && tree.terminal > 0 ? tree.bestTerminal : null,
    }];
  });
}

/**
 * Either half running makes the run running; otherwise the tree's verdict decides where there is
 * a tree, since a converged search with one failed branch still settled.
 */
function runStatus(
  tree: TreeHalf | undefined,
  transcripts: TranscriptHalf | undefined,
): ForkRunStatus | null {
  const treeStatus = tree === undefined ? null : searchStatus(tree);
  const transcriptStatus = transcripts === undefined ? null : transcriptsStatus(transcripts);

  if (treeStatus === 'running' || transcriptStatus === 'running') return 'running';

  return treeStatus ?? transcriptStatus;
}

interface TreeHalf {
  readonly branches: number;
  readonly task: string | null;
  readonly name: string | null;
  readonly ledgerStatus: string | null;
  /** Open nodes with no children: exactly what `mcts/frontier.ts` selects from. Expanded open
   *  parents must not count. */
  readonly frontier: number;
  readonly terminal: number;
  readonly bestTerminal: number | null;
}

/**
 * Grouped by `search_nodes.root_id`, not the `mcts_search_runs` ledger, which prunes settled rows
 * after a day. Every `search_nodes` read, including the child subquery, must be actor-scoped.
 */
function queryTreeHalves(
  sql: SqlExecutor,
  actorId: string,
  rootId: string | null,
  wanted: ReadonlySet<string>,
): Map<string, TreeHalf> {
  const rows = sql<{
    root_id: string; branches: number; task: string | null; name: string | null;
    status: string | null; frontier: number; terminal: number; best_terminal: number | null;
  }>`
    SELECT n.root_id                                                AS root_id,
           SUM(CASE WHEN n.parent_id IS NOT NULL THEN 1 ELSE 0 END) AS branches,
           MAX(CASE WHEN n.parent_id IS NULL THEN n.task END)       AS task,
           MAX(CASE WHEN n.parent_id IS NULL THEN n.action END)     AS name,
           MAX(r.status)                                            AS status,
           SUM(CASE WHEN n.status = 'open'
                      AND NOT EXISTS (SELECT 1 FROM search_nodes c
                                      WHERE c.actor_id = n.actor_id AND c.parent_id = n.id)
                    THEN 1 ELSE 0 END)                              AS frontier,
           SUM(CASE WHEN n.status = 'terminal' THEN 1 ELSE 0 END)   AS terminal,
           MAX(CASE WHEN n.status = 'terminal' THEN n.own_score END) AS best_terminal
    FROM search_node_scores n
    LEFT JOIN mcts_search_runs r ON r.actor_id = ${actorId} AND r.root_id = n.root_id
    WHERE n.actor_id = ${actorId}
      AND (${rootId} IS NULL OR n.root_id = ${rootId})
    GROUP BY n.root_id`;

  const halves = new Map<string, TreeHalf>();

  for (const row of rows) {
    if (!wanted.has(row.root_id)) continue;
    halves.set(row.root_id, {
      branches: row.branches,
      task: row.task,
      name: row.name,
      ledgerStatus: row.status,
      frontier: row.frontier,
      terminal: row.terminal,
      bestTerminal: row.best_terminal,
    });
  }

  return halves;
}

/** The run's name: the root label its engine wrote, else derived from the task. Shared with the
 *  branch transcript breadcrumb (`mcts/engine.ts` records the root with `action: ''`). */
export function runName(rootLabel: string | null, task: string): string {
  const given = rootLabel?.trim();

  return given === undefined || given === '' ? shortName(task) : given;
}

const NAME_MAX_CHARS = 48;

function shortName(task: string): string {
  const cleaned = task.replace(/\s+/g, ' ').trim();

  if (!cleaned) return '(exploration run)';
  const cut = cleaned.search(/[—–:;,|]|\.\s|\.\s*$|\n/);
  const clause = cut >= 8 ? cleaned.slice(0, cut) : cleaned;

  if (clause.length <= NAME_MAX_CHARS) return clause.replace(/[\s—–:;,|.]+$/, '');
  const bound = clause.lastIndexOf(' ', NAME_MAX_CHARS);

  return (bound >= 20 ? clause.slice(0, bound) : clause.slice(0, NAME_MAX_CHARS))
    .replace(/[\s—–:;,|.]+$/, '');
}

/**
 * Ledger settlements decide; a `running` ledger row is a lease, not an observation (the engine
 * closes the tree before recording the outcome). Otherwise a terminal node means completed, and
 * a non-empty frontier means running.
 */
function searchStatus(tree: TreeHalf): ForkRunStatus {
  if (tree.ledgerStatus === 'failed') return 'failed';

  if (tree.ledgerStatus === 'converged') return 'completed';

  if (tree.ledgerStatus === 'no_acceptable_candidate') return 'failed';

  if (tree.terminal > 0) return 'completed';

  if (tree.frontier > 0) return 'running';

  return 'partial';
}

interface TranscriptHalf {
  readonly branches: number;
  readonly rootTask: string | null;
  readonly rationale: string | null;
  readonly running: number;
  readonly errored: number;
  readonly rootStatus: string | null;
  readonly settled: number;
}

/** Grouped by `head_journal`, as `HeadJournal.listRuns` is: a top-level split's synthetic root
 *  has no journal row. */
function queryTranscriptHalves(
  sql: SqlExecutor,
  actorId: string,
  rootId: string | null,
  wanted: ReadonlySet<string>,
): Map<string, TranscriptHalf> {
  const rows = sql<{
    root_id: string; heads: number; running: number; errored: number;
    root_status: string | null; root_task: string | null;
    rationale: string | null; settled: number;
  }>`
    SELECT j.root_id                                          AS root_id,
           SUM(CASE WHEN j.id != j.root_id THEN 1 ELSE 0 END) AS heads,
           SUM(CASE WHEN j.id != j.root_id AND j.status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN j.id != j.root_id AND j.status NOT IN ('running','completed') THEN 1 ELSE 0 END) AS errored,
           MAX(CASE WHEN j.id = j.root_id THEN j.status END)  AS root_status,
           MAX(CASE WHEN j.id = j.root_id THEN j.task END)    AS root_task,
           MAX(r.rationale)                                   AS rationale,
           MAX(CASE WHEN m.root_id IS NOT NULL THEN 1 ELSE 0 END) AS settled
    FROM head_journal j
    LEFT JOIN head_runs r ON r.actor_id = j.actor_id AND r.root_id = j.root_id
    LEFT JOIN head_merge_results m ON m.actor_id = j.actor_id AND m.root_id = j.root_id
    WHERE j.actor_id = ${actorId}
      AND j.root_id NOT LIKE ${`${STEER_BRANCH_RUN_ID_PREFIX}%`}
      AND (${rootId} IS NULL OR j.root_id = ${rootId})
    GROUP BY j.root_id`;

  const halves = new Map<string, TranscriptHalf>();

  for (const row of rows) {
    if (!wanted.has(row.root_id)) continue;
    halves.set(row.root_id, {
      branches: row.heads,
      rootTask: row.root_task,
      rationale: row.rationale,
      running: row.running,
      errored: row.errored,
      rootStatus: row.root_status,
      settled: row.settled,
    });
  }

  return halves;
}

/** Same precedence as `HeadJournal.assembleRun`, so list and detail never disagree. */
function transcriptsStatus(transcripts: TranscriptHalf): ForkRunStatus {
  if (transcripts.rootStatus === 'running') return 'running';

  if (transcripts.rootStatus === 'completed') return 'completed';

  if (transcripts.rootStatus !== null) return 'failed';

  if (transcripts.running > 0) return 'running';

  if (transcripts.settled > 0) return 'completed';

  return transcripts.errored === 0 ? 'completed' : 'partial';
}
