/**
 * One root id, one run — carrying every half it wrote.
 *
 * A run's journalled nodes land in `head_journal` and its search tree lands in
 * `search_nodes`. The two stores never meet, so a surface reading one showed an
 * empty pane for runs that had written the other and the same user action
 * appeared to vanish. Then a swarm whose nodes are agents wrote BOTH, and the
 * list — which tagged each half with one of the removed `fork` verb's two
 * settlements — answered with TWO runs sharing one id, the tree-less half sorting
 * newer and winning every caller's dedup.
 *
 * These tests pin the fixed list: one row per root, both halves on it, one
 * chronological order, one status vocabulary, and the two things that must NOT
 * appear (Steer-as-Branch redirects, legacy unscoped search rows).
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initHeadsTables } from '../src/heads/schema';
import { listForkRuns, readForkRun } from '../src/read-models/fork-runs';
import { newBranchId } from '../src/steer-branch';
import type { Page, SeekCursor } from '../src/read-models/page';
import type { ForkRunSummary } from '../src/read-models/fork-runs';

function freshDb() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw, makeSql(db));
  initMctsSearchTable(execRaw, makeSql(db));
  initHeadsTables(execRaw, makeSql(db));
  return { db, sql: makeSql(db) };
}

/**
 * A run with journalled nodes, seeded the way the writers write one:
 * `recordSplit` puts the rationale in head_runs, and every node gets a journal
 * row. A TOP-LEVEL split's root id is synthetic — there is deliberately no
 * journal row carrying it, which is why the read model groups by head_journal.
 * Pass `parentHead` for the recursive case, where a real head IS the root.
 */
function seedJournalledRun(
  db: Database,
  run: {
    rootId: string; task: string; at: number; heads: Array<{ status: string }>;
    merged?: boolean; parentHead?: { status: string }; rationale?: string;
  },
): void {
  db.prepare(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES (?, ?, ?)`)
    .run(run.rootId, run.rationale ?? run.task, run.at);
  if (run.parentHead) {
    db.prepare(
      `INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
       VALUES (?, NULL, ?, 0, ?, '', ?, ?, 'synthesize')`,
    ).run(run.rootId, run.rootId, `parent of ${run.task}`, run.parentHead.status, run.at);
  }
  run.heads.forEach((head, i) => {
    db.prepare(
      `INSERT INTO head_journal (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
       VALUES (?, ?, ?, 1, ?, '', ?, ?, 'synthesize')`,
    ).run(`${run.rootId}-h${i}`, run.parentHead ? run.rootId : null, run.rootId, `branch ${i}`, head.status, run.at + i);
  });
  if (run.merged) {
    db.prepare(
      `INSERT INTO head_merge_results
         (root_id, merged_narrative, cost_head_count, cost_total_tokens, cost_total_wall_ms, cost_max_depth, merged_at, merge_strategy)
       VALUES (?, 'synthesis', ?, 0, 0, 1, ?, 'synthesize')`,
    ).run(run.rootId, run.heads.length, run.at + 100);
  }
}

/** A run with a search tree: a root node, N branches, and optionally the ledger row. */
function seedSearchRun(
  db: Database,
  run: {
    rootId: string; task: string; at: number; branches: number;
    winner?: number; ledger?: 'running' | 'converged' | 'failed';
  },
): void {
  const node = db.prepare(
    `INSERT INTO search_nodes (id, parent_id, root_id, task, action, observation, visits, value, depth, status, created_at)
     VALUES (?, ?, ?, ?, '', '', 1, ?, ?, ?, ?)`,
  );
  node.run(run.rootId, null, run.rootId, run.task, 0, 0, 'open', run.at);
  for (let i = 0; i < run.branches; i++) {
    const isWinner = run.winner !== undefined && i === 0;
    node.run(
      `${run.rootId}-n${i}`, run.rootId, run.rootId, run.task,
      isWinner ? run.winner! : 0.2, 1, isWinner ? 'terminal' : 'pruned', run.at + i + 1,
    );
  }
  if (run.ledger) {
    db.prepare(
      `INSERT INTO mcts_search_runs (root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch, created_at, updated_at)
       VALUES (?, ?, 'mcts', 'm1', '{}', 3, 9, ?, 0, ?, ?)`,
    ).run(run.rootId, run.task, run.ledger, run.at, run.at);
  }
}

describe('listForkRuns', () => {
  test('lists runs from both stores in one chronological order', () => {
    const { db, sql } = freshDb();
    seedJournalledRun(db, { rootId: 'r-merge-old', task: 'audit the CLI', at: 1000, heads: [{ status: 'completed' }, { status: 'completed' }], merged: true });
    seedSearchRun(db, { rootId: 'r-search', task: 'pick a backfill', at: 2000, branches: 5, winner: 0.82, ledger: 'converged' });
    seedJournalledRun(db, { rootId: 'r-merge-new', task: 'split the docs', at: 3000, heads: [{ status: 'running' }] });

    const runs = listForkRuns(sql, null, 20).items;
    expect(runs.map((r) => r.id)).toEqual(['r-merge-new', 'r-search', 'r-merge-old']);
    expect(runs.map((r) => [r.hasSearchTree, r.hasNodeTranscripts]))
      .toEqual([[false, true], [true, false], [false, true]]);
  });

  test('a run with a tree carries its branch count and winning score', () => {
    const { db, sql } = freshDb();
    seedSearchRun(db, { rootId: 'r1', task: 'pick a backfill', at: 2000, branches: 6, winner: 0.82, ledger: 'converged' });
    const [run] = listForkRuns(sql).items;
    expect(run).toMatchObject({
      task: 'pick a backfill', hasSearchTree: true, hasNodeTranscripts: false,
      status: 'completed', branches: 6, winnerScore: 0.82,
    });
  });

  test('a journalled run counts its nodes and has no winner — nothing there ranked', () => {
    const { db, sql } = freshDb();
    seedJournalledRun(db, { rootId: 'r1', task: 'audit the CLI', at: 1000, heads: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }], merged: true });
    const [run] = listForkRuns(sql).items;
    expect(run).toMatchObject({
      task: 'audit the CLI', hasSearchTree: false, hasNodeTranscripts: true,
      status: 'completed', branches: 3, winnerScore: null,
    });
  });

  test('a run with a node still going reads as running', () => {
    const { db, sql } = freshDb();
    seedJournalledRun(db, { rootId: 'r1', task: 'audit', at: 1000, heads: [{ status: 'completed' }, { status: 'running' }] });
    expect(listForkRuns(sql).items[0]!.status).toBe('running');
  });

  test('nodes that errored without a synthesis read as partial, not completed', () => {
    const { db, sql } = freshDb();
    seedJournalledRun(db, { rootId: 'r1', task: 'audit', at: 1000, heads: [{ status: 'completed' }, { status: 'errored' }] });
    expect(listForkRuns(sql).items[0]!.status).toBe('partial');
  });

  test("a recursive sub-split is judged by its parent head, as the detail view judges it", () => {
    // HeadJournal.assembleRun prefers the root head row's own status; the list
    // must agree, or one run reads two ways depending on which pane you open.
    const { db, sql } = freshDb();
    seedJournalledRun(db, {
      rootId: 'r1', task: 'nested', at: 1000, parentHead: { status: 'running' },
      heads: [{ status: 'completed' }, { status: 'completed' }],
    });
    const [run] = listForkRuns(sql).items;
    expect(run).toMatchObject({ status: 'running', branches: 2, task: 'parent of nested' });
  });

  test('a search whose ledger row was pruned still lists, judged by its own tree', () => {
    // mcts_search_runs prunes settled rows after a day; search_nodes keeps the
    // tree forever. A ledger-driven list would make week-old runs disappear —
    // the exact complaint this read model answers.
    const { db, sql } = freshDb();
    seedSearchRun(db, { rootId: 'r-won', task: 'old but decided', at: 1000, branches: 3, winner: 0.9 });
    seedSearchRun(db, { rootId: 'r-stopped', task: 'old and abandoned', at: 900, branches: 2 });
    const runs = listForkRuns(sql).items;
    expect(runs.map((r) => [r.id, r.status])).toEqual([['r-won', 'completed'], ['r-stopped', 'partial']]);
  });

  test('a failed search says failed', () => {
    const { db, sql } = freshDb();
    seedSearchRun(db, { rootId: 'r1', task: 'doomed', at: 1000, branches: 1, ledger: 'failed' });
    expect(listForkRuns(sql).items[0]!.status).toBe('failed');
  });

  test('Steer-as-Branch redirects are not exploration runs', () => {
    // They go through the same HeadRuntime seam and journal, but a mid-turn
    // user redirect is not a search the agent chose — it renders as a chip on
    // the message it forked, and listing it here would be the duplication.
    const { db, sql } = freshDb();
    const branchId = newBranchId();
    seedJournalledRun(db, { rootId: branchId, task: 'user redirect', at: 2000, heads: [{ status: 'completed' }], merged: true });
    seedJournalledRun(db, { rootId: 'r-real', task: 'a real run', at: 1000, heads: [{ status: 'completed' }], merged: true });
    expect(listForkRuns(sql).items.map((r) => r.id)).toEqual(['r-real']);
  });

  test('Steer-as-Branch rows cannot consume the page limit before they are excluded', () => {
    const { db, sql } = freshDb();
    seedJournalledRun(db, {
      rootId: 'r-real', task: 'the real run', at: 1000,
      heads: [{ status: 'completed' }], merged: true,
    });
    for (let index = 0; index < 30; index += 1) {
      seedJournalledRun(db, {
        rootId: newBranchId(), task: `redirect ${index}`, at: 2000 + index,
        heads: [{ status: 'completed' }], merged: true,
      });
    }

    expect(listForkRuns(sql, null, 30).items.map((run) => run.id)).toEqual(['r-real']);
  });

  test('legacy unscoped search rows stay invisible', () => {
    const { db, sql } = freshDb();
    db.prepare(
      `INSERT INTO search_nodes (id, parent_id, root_id, task, action, observation, depth, status, created_at)
       VALUES ('legacy', NULL, NULL, 'pre-root_id', '', '', 0, 'open', 5000)`,
    ).run();
    seedSearchRun(db, { rootId: 'r1', task: 'scoped', at: 1000, branches: 1, ledger: 'converged' });
    expect(listForkRuns(sql).items.map((r) => r.id)).toEqual(['r1']);
  });

  test('the limit bounds the run list, not each store', () => {
    const { db, sql } = freshDb();
    for (let i = 0; i < 4; i++) {
      seedJournalledRun(db, { rootId: `m${i}`, task: `merge ${i}`, at: 1000 + i * 10, heads: [{ status: 'completed' }], merged: true });
      seedSearchRun(db, { rootId: `s${i}`, task: `search ${i}`, at: 1005 + i * 10, branches: 2, winner: 0.5, ledger: 'converged' });
    }
    const runs = listForkRuns(sql, null, 3).items;
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.id)).toEqual(['s3', 'm3', 's2']);
  });

  test('an exact lookup reaches a run outside the recent-list window', () => {
    const { db, sql } = freshDb();
    seedJournalledRun(db, {
      rootId: 'bookmarked', task: 'historical run', at: 1,
      heads: [{ status: 'completed' }], merged: true,
    });
    for (let index = 0; index < 30; index += 1) {
      seedSearchRun(db, {
        rootId: `recent-${index}`, task: `recent ${index}`, at: 100 + index,
        branches: 1, winner: 0.5, ledger: 'converged',
      });
    }

    expect(listForkRuns(sql, null, 30).items.some((run) => run.id === 'bookmarked')).toBe(false);
    expect(readForkRun(sql, 'bookmarked')).toMatchObject({
      id: 'bookmarked', task: 'historical run', hasSearchTree: false, hasNodeTranscripts: true,
    });
    expect(readForkRun(sql, 'missing')).toBeNull();
  });

  test('nothing searched yet is an empty list, not a throw', () => {
    const { sql } = freshDb();
    expect(listForkRuns(sql).items).toEqual([]);
  });
});

/**
 * A swarm whose `unit` is an agent writes BOTH stores under one root: the tree
 * through `mcts/record-node.ts`, a journalled transcript per node through
 * `heads/journal.ts`. Everything below is about that run being ONE run.
 */
describe('a run that wrote both stores', () => {
  const TASK = 'cut p99 latency on the search path';
  const PRESET = 'optimise';

  /** One root, both halves — the shape a swarm leaves behind. The journal starts
   *  AFTER the tree, which is what made the tree-less half sort newer. */
  function seedSwarmRun(db: Database, rootId = 'swarm-1'): void {
    seedSearchRun(db, { rootId, task: TASK, at: 1000, branches: 3, winner: 0.71, ledger: 'converged' });
    seedJournalledRun(db, {
      rootId, task: TASK, at: 1400, rationale: PRESET,
      heads: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }],
    });
  }

  test('is ONE run, and it carries every half it wrote', () => {
    const { db, sql } = freshDb();
    seedSwarmRun(db);
    const runs = listForkRuns(sql).items;
    // The denominator: one seeded root must arrive as exactly one row. Two rows is
    // the defect — the caller then dedups, and dedup picks a winner.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'swarm-1',
      hasSearchTree: true,
      hasNodeTranscripts: true,
      // The TREE's branches: every branch writes a tree row, only a tool-using
      // node writes a journal row, so the tree is the complete structure.
      branches: 3,
      winnerScore: 0.71,
      status: 'completed',
    });
    expect(new Set(runs.map((run) => run.id)).size).toBe(runs.length);
  });

  test('starts when its FIRST half was written, not when its second was', () => {
    const { db, sql } = freshDb();
    seedSwarmRun(db);
    expect(listForkRuns(sql).items[0]!.startedAt).toBe(1000);
  });

  test('reports the task it ran, never the preset name in the split rationale', () => {
    const { db, sql } = freshDb();
    seedSwarmRun(db);
    // `recordSplit` stamps `label ?? preset` into `head_runs.rationale`, and the
    // list used to read that column as the run's task because a swarm journals no
    // row for its root. The tree's root node holds the real task.
    expect(listForkRuns(sql).items[0]!.task).toBe(TASK);
    expect(listForkRuns(sql).items[0]!.task).not.toBe(PRESET);
  });

  test('a run with no tree still falls back to the split rationale for its task', () => {
    // The other direction of the same precedence: a journal-only run has no tree
    // root to name it, and its synthetic root has no journal row either, so the
    // rationale is the only thing that says what the run was for.
    const { db, sql } = freshDb();
    seedJournalledRun(db, {
      rootId: 'j1', task: 'unused', at: 1000, rationale: 'compare two rewrites',
      heads: [{ status: 'completed' }],
    });
    expect(listForkRuns(sql).items[0]!.task).toBe('compare two rewrites');
  });

  test('is running while either half is still writing', () => {
    const { db, sql } = freshDb();
    seedSearchRun(db, { rootId: 'swarm-1', task: TASK, at: 1000, branches: 2, winner: 0.5, ledger: 'converged' });
    seedJournalledRun(db, {
      rootId: 'swarm-1', task: TASK, at: 1400, rationale: PRESET,
      heads: [{ status: 'completed' }, { status: 'running' }],
    });
    expect(listForkRuns(sql).items[0]!.status).toBe('running');
  });

  test('a settled search with one failed node reads as settled, not partial', () => {
    // The tree's own ledger is the run's statement about how it ended; a failed
    // branch is normal in a search. The journal rule — nothing synthesised and
    // something errored means `partial` — is about heads reaching a synthesis, and
    // applying it here would report every swarm with a lost node as unfinished.
    const { db, sql } = freshDb();
    seedSearchRun(db, { rootId: 'swarm-1', task: TASK, at: 1000, branches: 2, winner: 0.6, ledger: 'converged' });
    seedJournalledRun(db, {
      rootId: 'swarm-1', task: TASK, at: 1400, rationale: PRESET,
      heads: [{ status: 'completed' }, { status: 'errored' }],
    });
    expect(listForkRuns(sql).items[0]!.status).toBe('completed');
  });

  test('arrives whole on whichever page it falls on, halves together', () => {
    // The page boundary is the other place a run can lose a half. Bounding each
    // STORE against a position in the merged order tears exactly here: this run's
    // tree begins before `middle` and its journal after it, so a per-store bound
    // admits the tree and rejects the journal, and the run arrives half-empty on
    // the page after `middle`.
    const { db, sql } = freshDb();
    seedSwarmRun(db);
    seedJournalledRun(db, { rootId: 'middle', task: 'in between', at: 1200, heads: [{ status: 'completed' }] });
    seedSearchRun(db, { rootId: 'newest', task: 'newest', at: 9000, branches: 1, ledger: 'converged' });

    const seen: ForkRunSummary[] = [];
    let cursor: SeekCursor | null = null;
    for (let page = 0; page < 5; page++) {
      const next: Page<ForkRunSummary> = listForkRuns(sql, cursor, 1);
      seen.push(...next.items);
      if (next.status === 'end') break;
      cursor = next.next;
    }
    expect(seen.map((run) => run.id)).toEqual(['newest', 'middle', 'swarm-1']);
    const swarm = seen.find((run) => run.id === 'swarm-1');
    expect(swarm).toMatchObject({ hasSearchTree: true, hasNodeTranscripts: true, branches: 3 });
  });

  test('an exact lookup carries both halves too', () => {
    const { db, sql } = freshDb();
    seedSwarmRun(db);
    expect(readForkRun(sql, 'swarm-1')).toMatchObject({
      hasSearchTree: true, hasNodeTranscripts: true, task: TASK, winnerScore: 0.71,
    });
  });
});
