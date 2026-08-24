/**
 * Exploration runs — one chronological list of every search this workspace has
 * run, whatever it wrote while running.
 *
 * ONE ROOT ID IS ONE RUN. That is the whole load-bearing property here, and it
 * is what this read model got wrong for a swarm. A run scoped by `root_id` writes
 * up to two stores, and which ones it writes is a fact about its axes rather than
 * a choice between two kinds of run:
 *
 *   - the SEARCH TREE (`search_nodes`, written only by `mcts/record-node.ts`) —
 *     the structure selection descends and backpropagation walks. Every branch a
 *     search opens gets exactly one row here;
 *   - the NODE TRANSCRIPTS (`head_journal` / `head_runs`, written only by
 *     `heads/journal.ts`) — one journalled row per tool-using node, with its turns.
 *
 * A swarm whose `unit` is an agent writes BOTH: `search_nodes` for the tree and
 * `head_journal` for each node's transcript, because a node is a real tool-using
 * agent. It was previously read as TWO runs sharing one id — one tagged `merged`
 * and one tagged `competed`, from the two settlements the removed `fork` verb
 * had — and since the journal half sorts newer than the tree half, the half with
 * no tree won every caller's dedup. A caller that dedups picks a winner, and
 * picking a winner is how four tree rows and a 0.71 winner were discarded.
 *
 * So the halves are two INDEPENDENT facts on one row ({@link
 * ForkRunSummary.hasSearchTree}, {@link ForkRunSummary.hasNodeTranscripts}), and
 * the position a page resumes from is a position over RUNS rather than over
 * either store. A run carries every half it actually has and there is nothing
 * left to reconcile.
 *
 * This is the one read model that answers "when did it search, and what did that
 * run leave behind". It deliberately stops at the summary: the tree rows and the
 * journalled turns are separate reads, composed one layer up by
 * `exploration-canvas.ts`.
 *
 * Steer-as-Branch runs are journaled through the same HeadRuntime seam but are
 * NOT exploration runs — they are a user redirect anchored to the message they
 * forked, and they already render as chips in chat. They are filtered out by the
 * id prefix their only writer stamps (`STEER_BRANCH_RUN_ID_PREFIX`).
 */

import type { SqlExecutor } from '../types/primitives';
import { seekPage, StaleCursorError, type Page, type SeekCursor } from './page';
import { STEER_BRANCH_RUN_ID_PREFIX } from '../steer-branch';

/** One vocabulary across both halves, so a list row can be read without knowing
 *  which stores it wrote. `partial` is "it stopped without a settled answer" —
 *  journalled nodes that finished with nothing settling them, a search with no
 *  terminal node and no ledger row left to explain why. */
export type ForkRunStatus = 'running' | 'completed' | 'failed' | 'partial';

export interface ForkRunSummary {
  /** The run's `root_id`, which both stores scope by and which the detail views
   *  key on. Exactly one summary exists per root id. */
  readonly id: string;
  readonly task: string;
  /**
   * What the run is called — the short handle every surface leads with. The
   * search root's own label when its engine wrote one (the caller's `name`,
   * or a composition's provenance label), and a derivation from the task
   * otherwise: a run is never left to present a truncated paragraph as if it
   * were a title.
   */
  readonly name: string;
  /** The first write of either half. */
  readonly startedAt: number;
  readonly status: ForkRunStatus;
  /** This run expanded a search tree: `search_nodes` rows are scoped to its root. */
  readonly hasSearchTree: boolean;
  /** This run journalled per-node transcripts: `head_journal` rows are scoped to
   *  its root. True whenever a node was a tool-using agent. */
  readonly hasNodeTranscripts: boolean;
  /** Branches this run opened below its root. The TREE's count where it has a
   *  tree, because every branch gets a row there while only tool-using nodes get
   *  a journal row; the journalled count otherwise. */
  readonly branches: number;
  /** The best terminal node's score in [0,1]. Null for a run with no tree, and
   *  null for a tree in which nothing reached a terminal node. */
  readonly winnerScore: number | null;
}

/** A page of the run list. Twenty is what the bare `LIMIT` was. */
const DEFAULT_FORK_PAGE = 20;

/**
 * A page of exploration runs, newest first.
 *
 * Newest-first in BOTH traversal and presentation, so a walker appends.
 *
 * ── Why the page is bounded over RUNS and not over a store ───────────────────
 * `head_journal` rowids and `search_nodes` rowids are not comparable, so no
 * single-table position can bound both halves, and the only total order the two
 * share is `(startedAt DESC, id DESC)`. That pair is what `after` carries —
 * opaque to every caller, parsed only here.
 *
 * The bound is applied to the union of ROOT IDS, once, and each half is then read
 * for the roots that page names. Bounding the halves separately and merging
 * afterwards is what tore: a run whose journal began after the cursor and whose
 * tree began before it would arrive with one half missing, which is the same
 * "half of a run" defect at the page boundary rather than at the dedup.
 */
export function listForkRuns(
  sql: SqlExecutor,
  cursor: SeekCursor | null = null,
  limit = DEFAULT_FORK_PAGE,
): Page<ForkRunSummary> {
  const after = cursor === null ? null : parseForkAnchor(cursor.after);
  const over = limit + 1;
  return seekPage(readRuns(sql, null, queryPositions(sql, over, null, after)), limit, forkAnchor);
}

/** One exact run, including runs older than the current page. */
export function readForkRun(sql: SqlExecutor, rootId: string): ForkRunSummary | null {
  return readRuns(sql, rootId, queryPositions(sql, 1, rootId, null))[0] ?? null;
}

/**
 * The position of one run in the list's order.
 *
 * `startedAt` alone is not a position: two runs can share a millisecond, and the
 * list already ordered by it with no tiebreak — so the window had no defined
 * membership at its boundary, never mind a resumable one. The id completes it.
 */
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
  // A malformed anchor is a stale one as far as a caller is concerned: the walk
  // has to restart either way, and answering an unreadable position with an
  // empty page would report the runs behind it as exhausted.
  if (split < 1 || !Number.isFinite(startedAt) || id === '') {
    throw new StaleCursorError('fork list', after);
  }
  return { startedAt, id };
}

/** One run's place in the list: the id both halves are scoped by, and when the
 *  earlier of them was first written. */
interface RunPosition {
  readonly rootId: string;
  readonly startedAt: number;
}

/**
 * The page's runs, by position, newest first.
 *
 * The union is over the two stores that hold BRANCHES. `head_runs` deliberately
 * contributes nothing: it is a header row written before the first node spawns,
 * so a run known only to it has neither a tree nor a transcript, and every run
 * that reaches a node writes its tree root either way.
 *
 * Legacy pre-`root_id` `search_nodes` rows are NULL-scoped and stay invisible, as
 * they are to every scoped query.
 */
function queryPositions(
  sql: SqlExecutor,
  limit: number,
  rootId: string | null,
  after: ForkAnchor | null,
): RunPosition[] {
  const at = after?.startedAt ?? null;
  const from = after?.id ?? null;
  return sql<{ root_id: string; started_at: number }>`
    SELECT root_id AS root_id, MIN(started_at) AS started_at
    FROM (
      SELECT root_id AS root_id, MIN(created_at) AS started_at
      FROM search_nodes
      WHERE root_id IS NOT NULL AND (${rootId} IS NULL OR root_id = ${rootId})
      GROUP BY root_id
      UNION ALL
      SELECT root_id AS root_id, MIN(spawned_at) AS started_at
      FROM head_journal
      WHERE root_id NOT LIKE ${`${STEER_BRANCH_RUN_ID_PREFIX}%`}
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

/**
 * The named runs, each carrying every half it has.
 *
 * Both halves are read once for the whole page and joined by root id here, rather
 * than per run: two aggregates over the two stores is the cost the two bounded
 * queries already were, and a per-run read would be one round trip per row.
 * `rootId` narrows both aggregates for the single-run read; a page passes null and
 * selects the roots it named out of the result, the way `readForkRunParams` does.
 */
function readRuns(
  sql: SqlExecutor,
  rootId: string | null,
  positions: readonly RunPosition[],
): ForkRunSummary[] {
  if (positions.length === 0) return [];
  const wanted = new Set(positions.map((position) => position.rootId));
  const trees = queryTreeHalves(sql, rootId, wanted);
  const journals = queryTranscriptHalves(sql, rootId, wanted);
  return positions.flatMap((position) => {
    const tree = trees.get(position.rootId);
    const transcripts = journals.get(position.rootId);
    const status = runStatus(tree, transcripts);
    // Neither half: nothing this workspace stored says anything about the run, so
    // there is no run to report. Unreachable through `queryPositions`, whose every
    // row comes from one of these two stores, and a guard rather than a default
    // because a fabricated row is precisely what this read model must not produce.
    if (status === null) return [];
    const task = tree?.task?.trim() || transcripts?.rootTask?.trim()
      || transcripts?.rationale?.trim() || '(exploration run)';
    return [{
      id: position.rootId,
      // The TREE's root task is a task written by the engine that ran, whereas
      // `head_runs.rationale` is the split's "why" and carries the preset name
      // for a swarm. Reading the rationale as the task is what put `optimise`
      // in the task slot of every swarm run — a swarm journals no row for its
      // root, so the journal's own task was null and the fallback reached it.
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
 * The run's status across both halves, or null when it has neither.
 *
 * Either half still writing makes the run running — that is the one claim a
 * reader acts on by waiting. Otherwise the TREE's verdict decides where there is
 * a tree, because the ledger row is the run's own statement about how it ended,
 * while the transcript rule below is about heads reaching a synthesis: a search
 * that converged with one failed branch settled, and reading it as `partial`
 * would report a normal search as one that stopped without an answer.
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

/* ── the search-tree half (search_nodes + the run ledger) ──────────── */

interface TreeHalf {
  readonly branches: number;
  readonly task: string | null;
  /** The root row's own label — the run's given name, empty when none was. */
  readonly name: string | null;
  readonly ledgerStatus: string | null;
  readonly terminal: number;
  readonly bestTerminal: number | null;
}

/**
 * Grouped by `search_nodes.root_id`, NOT by the `mcts_search_runs` ledger: the
 * ledger prunes settled rows after a day (search-store.ts) while the trees stay
 * forever, so a ledger-driven list would make week-old searches disappear — the
 * exact failure this read model exists to end. The ledger is joined for the
 * status it alone records.
 */
function queryTreeHalves(
  sql: SqlExecutor,
  rootId: string | null,
  wanted: ReadonlySet<string>,
): Map<string, TreeHalf> {
  const rows = sql<{
    root_id: string; branches: number; task: string | null; name: string | null;
    status: string | null; terminal: number; best_terminal: number | null;
  }>`
    SELECT n.root_id                                                AS root_id,
           SUM(CASE WHEN n.parent_id IS NOT NULL THEN 1 ELSE 0 END) AS branches,
           MAX(CASE WHEN n.parent_id IS NULL THEN n.task END)       AS task,
           MAX(CASE WHEN n.parent_id IS NULL THEN n.action END)     AS name,
           MAX(r.status)                                            AS status,
           SUM(CASE WHEN n.status = 'terminal' THEN 1 ELSE 0 END)   AS terminal,
           MAX(CASE WHEN n.status = 'terminal' THEN n.value END)    AS best_terminal
    FROM search_nodes n
    LEFT JOIN mcts_search_runs r ON r.root_id = n.root_id
    WHERE n.root_id IS NOT NULL
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
      terminal: row.terminal,
      bestTerminal: row.best_terminal,
    });
  }
  return halves;
}

/**
 * The name a run presents: the label its engine wrote for the root, or a
 * derivation from the task when it wrote none — legacy trees, journal-only
 * runs, and callers who named nothing. Total: a surface never falls back to
 * showing a truncated paragraph where a title belongs.
 */
function runName(rootLabel: string | null, task: string): string {
  const given = rootLabel?.trim();
  return given || shortName(task);
}

/** The first clause of a task, cut where the task itself offers a cut — a
 *  dash, a colon, a sentence end — and at a word boundary inside
 *  {@link NAME_MAX_CHARS} otherwise. A title, so no ellipsis: what it cuts,
 *  it cuts cleanly. */
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

function searchStatus(tree: TreeHalf): ForkRunStatus {
  if (tree.ledgerStatus === 'running') return 'running';
  if (tree.ledgerStatus === 'failed') return 'failed';
  if (tree.ledgerStatus === 'converged') return 'completed';
  // This list's `failed` bucket is "settled without a usable answer". The
  // exact `no_acceptable_candidate` cause remains on the run ledger.
  if (tree.ledgerStatus === 'no_acceptable_candidate') return 'failed';
  // The ledger row was pruned (settled over a day ago) or never written: the tree
  // itself still says whether the search ever picked a winner.
  return tree.terminal > 0 ? 'completed' : 'partial';
}

/* ── the transcript half (head_journal + head_runs) ────────────────── */

interface TranscriptHalf {
  readonly branches: number;
  readonly rootTask: string | null;
  readonly rationale: string | null;
  readonly running: number;
  readonly errored: number;
  readonly rootStatus: string | null;
  readonly settled: number;
}

/**
 * Grouped by `head_journal` rather than `head_runs`, for the same reason
 * `HeadJournal.listRuns` is: a top-level split's synthetic root has no journal row
 * of its own, so grouping the other way collapses N nodes into N empty runs.
 *
 * Deliberately narrower than `listRuns` — no per-node steps, no synthesis, no
 * evidence. A list row only has to say when it started, into how many, and
 * whether it landed.
 */
function queryTranscriptHalves(
  sql: SqlExecutor,
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
    LEFT JOIN head_runs r ON r.root_id = j.root_id
    LEFT JOIN head_merge_results m ON m.root_id = j.root_id
    WHERE j.root_id NOT LIKE ${`${STEER_BRANCH_RUN_ID_PREFIX}%`}
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

/**
 * Same precedence as `HeadJournal.assembleRun`, so the list and the detail view
 * can never disagree about one run: a recursive sub-split's parent head IS the
 * run and its own lifecycle decides, and only a top-level split (whose synthetic
 * root has no journal row) is judged by its children.
 */
function transcriptsStatus(transcripts: TranscriptHalf): ForkRunStatus {
  if (transcripts.rootStatus !== null) {
    return transcripts.rootStatus === 'running' ? 'running'
      : transcripts.rootStatus === 'completed' ? 'completed'
      : 'failed';
  }
  if (transcripts.running > 0) return 'running';
  if (transcripts.settled > 0) return 'completed';
  // Nothing synthesised: every node landing cleanly is still a completed run whose
  // synthesis was skipped; anything else stopped short of an answer.
  return transcripts.errored === 0 ? 'completed' : 'partial';
}
