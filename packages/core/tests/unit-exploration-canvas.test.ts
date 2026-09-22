/**
 * The canvas projection: every run in a workspace, each composed from scoped per-root reads and
 * carrying both halves (tree and journal) and its dispatch parameters on one row.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { createTestActors, present } from '@kinu.run/test-utils';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initHeadsTables } from '../src/heads/schema';
import { initSwarmNodeRecords, recordSwarmNode } from '../src/strategy/swarm-resume';
import { readForkRunParams } from '../src/read-models/fork-params';
import {
  readExplorationCanvas, readExplorationRun, type ExplorationCanvasRun,
} from '../src/read-models/exploration-canvas';
import type { Page, SeekCursor } from '../src/session/page';

function freshDb() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  const sql = makeSql(db);
  initSearchTables(execRaw);
  initMctsSearchTable(execRaw);
  initHeadsTables(execRaw);
  initSwarmNodeRecords(execRaw);
  // A real actor: every table read here is actor-private.
  const actor = createTestActors(sql, execRaw).main;

  return { db, sql, actor, actorId: actor.actorId };
}

function seedSearch(db: Database, actorId: string, run: {
  rootId: string; task: string; at: number; nodes: number;
  config?: Record<string, number | string>; status?: string;
  realised?: number;
}): void {
  const insert = db.query(`INSERT INTO search_nodes
    (actor_id, id, parent_id, root_id, task, action, observation, depth, visits, value, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, 1, 0.5, 'open', ?)`);

  insert.run(actorId, run.rootId, null, run.rootId, run.task, '', 0, run.at);

  for (let i = 0; i < run.nodes; i++) {
    insert.run(actorId, `${run.rootId}-b${i}`, run.rootId, run.rootId, run.task, `branch ${i}`, 1, run.at + i + 1);
  }

  db.query(`INSERT INTO mcts_search_runs
    (actor_id, root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
     judge_samples_realised, created_at, updated_at)
    VALUES (?, ?, ?, 'mcts', 'm', ?, 0, 8, ?, 0, ?, ?, ?)`).run(
    actorId, run.rootId, run.task,
    JSON.stringify(run.config ?? { budget: 8, branches: 3, maxDepth: 4, explorationWeight: 1.41, mode: 'build' }),
    run.status ?? 'converged', run.realised ?? null, run.at, run.at,
  );
}

function seedSplit(db: Database, actorId: string, run: {
  rootId: string; task: string; at: number; heads: number;
  strategy?: string; merged?: boolean; rationale?: string;
}): void {
  db.query(`INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES (?, ?, ?, ?)`)
    .run(actorId, run.rootId, run.rationale ?? run.task, run.at);

  const insert = db.query(`INSERT INTO head_journal
    (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
    VALUES (?, ?, NULL, ?, 0, ?, 'r', 'completed', ?, ?)`);

  for (let i = 0; i < run.heads; i++) {
    insert.run(actorId, `${run.rootId}-h${i}`, run.rootId, `angle ${i}`, run.at + i, run.strategy ?? 'synthesize');
  }

  if (run.merged) {
    db.query(`INSERT INTO head_merge_results
      (actor_id, root_id, merged_narrative, selected_decisions_json, unresolved_questions_json,
       recommendations_json, cost_head_count, cost_total_tokens, cost_total_wall_ms,
       cost_max_depth, merged_at, merge_strategy)
      VALUES (?, ?, 'merged', '[]', '[]', '[]', ?, 10, 10, 1, ?, ?)`)
      .run(actorId, run.rootId, run.heads, run.at, run.strategy ?? 'synthesize');
  }
}

describe('readForkRunParams', () => {
  test('a search reports the knobs it actually ran with', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, {
      rootId: 's1', task: 'pick a backfill', at: 1_000, nodes: 2,
      config: { budget: 12, branches: 4, maxDepth: 6, explorationWeight: 0.9, judgeSamples: 3, mode: 'plan' },
    });
    expect(readForkRunParams(sql, actor, ['s1'])).toEqual([{
      rootId: 's1',
      search: {
        budget: 12, branches: 4, maxDepth: 6, explorationWeight: 0.9,
        judgeSamplesRequested: 3,
        // No candidate's ensemble was observed, so the realised size is unknown, not the request.
        judgeSamplesRealised: null,
        mode: 'plan',
      },
      transcripts: null,
    }]);
  });

  // `judgeSamples` is a request sharing one call pool with check generation, so it can run smaller.
  const ENSEMBLES = [
    {
      name: 'a search that asked for 20 judges and was seen running 3 says both numbers',
      rootId: 'clamped', task: 'twenty judges please', realised: 3,
    },
    {
      // Realised size is observed, never predicted (ceiling: mcts/evaluation.ts judgeCallBudget); an
      // evaluation that short-circuits before judging never reaches it.
      name: 'the realised ensemble is what was seen, not what the knobs imply',
      rootId: 'observed', task: 'short-circuited', realised: 1,
    },
  ];

  for (const ensemble of ENSEMBLES) {
    test(ensemble.name, () => {
      const { db, sql, actor, actorId } = freshDb();
      seedSearch(db, actorId, {
        rootId: ensemble.rootId, task: ensemble.task, at: 1_000, nodes: 1,
        config: { budget: 4, branches: 2, judgeSamples: 20, mode: 'build' },
        realised: ensemble.realised,
      });

      expect(readForkRunParams(sql, actor, [ensemble.rootId])[0]?.search).toMatchObject({
        judgeSamplesRequested: 20,
        judgeSamplesRealised: ensemble.realised,
      });
    });
  }

  test('a journalled run reports its strategy and node count, and no budget at all', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSplit(db, actorId, { rootId: 'm1', task: 'audit', at: 1_000, heads: 5, strategy: 'best_of' });
    expect(readForkRunParams(sql, actor, ['m1'])).toEqual([{
      rootId: 'm1', search: null, transcripts: { mergeStrategy: 'best_of', branches: 5 },
    }]);
  });

  test('two runs of the same task that wrote different stores are told apart', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 'same-search', task: 'name the product', at: 1_000, nodes: 3 });
    seedSplit(db, actorId, { rootId: 'same-journal', task: 'name the product', at: 2_000, heads: 5, merged: true });

    const params = readForkRunParams(sql, actor, ['same-search', 'same-journal']);
    expect(params.map((entry) => [entry.rootId, entry.search !== null, entry.transcripts !== null]))
      .toEqual([['same-search', true, false], ['same-journal', false, true]]);
  });

  // A swarm writes both a ledger row and a journal; keyed by root id alone, one overwrites the other.
  test('a run that wrote both stores reports BOTH halves on one entry', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, {
      rootId: 'swarm-1', task: 'cut p99', at: 1_000, nodes: 3,
      config: { budget: 12, branches: 3, maxDepth: 4, judgeSamples: 5, mode: 'build' },
      realised: 2,
    });
    seedSplit(db, actorId, { rootId: 'swarm-1', task: 'cut p99', at: 1_400, heads: 3, strategy: 'best_of', rationale: 'optimise' });

    const params = readForkRunParams(sql, actor, ['swarm-1']);
    expect(params).toHaveLength(1);
    expect(params[0]).toEqual({
      rootId: 'swarm-1',
      search: {
        budget: 12, branches: 3, maxDepth: 4, explorationWeight: null,
        judgeSamplesRequested: 5, judgeSamplesRealised: 2, mode: 'build',
      },
      transcripts: { mergeStrategy: 'best_of', branches: 3 },
    });
  });

  test('a run whose parameters were never recorded is absent, never defaulted', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 's1', task: 'pruned ledger', at: 1_000, nodes: 1 });
    db.run(`DELETE FROM mcts_search_runs WHERE actor_id = ? AND root_id = 's1'`, [actorId]);
    expect(readForkRunParams(sql, actor, ['s1'])).toEqual([]);
  });

  test('an unreadable config is absent rather than a run with invented numbers', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 's1', task: 'corrupt', at: 1_000, nodes: 1 });
    db.run(`UPDATE mcts_search_runs SET config_json = 'not json' WHERE actor_id = ? AND root_id = 's1'`, [actorId]);
    expect(readForkRunParams(sql, actor, ['s1'])).toEqual([]);

    db.run(`UPDATE mcts_search_runs SET config_json = '{"budget":"eight"}' WHERE actor_id = ? AND root_id = 's1'`, [actorId]);
    expect(readForkRunParams(sql, actor, ['s1'])).toEqual([]);
  });

  test('runs outside the asked-for set are never returned', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 'wanted', task: 'a', at: 1_000, nodes: 1 });
    seedSearch(db, actorId, { rootId: 'other', task: 'b', at: 2_000, nodes: 1 });
    expect(readForkRunParams(sql, actor, ['wanted']).map((entry) => entry.rootId)).toEqual(['wanted']);
    expect(readForkRunParams(sql, actor, [])).toEqual([]);
  });
});

describe('readExplorationCanvas', () => {
  test('each run arrives with its own parameters and its own tree', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 's1', task: 'search', at: 1_000, nodes: 3 });
    seedSplit(db, actorId, { rootId: 'm1', task: 'journal', at: 4_000, heads: 2, merged: true });
    seedSearch(db, actorId, { rootId: 's2', task: 'search again', at: 6_000, nodes: 1 });

    const page = readExplorationCanvas(sql, actor);
    expect(page.status).toBe('end');
    expect(page.items.map((entry) => entry.run.id)).toEqual(['s2', 'm1', 's1']);
    expect(page.items.map((entry) => entry.params?.search !== null)).toEqual([true, false, true]);
    expect(page.items.map((entry) => entry.tree.every((row) => row.root_id === entry.run.id)))
      .toEqual([true, true, true]);
    // A journal-only run has no tree rows; empty on both halves means the run recorded nothing.
    const journalled = present(page.items.find((entry) => entry.run.id === 'm1'), 'the m1 run on the canvas');
    expect(journalled.tree).toEqual([]);
    expect(journalled.head?.heads.map((head) => head.task)).toEqual(['angle 0', 'angle 1']);
    expect(page.items.filter((entry) => entry.run.hasSearchTree).map((entry) => entry.head))
      .toEqual([null, null]);
    expect(present(page.items.find((entry) => entry.run.id === 's1'), 'the s1 run on the canvas').tree).toHaveLength(4);
  });

  // One swarm root with both stores written must arrive as one row with both halves, not two rows
  // of which a caller's dedup keeps the treeless one.
  test('a run that wrote both stores arrives ONCE, carrying both halves', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_000, nodes: 3,
      config: { budget: 12, branches: 3, maxDepth: 4, judgeSamples: 5, mode: 'build' },
      realised: 2,
    });
    db.exec(`UPDATE search_nodes SET status = 'terminal', value = 0.71 WHERE id = 'swarm-1-b0'`);
    seedSplit(db, actorId, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_400, heads: 3,
      strategy: 'best_of', rationale: 'optimise',
    });

    const page = readExplorationCanvas(sql, actor);
    expect(page.items).toHaveLength(1);
    const entry = page.items[0];
    expect(entry.run).toMatchObject({
      id: 'swarm-1',
      task: 'cut p99 latency',
      hasSearchTree: true,
      hasNodeTranscripts: true,
      branches: 3,
      winnerScore: 0.71,
    });
    expect(entry.tree).toHaveLength(4);
    expect(entry.tree.every((row) => row.root_id === 'swarm-1')).toBe(true);
    expect(entry.head?.heads).toHaveLength(3);
    // Both halves of its parameters: a map keyed by root id alone collapses them.
    expect(entry.params?.search).toMatchObject({
      budget: 12, branches: 3, maxDepth: 4,
      judgeSamplesRequested: 5, judgeSamplesRealised: 2,
    });
    expect(entry.params?.transcripts).toEqual({ mergeStrategy: 'best_of', branches: 3 });
  });

  // A half is present exactly when the run says it has it.
  test('every row agrees with its own summary about which halves it has', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 'tree-only', task: 'a', at: 1_000, nodes: 2 });
    seedSplit(db, actorId, { rootId: 'journal-only', task: 'b', at: 2_000, heads: 2 });
    seedSearch(db, actorId, { rootId: 'both', task: 'c', at: 3_000, nodes: 1 });
    seedSplit(db, actorId, { rootId: 'both', task: 'c', at: 3_500, heads: 1 });

    const items = readExplorationCanvas(sql, actor).items;
    expect(items).toHaveLength(3);

    for (const entry of items) {
      expect(entry.tree.length > 0).toBe(entry.run.hasSearchTree);
      expect(entry.head !== null).toBe(entry.run.hasNodeTranscripts);
    }
  });

  test('a journal-only run on a later page still carries its branches', () => {
    const { db, sql, actor, actorId } = freshDb();
    // The oldest run, off page one: a separate bounded journal read would miss it.
    seedSplit(db, actorId, { rootId: 'm1', task: 'journal', at: 1_000, heads: 2, merged: true });

    for (let i = 0; i < 4; i++) {
      seedSearch(db, actorId, { rootId: `s${i}`, task: `t${i}`, at: 5_000 + i * 1_000, nodes: 1 });
    }

    const first = readExplorationCanvas(sql, actor, null, 2);
    expect(first.items.map((entry) => entry.run.id)).toEqual(['s3', 's2']);
    expect(first.status).toBe('more');

    let cursor: SeekCursor | null = first.status === 'more' ? first.next : null;
    let journalled: ExplorationCanvasRun | undefined;

    for (let page = 0; cursor !== null && journalled === undefined && page < 5; page++) {
      const next: Page<ExplorationCanvasRun> = readExplorationCanvas(sql, actor, cursor, 2);
      journalled = next.items.find((entry) => entry.run.id === 'm1');
      cursor = next.status === 'more' ? next.next : null;
    }

    expect(journalled?.run.hasNodeTranscripts).toBe(true);
    expect(journalled?.run.hasSearchTree).toBe(false);
    expect(journalled?.head?.rootId).toBe('m1');
    expect(journalled?.head?.heads).toHaveLength(2);
  });

  test('a big tree costs one slot, not forty', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 'huge', task: 'huge', at: 1_000, nodes: 40 });
    seedSearch(db, actorId, { rootId: 'small', task: 'small', at: 5_000, nodes: 1 });

    const page = readExplorationCanvas(sql, actor, null, 1);
    expect(page.items.map((entry) => entry.run.id)).toEqual(['small']);
    expect(page.status).toBe('more');
    expect(readExplorationCanvas(sql, actor, page.status === 'more' ? page.next : null, 1)
      .items[0].tree).toHaveLength(41);
  });

  test('a search still being written cannot displace the run the page shows', () => {
    const { db, sql, actor, actorId } = freshDb();
    // `growing` started first but was written last: roots must be picked by the run list's order, not last write.
    seedSearch(db, actorId, { rootId: 'growing', task: 'still going', at: 1_000, nodes: 1 });
    seedSearch(db, actorId, { rootId: 'settled', task: 'done', at: 5_000, nodes: 1 });
    db.query(`INSERT INTO search_nodes
      (actor_id, id, parent_id, root_id, task, action, observation, depth, visits, value, status, created_at)
      VALUES (?, 'growing-late', 'growing', 'growing', 'still going', 'late', '', 1, 1, 0.5, 'open', 9_000)`)
      .run(actorId);

    const page = readExplorationCanvas(sql, actor, null, 1);
    expect(page.items.map((entry) => entry.run.id)).toEqual(['settled']);
    expect(page.items[0].tree.every((row) => row.root_id === 'settled')).toBe(true);
  });

  test('a run whose parameters are gone says so instead of inventing them', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 's1', task: 'searched', at: 1_000, nodes: 1 });
    db.run(`DELETE FROM mcts_search_runs WHERE actor_id = ? AND root_id = 's1'`, [actorId]);

    const page = readExplorationCanvas(sql, actor);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].params).toBeNull();
    expect(page.items[0].tree).toHaveLength(2);
  });

  test('an empty workspace is an exhausted page, not an error and not "more"', () => {
    const { sql, actor } = freshDb();
    expect(readExplorationCanvas(sql, actor)).toEqual({ status: 'end', items: [] });
  });

  test('a full walk reaches every run exactly once', () => {
    const { db, sql, actor, actorId } = freshDb();

    for (let i = 0; i < 7; i++) {
      seedSearch(db, actorId, { rootId: `s${i}`, task: `t${i}`, at: 1_000 * (i + 1), nodes: 1 });
    }

    seedSplit(db, actorId, { rootId: 'm1', task: 'journalled', at: 3_500, heads: 2, merged: true });

    const seen: string[] = [];
    let cursor: SeekCursor | null = null;
    let pages = 0;

    for (;;) {
      const page: Page<ExplorationCanvasRun> = readExplorationCanvas(sql, actor, cursor, 3);
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

describe('Pareto canvas evidence', () => {
  test('derives a stable nondominated frontier from durable vectors, not scalar tree values', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 'pareto', task: 'trade quality for cost', at: 1_000, nodes: 3 });

    const axes = [
      { id: 'quality', direction: 'maximise' as const },
      { id: 'cost', direction: 'minimise' as const },
    ];

    for (const [nodeId, evidence] of [
      ['pareto-b0', { quality: 0.9, cost: 10 }],
      ['pareto-b1', { quality: 0.8, cost: 2 }],
      ['pareto-b2', { quality: 0.7, cost: 12 }],
    ] as const) {
      recordSwarmNode(sql, actor, {
        rootId: 'pareto',
        nodeId,
        record: {
          outcome: { kind: 'pareto', axes, evidence, detail: 'measured' },
          conclusion: null,
          aggregated: [],
          tokens: null,
        },
        now: 1_000,
      });
    }

    expect(readExplorationRun(sql, actor, 'pareto')?.frontier).toEqual({
      axes,
      candidates: [
        { nodeId: 'pareto-b0', evidence: { quality: 0.9, cost: 10 } },
        { nodeId: 'pareto-b1', evidence: { quality: 0.8, cost: 2 } },
      ],
    });
  });
});
/** The permalink read: one run by id, composed exactly as the page composes it, with its parameters. */

describe('readExplorationRun', () => {
  test('answers one run with every half the page would have given it', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_000, nodes: 2,
      config: { budget: 9, branches: 3, judgeSamples: 5, mode: 'build' }, realised: 2,
    });
    seedSplit(db, actorId, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_400, heads: 2, rationale: 'optimise',
    });

    // Off the newest page, so this is not the list read in disguise.
    for (let i = 0; i < 5; i++) {
      seedSearch(db, actorId, { rootId: `newer-${i}`, task: `newer ${i}`, at: 9_000 + i, nodes: 1 });
    }

    const entry = readExplorationRun(sql, actor, 'swarm-1');
    expect(entry?.run).toMatchObject({
      id: 'swarm-1', task: 'cut p99 latency', hasSearchTree: true, hasNodeTranscripts: true,
    });
    expect(entry?.tree).toHaveLength(3);
    expect(entry?.head?.heads).toHaveLength(2);
    expect(entry?.params?.search).toMatchObject({
      budget: 9, judgeSamplesRequested: 5, judgeSamplesRealised: 2,
    });
  });

  test('says exactly what the page says about the same run', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearch(db, actorId, { rootId: 's1', task: 'one run', at: 1_000, nodes: 2 });
    const page = readExplorationCanvas(sql, actor);
    expect(page.items).toHaveLength(1);
    expect(readExplorationRun(sql, actor, 's1')).toEqual(page.items[0]);
  });

  test('a root nothing wrote is null, not an empty row', () => {
    const { sql, actor } = freshDb();
    expect(readExplorationRun(sql, actor, 'never-existed')).toBeNull();
  });
});
