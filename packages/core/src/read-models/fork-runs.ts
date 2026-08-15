/**
 * Fork runs — one chronological list of every time the agent forked itself,
 * whatever the settle policy chose.
 *
 * `agents(action:'fork')` picks a strategy from `settle`: the default `merge`
 * runs branching heads and journals them (head_runs / head_journal), while
 * `mcts` runs a tree search and writes search_nodes / mcts_search_runs. The
 * two stores never meet, so the surface that read one store showed an empty
 * pane for forks that had gone to the other — the same user action apparently
 * vanishing depending on an internal strategy id.
 *
 * This is the one read model that answers "when did it fork, and how did that
 * one settle". It deliberately stops at the summary: a competition has a tree
 * and a winner, a merge has heads and a narrative, and those detail views stay
 * separate because the mechanisms genuinely are.
 *
 * Steer-as-Branch runs are journaled through the same HeadRuntime seam but are
 * NOT fork runs — they are a user redirect anchored to the message they forked,
 * and they already render as chips in chat. They are filtered out by the id
 * prefix their only writer stamps (`STEER_BRANCH_RUN_ID_PREFIX`).
 */

import type { SqlExecutor } from '../types/primitives.js';
import { STEER_BRANCH_RUN_ID_PREFIX } from '../steer-branch.js';

/** How the fork settled: `merged` synthesised its heads, `competed` scored
 *  branches against each other and kept a winner. */
export type ForkSettle = 'merged' | 'competed';

/** One vocabulary across both mechanisms, so a list row can be read without
 *  knowing which store it came from. `partial` is "it stopped without a
 *  settled answer" — heads that finished with no merge, a search with no
 *  terminal node and no ledger row left to explain why. */
export type ForkRunStatus = 'running' | 'completed' | 'failed' | 'partial';

export interface ForkRunSummary {
  /** The run's root id — `rootId` for heads, the search's `root_id` for MCTS.
   *  Unique across both: the detail view keys on it. */
  readonly id: string;
  readonly task: string;
  readonly startedAt: number;
  readonly status: ForkRunStatus;
  readonly settle: ForkSettle;
  /** Branches the fork opened: heads for a merge, non-root nodes for a search. */
  readonly branches: number;
  /** Competed runs only: the winning branch's score in [0,1]. A merge has no
   *  winner — every head's findings go into the synthesis. */
  readonly winnerScore: number | null;
}

/**
 * Recent fork runs across both settle policies, newest first.
 *
 * `limit` bounds the merged list, not each half: asking for 20 gives the 20
 * most recent forks however they settled.
 */
export function listForkRuns(sql: SqlExecutor, limit = 20): ForkRunSummary[] {
  return [...queryMergedRuns(sql, limit, null), ...queryCompetedRuns(sql, limit, null)]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

/** One exact fork, including runs older than the recent-list window. */
export function readForkRun(sql: SqlExecutor, rootId: string): ForkRunSummary | null {
  return [...queryMergedRuns(sql, 1, rootId), ...queryCompetedRuns(sql, 1, rootId)]
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/* ── merged (settle=merge → branching heads) ───────────────────────── */

/**
 * Grouped by `head_journal` rather than `head_runs`, for the same reason
 * `HeadJournal.listRuns` is: a top-level split's synthetic root has no head
 * row, so grouping the other way collapses N heads into N empty runs.
 *
 * Deliberately narrower than `listRuns` — no per-head steps, no merge
 * synthesis, no evidence. A list row only has to say when it forked, into how
 * many, and whether it landed.
 */
function queryMergedRuns(
  sql: SqlExecutor,
  limit: number,
  rootId: string | null,
): ForkRunSummary[] {
  const rows = sql<{
    root_id: string; spawned_at: number; heads: number;
    running: number; errored: number; root_status: string | null;
    root_task: string | null; rationale: string | null; merged: number;
  }>`
    SELECT j.root_id                                          AS root_id,
           MIN(j.spawned_at)                                  AS spawned_at,
           SUM(CASE WHEN j.id != j.root_id THEN 1 ELSE 0 END) AS heads,
           SUM(CASE WHEN j.id != j.root_id AND j.status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN j.id != j.root_id AND j.status NOT IN ('running','completed') THEN 1 ELSE 0 END) AS errored,
           MAX(CASE WHEN j.id = j.root_id THEN j.status END)  AS root_status,
           MAX(CASE WHEN j.id = j.root_id THEN j.task END)    AS root_task,
           MAX(r.rationale)                                   AS rationale,
           MAX(CASE WHEN m.root_id IS NOT NULL THEN 1 ELSE 0 END) AS merged
    FROM head_journal j
    LEFT JOIN head_runs r ON r.root_id = j.root_id
    LEFT JOIN head_merge_results m ON m.root_id = j.root_id
    WHERE j.root_id NOT LIKE ${`${STEER_BRANCH_RUN_ID_PREFIX}%`}
      AND (${rootId} IS NULL OR j.root_id = ${rootId})
    GROUP BY j.root_id
    ORDER BY spawned_at DESC LIMIT ${limit}`;

  return rows.map((row) => ({
    id: row.root_id,
    task: row.root_task?.trim() || row.rationale?.trim() || '(fork)',
    startedAt: row.spawned_at,
    status: mergedStatus(row),
    settle: 'merged' as const,
    branches: row.heads,
    winnerScore: null,
  }));
}

/**
 * Same precedence as `HeadJournal.assembleRun`, so the list and the detail
 * view can never disagree about one run: a recursive sub-split's parent head
 * IS the run and its own lifecycle decides, and only a top-level split (whose
 * synthetic root has no head row) is judged by its children.
 */
function mergedStatus(row: {
  root_status: string | null; running: number; errored: number; merged: number;
}): ForkRunStatus {
  if (row.root_status !== null) {
    return row.root_status === 'running' ? 'running'
      : row.root_status === 'completed' ? 'completed'
      : 'failed';
  }
  if (row.running > 0) return 'running';
  if (row.merged > 0) return 'completed';
  // No synthesis: every head landing cleanly is still a completed split whose
  // merge was skipped; anything else stopped short of an answer.
  return row.errored === 0 ? 'completed' : 'partial';
}

/* ── competed (settle=mcts → tree search) ──────────────────────────── */

/**
 * Grouped by `search_nodes.root_id`, NOT by the `mcts_search_runs` ledger:
 * the ledger prunes settled rows after a day (search-store.ts) while the trees
 * stay forever, so a ledger-driven list would make week-old searches disappear
 * — the exact failure this read model exists to end. The ledger is joined for
 * the status it alone records.
 *
 * Legacy pre-`root_id` rows are NULL-scoped and stay invisible, as everywhere
 * else that reads this table.
 */
function queryCompetedRuns(
  sql: SqlExecutor,
  limit: number,
  rootId: string | null,
): ForkRunSummary[] {
  const roots = sql<{
    root_id: string; started_at: number; branches: number;
    task: string | null; status: string | null;
    terminal: number; best_terminal: number | null;
  }>`
    SELECT n.root_id                                              AS root_id,
           MIN(n.created_at)                                      AS started_at,
           SUM(CASE WHEN n.parent_id IS NOT NULL THEN 1 ELSE 0 END) AS branches,
           MAX(CASE WHEN n.parent_id IS NULL THEN n.task END)     AS task,
           MAX(r.status)                                          AS status,
           SUM(CASE WHEN n.status = 'terminal' THEN 1 ELSE 0 END) AS terminal,
           MAX(CASE WHEN n.status = 'terminal' THEN n.value END)  AS best_terminal
    FROM search_nodes n
    LEFT JOIN mcts_search_runs r ON r.root_id = n.root_id
    WHERE n.root_id IS NOT NULL
      AND (${rootId} IS NULL OR n.root_id = ${rootId})
    GROUP BY n.root_id
    ORDER BY started_at DESC LIMIT ${limit}`;

  return roots.map((row) => ({
    id: row.root_id,
    task: row.task?.trim() || '(search)',
    startedAt: row.started_at,
    status: competedStatus(row.status, row.terminal),
    settle: 'competed' as const,
    branches: row.branches,
    winnerScore: row.terminal > 0 ? row.best_terminal : null,
  }));
}

function competedStatus(ledger: string | null, terminal: number): ForkRunStatus {
  if (ledger === 'running') return 'running';
  if (ledger === 'failed') return 'failed';
  if (ledger === 'converged') return 'completed';
  // The ledger row was pruned (settled over a day ago) or never written: the
  // tree itself still says whether the search ever picked a winner.
  return terminal > 0 ? 'completed' : 'partial';
}
