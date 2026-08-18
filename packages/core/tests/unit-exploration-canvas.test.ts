/**
 * The canvas projection: every tree in a workspace, and what each run was
 * dispatched with.
 *
 * Three defects these pin, the first two from the owner's own screenshots:
 *
 *   1. "Currently I can choose a run and I only see that tree." The surface read
 *      ONE root, because the scoped read model exists precisely to stop a client
 *      folding an unscoped pile into whichever root it picked. So the fix is a
 *      canvas composed of scoped per-root reads — not the removal of scoping.
 *
 *   2. "the Exploration UI doesnt really differentiate properly between the run
 *      params i.e, if the settle is of mcts or what." A search and a merge are
 *      different objects; the surface could only say which OUTCOME each reached.
 *
 *   3. The trees and the run list beside them were bounded SEPARATELY, by
 *      different ordering keys — the run list by when a fork started, the trees
 *      by when a search was last written to. Two windows over overlapping sets,
 *      so the canvas could draw a listed fork with no tree and hold a tree for a
 *      fork it had not listed. The runs now choose the roots, which is why there
 *      is no multi-root read left to disagree with them.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initHeadsTables } from '../src/heads/schema';
import { readSearchTree } from '../src/read-models/search-tree';
import { readForkRunParams } from '../src/read-models/fork-params';
import { readExplorationCanvas, type ExplorationCanvasRun } from '../src/read-models/exploration-canvas';
import type { Page, SeekCursor } from '../src/read-models/page';

function freshDb() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw, makeSql(db));
  initMctsSearchTable(execRaw);
  initHeadsTables(execRaw, makeSql(db));
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

describe('readForkRunParams', () => {
  test('a search reports the policy and knobs it actually ran with', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 's1', task: 'pick a backfill', at: 1_000, nodes: 2,
      config: { budget: 12, branches: 4, maxDepth: 6, explorationWeight: 0.9, judgeSamples: 3, mode: 'plan' },
    });
    expect(readForkRunParams(sql, ['s1'])).toEqual([{
      rootId: 's1', policy: 'mcts', budget: 12, branches: 4,
      maxDepth: 6, explorationWeight: 0.9,
      judgeSamplesRequested: 3,
      // The call budget is not on this row, so the realised ensemble is unknown.
      // Unknown is reported as unknown: echoing the request here is exactly the
      // claim that made a clamped run read as an honoured one.
      judgeSamplesRealised: null,
      mode: 'plan',
    }]);
  });

  // The invisible spend ceiling (2026-08-18). `judgeSamples` is a REQUEST; it
  // shares one per-evaluation call pool with check generation, so a request the
  // pool cannot fund runs smaller. The surface used to show only the request.
  test('a search that asked for 20 judges and ran 3 says both numbers', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 'clamped', task: 'twenty judges please', at: 1_000, nodes: 1,
      config: { budget: 4, branches: 2, judgeSamples: 20, maxEvalLLMCalls: 4, mode: 'build' },
    });
    expect(readForkRunParams(sql, ['clamped'])[0]).toMatchObject({
      judgeSamplesRequested: 20,
      judgeSamplesRealised: 3,
    });
  });

  // A plan search never runs the executor, so no call buys a check suite and the
  // whole pool is the ensemble's — one more than the same knobs give a build run.
  test('a plan search realises the whole call budget as its ensemble', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 'planned', task: 'weigh two designs', at: 1_000, nodes: 1,
      config: { budget: 4, branches: 2, judgeSamples: 20, maxEvalLLMCalls: 4, mode: 'plan' },
    });
    expect(readForkRunParams(sql, ['planned'])[0]).toMatchObject({
      judgeSamplesRequested: 20,
      judgeSamplesRealised: 4,
    });
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
  test('each fork arrives with its own parameters and its own tree', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'compete', at: 1_000, nodes: 3 });
    seedSplit(db, { rootId: 'm1', task: 'merge', at: 4_000, heads: 2, merged: true });
    seedSearch(db, { rootId: 's2', task: 'compete again', at: 6_000, nodes: 1 });

    const page = readExplorationCanvas(sql);
    expect(page.status).toBe('end');
    expect(page.items.map((entry) => entry.run.id)).toEqual(['s2', 'm1', 's1']);
    // Parameters travel WITH the fork, so there is no id to re-associate on and
    // no way for a row to be labelled with another fork's knobs.
    expect(page.items.map((entry) => entry.params?.policy)).toEqual(['mcts', 'merge', 'mcts']);
    expect(page.items.map((entry) => entry.tree.every((row) => row.root_id === entry.run.id)))
      .toEqual([true, true, true]);
    // A merge keeps its branches in the journal, so it carries no tree rows —
    // and carries the journalled run instead. Empty on BOTH halves is what
    // "this fork recorded nothing" means, so the two must not be confusable.
    const merge = page.items.find((entry) => entry.run.id === 'm1')!;
    expect(merge.tree).toEqual([]);
    expect(merge.head?.heads.map((head) => head.task)).toEqual(['angle 0', 'angle 1']);
    // A competition's branches ARE its tree; there is no journalled run to fetch.
    expect(page.items.filter((entry) => entry.run.settle === 'competed').map((entry) => entry.head))
      .toEqual([null, null]);
    expect(page.items.find((entry) => entry.run.id === 's1')!.tree).toHaveLength(4);
  });

  test('a merged fork on a later page still carries its branches', () => {
    const { db, sql } = freshDb();
    // The merge is the OLDEST fork here, so it is off page one. The surface used
    // to fetch the journalled half as ONE bounded `getHeadRuns` read taken
    // beside page one, which is a second window over an overlapping set: every
    // merged fork behind that window drew as "no branches were ever written"
    // while the journal held them. The page a fork is on now carries both
    // halves of it.
    seedSplit(db, { rootId: 'm1', task: 'merge', at: 1_000, heads: 2, merged: true });
    for (let i = 0; i < 4; i++) {
      seedSearch(db, { rootId: `s${i}`, task: `t${i}`, at: 5_000 + i * 1_000, nodes: 1 });
    }

    const first = readExplorationCanvas(sql, null, 2);
    expect(first.items.map((entry) => entry.run.id)).toEqual(['s3', 's2']);
    expect(first.status).toBe('more');

    let cursor: SeekCursor | null = first.status === 'more' ? first.next : null;
    let merge: ExplorationCanvasRun | undefined;
    for (let page = 0; cursor !== null && merge === undefined && page < 5; page++) {
      const next: Page<ExplorationCanvasRun> = readExplorationCanvas(sql, cursor, 2);
      merge = next.items.find((entry) => entry.run.id === 'm1');
      cursor = next.status === 'more' ? next.next : null;
    }
    expect(merge?.run.settle).toBe('merged');
    expect(merge?.head?.rootId).toBe('m1');
    expect(merge?.head?.heads).toHaveLength(2);
  });

  test('a big tree costs one slot, not forty', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'huge', task: 'huge', at: 1_000, nodes: 40 });
    seedSearch(db, { rootId: 'small', task: 'small', at: 5_000, nodes: 1 });

    const page = readExplorationCanvas(sql, null, 1);
    expect(page.items.map((entry) => entry.run.id)).toEqual(['small']);
    expect(page.status).toBe('more');
    // The page bounds FORKS. Asking for one still delivers that fork whole.
    expect(readExplorationCanvas(sql, page.status === 'more' ? page.next : null, 1)
      .items[0]!.tree).toHaveLength(41);
  });

  test('a search still being written cannot displace the fork the page shows', () => {
    const { db, sql } = freshDb();
    // `growing` STARTED first but is still receiving nodes, so it is the newest
    // by last write and the oldest by first write. The canvas used to pick its
    // trees by last write while the fork list picked by first write, so at a
    // page of one the list showed `settled` and the trees beside it belonged to
    // `growing` — a listed fork drawn with no tree, next to a tree for a fork
    // that was not listed.
    seedSearch(db, { rootId: 'growing', task: 'still going', at: 1_000, nodes: 1 });
    seedSearch(db, { rootId: 'settled', task: 'done', at: 5_000, nodes: 1 });
    db.query(`INSERT INTO search_nodes
      (id, parent_id, root_id, task, action, observation, depth, visits, value, status, created_at)
      VALUES ('growing-late', 'growing', 'growing', 'still going', 'late', '', 1, 1, 0.5, 'open', 9_000)`).run();

    const page = readExplorationCanvas(sql, null, 1);
    expect(page.items.map((entry) => entry.run.id)).toEqual(['settled']);
    expect(page.items[0]!.tree.every((row) => row.root_id === 'settled')).toBe(true);
  });

  test('a fork whose parameters are gone says so instead of inventing them', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'compete', at: 1_000, nodes: 1 });
    // The ledger prunes settled rows after a day; the tree stays forever.
    db.exec(`DELETE FROM mcts_search_runs WHERE root_id = 's1'`);

    const page = readExplorationCanvas(sql);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.params).toBeNull();
    expect(page.items[0]!.tree).toHaveLength(2);
  });

  test('legacy unscoped rows stay invisible, as they are to every scoped read', () => {
    const { db, sql } = freshDb();
    db.exec(`INSERT INTO search_nodes (id, task, action, depth, visits, value, status, created_at)
      VALUES ('legacy', 'old', '', 0, 1, 0.5, 'open', 500)`);
    expect(readExplorationCanvas(sql)).toEqual({ status: 'end', items: [] });
    expect(readSearchTree(sql, 'legacy')).toEqual([]);
  });

  test('an empty workspace is an exhausted page, not an error and not "more"', () => {
    const { sql } = freshDb();
    expect(readExplorationCanvas(sql)).toEqual({ status: 'end', items: [] });
  });

  test('a full walk reaches every fork exactly once', () => {
    const { db, sql } = freshDb();
    for (let i = 0; i < 7; i++) {
      seedSearch(db, { rootId: `s${i}`, task: `t${i}`, at: 1_000 * (i + 1), nodes: 1 });
    }
    seedSplit(db, { rootId: 'm1', task: 'merge', at: 3_500, heads: 2, merged: true });

    const seen: string[] = [];
    let cursor: SeekCursor | null = null;
    let pages = 0;
    for (;;) {
      const page: Page<ExplorationCanvasRun> = readExplorationCanvas(sql, cursor, 3);
      seen.push(...page.items.map((entry) => entry.run.id));
      pages++;
      if (page.status === 'end') break;
      cursor = page.next;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(['s6', 's5', 's4', 's3', 'm1', 's2', 's1', 's0']);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
