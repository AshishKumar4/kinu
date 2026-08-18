/**
 * One fork, one list — whichever store it landed in.
 *
 * A fork's heads land in the head journal and a tree search's branches land in
 * search_nodes. The two stores never meet, so a surface
 * reading one showed an empty pane for forks that had gone to the other and
 * the same user action appeared to vanish. These tests pin the unified list:
 * both mechanisms, one chronological order, one status vocabulary, and the
 * two things that must NOT appear in it (Steer-as-Branch redirects, legacy
 * unscoped search rows).
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initHeadsTables } from '../src/heads/schema';
import { listForkRuns, readForkRun } from '../src/read-models/fork-runs';
import { newBranchId } from '../src/steer-branch';

function freshDb() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw, makeSql(db));
  initMctsSearchTable(execRaw);
  initHeadsTables(execRaw, makeSql(db));
  return { db, sql: makeSql(db) };
}

/**
 * A merged fork, seeded the way the controller writes one: `recordSplit`
 * puts the rationale in head_runs, and every head gets a journal row. A
 * TOP-LEVEL split's root id is synthetic — there is deliberately no head row
 * carrying it, which is why the read model groups by head_journal. Pass
 * `parentHead` for the recursive case, where a real head IS the root.
 */
function seedMergedRun(
  db: Database,
  run: {
    rootId: string; task: string; at: number; heads: Array<{ status: string }>;
    merged?: boolean; parentHead?: { status: string };
  },
): void {
  db.prepare(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES (?, ?, ?)`)
    .run(run.rootId, run.task, run.at);
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

/** A tree-searched run: a root node, N branches, and optionally the ledger row. */
function seedCompetedRun(
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
      `INSERT INTO mcts_search_runs (root_id, task, root_msg_id, config_json, iteration, budget, status, epoch, created_at, updated_at)
       VALUES (?, ?, 'm1', '{}', 3, 9, ?, 0, ?, ?)`,
    ).run(run.rootId, run.task, run.ledger, run.at, run.at);
  }
}

describe('listForkRuns', () => {
  test('lists forks from both settle policies in one chronological order', () => {
    const { db, sql } = freshDb();
    seedMergedRun(db, { rootId: 'r-merge-old', task: 'audit the CLI', at: 1000, heads: [{ status: 'completed' }, { status: 'completed' }], merged: true });
    seedCompetedRun(db, { rootId: 'r-search', task: 'pick a backfill', at: 2000, branches: 5, winner: 0.82, ledger: 'converged' });
    seedMergedRun(db, { rootId: 'r-merge-new', task: 'split the docs', at: 3000, heads: [{ status: 'running' }] });

    const runs = listForkRuns(sql, null, 20).items;
    expect(runs.map((r) => r.id)).toEqual(['r-merge-new', 'r-search', 'r-merge-old']);
    expect(runs.map((r) => r.settle)).toEqual(['merged', 'competed', 'merged']);
  });

  test('a competed run carries its branch count and winning score', () => {
    const { db, sql } = freshDb();
    seedCompetedRun(db, { rootId: 'r1', task: 'pick a backfill', at: 2000, branches: 6, winner: 0.82, ledger: 'converged' });
    const [run] = listForkRuns(sql).items;
    expect(run).toMatchObject({
      task: 'pick a backfill', settle: 'competed', status: 'completed', branches: 6, winnerScore: 0.82,
    });
  });

  test('a merged run counts heads and has no winner — every branch fed the synthesis', () => {
    const { db, sql } = freshDb();
    seedMergedRun(db, { rootId: 'r1', task: 'audit the CLI', at: 1000, heads: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }], merged: true });
    const [run] = listForkRuns(sql).items;
    expect(run).toMatchObject({
      task: 'audit the CLI', settle: 'merged', status: 'completed', branches: 3, winnerScore: null,
    });
  });

  test('a run with a head still going reads as running', () => {
    const { db, sql } = freshDb();
    seedMergedRun(db, { rootId: 'r1', task: 'audit', at: 1000, heads: [{ status: 'completed' }, { status: 'running' }] });
    expect(listForkRuns(sql).items[0]!.status).toBe('running');
  });

  test('heads that errored without a merge read as partial, not completed', () => {
    const { db, sql } = freshDb();
    seedMergedRun(db, { rootId: 'r1', task: 'audit', at: 1000, heads: [{ status: 'completed' }, { status: 'errored' }] });
    expect(listForkRuns(sql).items[0]!.status).toBe('partial');
  });

  test("a recursive sub-split is judged by its parent head, as the detail view judges it", () => {
    // HeadJournal.assembleRun prefers the root head row's own status; the list
    // must agree, or one run reads two ways depending on which pane you open.
    const { db, sql } = freshDb();
    seedMergedRun(db, {
      rootId: 'r1', task: 'nested', at: 1000, parentHead: { status: 'running' },
      heads: [{ status: 'completed' }, { status: 'completed' }],
    });
    const [run] = listForkRuns(sql).items;
    expect(run).toMatchObject({ status: 'running', branches: 2, task: 'parent of nested' });
  });

  test('a search whose ledger row was pruned still lists, judged by its own tree', () => {
    // mcts_search_runs prunes settled rows after a day; search_nodes keeps the
    // tree forever. A ledger-driven list would make week-old forks disappear —
    // the exact complaint this read model answers.
    const { db, sql } = freshDb();
    seedCompetedRun(db, { rootId: 'r-won', task: 'old but decided', at: 1000, branches: 3, winner: 0.9 });
    seedCompetedRun(db, { rootId: 'r-stopped', task: 'old and abandoned', at: 900, branches: 2 });
    const runs = listForkRuns(sql).items;
    expect(runs.map((r) => [r.id, r.status])).toEqual([['r-won', 'completed'], ['r-stopped', 'partial']]);
  });

  test('a failed search says failed', () => {
    const { db, sql } = freshDb();
    seedCompetedRun(db, { rootId: 'r1', task: 'doomed', at: 1000, branches: 1, ledger: 'failed' });
    expect(listForkRuns(sql).items[0]!.status).toBe('failed');
  });

  test('Steer-as-Branch redirects are not fork runs', () => {
    // They go through the same HeadRuntime seam and journal, but a mid-turn
    // user redirect is not a fork the agent chose — it renders as a chip on
    // the message it forked, and listing it here would be the duplication.
    const { db, sql } = freshDb();
    const branchId = newBranchId();
    seedMergedRun(db, { rootId: branchId, task: 'user redirect', at: 2000, heads: [{ status: 'completed' }], merged: true });
    seedMergedRun(db, { rootId: 'r-real', task: 'a real fork', at: 1000, heads: [{ status: 'completed' }], merged: true });
    expect(listForkRuns(sql).items.map((r) => r.id)).toEqual(['r-real']);
  });

  test('Steer-as-Branch rows cannot consume the fork limit before they are excluded', () => {
    const { db, sql } = freshDb();
    seedMergedRun(db, {
      rootId: 'r-real', task: 'the real fork', at: 1000,
      heads: [{ status: 'completed' }], merged: true,
    });
    for (let index = 0; index < 30; index += 1) {
      seedMergedRun(db, {
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
    seedCompetedRun(db, { rootId: 'r1', task: 'scoped', at: 1000, branches: 1, ledger: 'converged' });
    expect(listForkRuns(sql).items.map((r) => r.id)).toEqual(['r1']);
  });

  test('the limit bounds the merged list, not each half', () => {
    const { db, sql } = freshDb();
    for (let i = 0; i < 4; i++) {
      seedMergedRun(db, { rootId: `m${i}`, task: `merge ${i}`, at: 1000 + i * 10, heads: [{ status: 'completed' }], merged: true });
      seedCompetedRun(db, { rootId: `s${i}`, task: `search ${i}`, at: 1005 + i * 10, branches: 2, winner: 0.5, ledger: 'converged' });
    }
    const runs = listForkRuns(sql, null, 3).items;
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.id)).toEqual(['s3', 'm3', 's2']);
  });

  test('an exact lookup reaches a fork outside the recent-list window', () => {
    const { db, sql } = freshDb();
    seedMergedRun(db, {
      rootId: 'bookmarked', task: 'historical fork', at: 1,
      heads: [{ status: 'completed' }], merged: true,
    });
    for (let index = 0; index < 30; index += 1) {
      seedCompetedRun(db, {
        rootId: `recent-${index}`, task: `recent ${index}`, at: 100 + index,
        branches: 1, winner: 0.5, ledger: 'converged',
      });
    }

    expect(listForkRuns(sql, null, 30).items.some((run) => run.id === 'bookmarked')).toBe(false);
    expect(readForkRun(sql, 'bookmarked')).toMatchObject({
      id: 'bookmarked', task: 'historical fork', settle: 'merged',
    });
    expect(readForkRun(sql, 'missing')).toBeNull();
  });

  test('nothing forked yet is an empty list, not a throw', () => {
    const { sql } = freshDb();
    expect(listForkRuns(sql).items).toEqual([]);
  });
});
