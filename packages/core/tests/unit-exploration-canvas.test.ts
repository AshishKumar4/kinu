/**
 * The canvas projection: every tree in a workspace, and what each run was
 * dispatched with.
 *
 * Two defects these pin, both from the owner's own screenshots:
 *
 *   1. "Currently I can choose a run and I only see that tree." The surface read
 *      ONE root, because the scoped read model exists precisely to stop a client
 *      folding an unscoped pile into whichever root it picked. So the fix is an
 *      explicitly multi-root projection whose every row still names its tree —
 *      not the removal of scoping.
 *
 *   2. "the Exploration UI doesnt really differentiate properly between the run
 *      params i.e, if the settle is of mcts or what." A search and a merge are
 *      different objects; the surface could only say which OUTCOME each reached.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initMctsSearchTable } from '../src/mcts/search-store.js';
import { initHeadsTables } from '../src/heads/schema.js';
import { readSearchForest } from '../src/read-models/search-tree.js';
import { readForkRunParams } from '../src/read-models/fork-params.js';
import { readExplorationCanvas } from '../src/read-models/exploration-canvas.js';

function freshDb() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw);
  initMctsSearchTable(execRaw);
  initHeadsTables(execRaw);
  return { db, sql: makeSql(db) };
}

function seedSearch(db: Database, run: {
  rootId: string; task: string; at: number; nodes: number;
  config?: Record<string, number | string>; status?: string;
}): void {
  const insert = db.query(`INSERT INTO search_nodes
    (id, parent_id, root_id, task, action, observation, depth, visits, value, status, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, 1, 0.5, 'open', ?)`);
  insert.run(run.rootId, null, run.rootId, run.task, '', 0, run.at);
  for (let i = 0; i < run.nodes; i++) {
    insert.run(`${run.rootId}-b${i}`, run.rootId, run.rootId, run.task, `branch ${i}`, 1, run.at + i + 1);
  }
  db.query(`INSERT INTO mcts_search_runs
    (root_id, task, root_msg_id, config_json, iteration, budget, status, epoch, created_at, updated_at)
    VALUES (?, ?, 'm', ?, 0, 8, ?, 0, ?, ?)`).run(
    run.rootId, run.task,
    JSON.stringify(run.config ?? { budget: 8, branches: 3, maxDepth: 4, explorationWeight: 1.41, mode: 'build' }),
    run.status ?? 'converged', run.at, run.at,
  );
}

function seedSplit(db: Database, run: {
  rootId: string; task: string; at: number; heads: number;
  strategy?: string; merged?: boolean;
}): void {
  db.query(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES (?, ?, ?)`)
    .run(run.rootId, run.task, run.at);
  const insert = db.query(`INSERT INTO head_journal
    (id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES (?, NULL, ?, 0, ?, 'r', 'completed', ?, ?)`);
  for (let i = 0; i < run.heads; i++) {
    insert.run(`${run.rootId}-h${i}`, run.rootId, `angle ${i}`, run.at + i, run.strategy ?? 'synthesize');
  }
  if (run.merged) {
    db.query(`INSERT INTO head_merge_results
      (root_id, merged_narrative, selected_decisions_json, unresolved_questions_json,
       recommendations_json, cost_head_count, cost_total_tokens, cost_total_wall_ms,
       cost_max_depth, merged_at, merge_strategy)
      VALUES (?, 'merged', '[]', '[]', '[]', ?, 10, 10, 1, ?, ?)`)
      .run(run.rootId, run.heads, run.at, run.strategy ?? 'synthesize');
  }
}

describe('readSearchForest', () => {
  test('serves every search, each row naming its own tree', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's-old', task: 'first', at: 1_000, nodes: 2 });
    seedSearch(db, { rootId: 's-new', task: 'second', at: 5_000, nodes: 3 });

    const rows = readSearchForest(sql, 30);
    const roots = new Set(rows.map((row) => row.root_id));
    expect(roots).toEqual(new Set(['s-old', 's-new']));
    // Newest search first, and its rows contiguous — a caller folding row by row
    // never straddles two trees.
    expect(rows[0]!.root_id).toBe('s-new');
    expect(rows.filter((row) => row.root_id === 's-new')).toHaveLength(4);
    expect(rows.filter((row) => row.root_id === 's-old')).toHaveLength(3);
  });

  test('every row carries the root that says which tree it is', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'one', at: 1_000, nodes: 2 });
    expect(readSearchForest(sql, 30).every((row) => row.root_id === 's1')).toBe(true);
  });

  test('the limit bounds SEARCHES, not rows — a big tree cannot crowd out a run', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'huge', task: 'huge', at: 1_000, nodes: 40 });
    seedSearch(db, { rootId: 'small', task: 'small', at: 5_000, nodes: 1 });

    const rows = readSearchForest(sql, 2);
    expect(new Set(rows.map((row) => row.root_id))).toEqual(new Set(['huge', 'small']));
    expect(readSearchForest(sql, 1).every((row) => row.root_id === 'small')).toBe(true);
  });

  test('legacy unscoped rows stay invisible, as they are to every scoped read', () => {
    const { db, sql } = freshDb();
    db.exec(`INSERT INTO search_nodes (id, task, action, depth, visits, value, status, created_at)
      VALUES ('legacy', 'old', '', 0, 1, 0.5, 'open', 500)`);
    expect(readSearchForest(sql, 30)).toEqual([]);
  });

  test('an empty workspace is an empty forest, not an error', () => {
    const { sql } = freshDb();
    expect(readSearchForest(sql, 30)).toEqual([]);
  });
});

describe('readForkRunParams', () => {
  test('a search reports the policy and knobs it actually ran with', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 's1', task: 'pick a backfill', at: 1_000, nodes: 2,
      config: { budget: 12, branches: 4, maxDepth: 6, explorationWeight: 0.9, judgeSamples: 3, mode: 'plan' },
    });
    expect(readForkRunParams(sql, ['s1'])).toEqual([{
      rootId: 's1', policy: 'mcts', budget: 12, branches: 4,
      maxDepth: 6, explorationWeight: 0.9, judgeSamples: 3, mode: 'plan',
    }]);
  });

  test('a merge reports its merge strategy and head count, and no budget at all', () => {
    const { db, sql } = freshDb();
    seedSplit(db, { rootId: 'm1', task: 'audit', at: 1_000, heads: 5, strategy: 'best_of' });
    expect(readForkRunParams(sql, ['m1'])).toEqual([{
      rootId: 'm1', policy: 'merge', mergeStrategy: 'best_of', branches: 5,
    }]);
  });

  test('two runs of the same task under different policies are told apart', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'same-mcts', task: 'name the product', at: 1_000, nodes: 3 });
    seedSplit(db, { rootId: 'same-merge', task: 'name the product', at: 2_000, heads: 5, merged: true });

    const params = readForkRunParams(sql, ['same-mcts', 'same-merge']);
    expect(params.map((entry) => [entry.rootId, entry.policy]).sort())
      .toEqual([['same-mcts', 'mcts'], ['same-merge', 'merge']]);
  });

  test('a run whose parameters were never recorded is absent, never defaulted', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'pruned ledger', at: 1_000, nodes: 1 });
    // The ledger prunes settled rows; the tree stays forever.
    db.exec(`DELETE FROM mcts_search_runs WHERE root_id = 's1'`);
    expect(readForkRunParams(sql, ['s1'])).toEqual([]);
  });

  test('an unreadable config is absent rather than a run with invented numbers', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'corrupt', at: 1_000, nodes: 1 });
    db.exec(`UPDATE mcts_search_runs SET config_json = 'not json' WHERE root_id = 's1'`);
    expect(readForkRunParams(sql, ['s1'])).toEqual([]);

    db.exec(`UPDATE mcts_search_runs SET config_json = '{"budget":"eight"}' WHERE root_id = 's1'`);
    expect(readForkRunParams(sql, ['s1'])).toEqual([]);
  });

  test('runs outside the asked-for set are never returned', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'wanted', task: 'a', at: 1_000, nodes: 1 });
    seedSearch(db, { rootId: 'other', task: 'b', at: 2_000, nodes: 1 });
    expect(readForkRunParams(sql, ['wanted']).map((entry) => entry.rootId)).toEqual(['wanted']);
    expect(readForkRunParams(sql, [])).toEqual([]);
  });
});

describe('readExplorationCanvas', () => {
  test('the runs, their parameters and every tree arrive from one snapshot', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'compete', at: 1_000, nodes: 3 });
    seedSplit(db, { rootId: 'm1', task: 'merge', at: 4_000, heads: 2, merged: true });
    seedSearch(db, { rootId: 's2', task: 'compete again', at: 6_000, nodes: 1 });

    const canvas = readExplorationCanvas(sql, 30);
    expect(canvas.runs.map((run) => run.id)).toEqual(['s2', 'm1', 's1']);
    // Every run in the list has its parameters, and every competed run its rows.
    expect(new Set(canvas.params.map((entry) => entry.rootId))).toEqual(new Set(['s1', 'm1', 's2']));
    expect(new Set(canvas.search.map((row) => row.root_id))).toEqual(new Set(['s1', 's2']));
    // A merge keeps its branches in the journal, so it contributes no rows here.
    expect(canvas.search.some((row) => row.root_id === 'm1')).toBe(false);
  });

  test('no tree is served for a run the list does not have', () => {
    const { db, sql } = freshDb();
    for (let i = 0; i < 4; i++) {
      seedSearch(db, { rootId: `s${i}`, task: `t${i}`, at: 1_000 * (i + 1), nodes: 1 });
    }
    const canvas = readExplorationCanvas(sql, 2);
    const listed = new Set(canvas.runs.map((run) => run.id));
    expect(listed.size).toBe(2);
    expect(canvas.search.every((row) => listed.has(row.root_id ?? ''))).toBe(true);
    expect(canvas.params.every((entry) => listed.has(entry.rootId))).toBe(true);
  });

  test('an empty workspace is an empty canvas', () => {
    const { sql } = freshDb();
    expect(readExplorationCanvas(sql, 30)).toEqual({ runs: [], params: [], search: [] });
  });
});
