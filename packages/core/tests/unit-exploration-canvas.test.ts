/**
 * The canvas projection: every run in a workspace, and what each was dispatched
 * with.
 *
 * Four defects these pin, the first two from the owner's own screenshots:
 *
 *   1. "Currently I can choose a run and I only see that tree." The surface read
 *      ONE root, because the scoped read model exists precisely to stop a client
 *      folding an unscoped pile into whichever root it picked. So the fix is a
 *      canvas composed of scoped per-root reads — not the removal of scoping.
 *
 *   2. "the Exploration UI doesnt really differentiate properly between the run
 *      params i.e, if the settle is of mcts or what." A search and a journalled
 *      run carry different knobs; the surface could only say which OUTCOME each
 *      reached.
 *
 *   3. The trees and the run list beside them were bounded SEPARATELY, by
 *      different ordering keys — the run list by when a run started, the trees
 *      by when a search was last written to. Two windows over overlapping sets,
 *      so the canvas could draw a listed run with no tree and hold a tree for a
 *      run it had not listed. The runs now choose the roots, which is why there
 *      is no multi-root read left to disagree with them.
 *
 *   4. A run with BOTH halves — a swarm whose nodes are agents — arrived as two
 *      rows tagged with the removed `fork` verb's two settlements, and the fold
 *      here handed each row one half. The half that won the caller's dedup was
 *      the one with no tree, so a four-row tree and its winner never left the
 *      server. Both halves now travel on the one row the run has.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initHeadsTables } from '../src/heads/schema';
import { initSwarmNodeRecords, recordSwarmNode } from '../src/strategy/swarm-resume';
import { readSearchTree } from '../src/read-models/search-tree';
import { readForkRunParams } from '../src/read-models/fork-params';
import {
  readExplorationCanvas, readExplorationRun, type ExplorationCanvasRun,
} from '../src/read-models/exploration-canvas';
import type { Page, SeekCursor } from '../src/read-models/page';

function freshDb() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initSearchTables(execRaw, makeSql(db));
  initMctsSearchTable(execRaw, makeSql(db));
  initHeadsTables(execRaw, makeSql(db));
  initSwarmNodeRecords(execRaw);
  return { db, sql: makeSql(db) };
}

function seedSearch(db: Database, run: {
  rootId: string; task: string; at: number; nodes: number;
  config?: Record<string, number | string>; status?: string;
  /** The ensemble a candidate was OBSERVED to sample, as the engine records it. */
  realised?: number;
}): void {
  const insert = db.query(`INSERT INTO search_nodes
    (id, parent_id, root_id, task, action, observation, depth, visits, value, status, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, 1, 0.5, 'open', ?)`);
  insert.run(run.rootId, null, run.rootId, run.task, '', 0, run.at);
  for (let i = 0; i < run.nodes; i++) {
    insert.run(`${run.rootId}-b${i}`, run.rootId, run.rootId, run.task, `branch ${i}`, 1, run.at + i + 1);
  }
  db.query(`INSERT INTO mcts_search_runs
    (root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch,
     judge_samples_realised, created_at, updated_at)
    VALUES (?, ?, 'mcts', 'm', ?, 0, 8, ?, 0, ?, ?, ?)`).run(
    run.rootId, run.task,
    JSON.stringify(run.config ?? { budget: 8, branches: 3, maxDepth: 4, explorationWeight: 1.41, mode: 'build' }),
    run.status ?? 'converged', run.realised ?? null, run.at, run.at,
  );
}

function seedSplit(db: Database, run: {
  rootId: string; task: string; at: number; heads: number;
  strategy?: string; merged?: boolean; rationale?: string;
}): void {
  db.query(`INSERT INTO head_runs (root_id, rationale, spawned_at) VALUES (?, ?, ?)`)
    .run(run.rootId, run.rationale ?? run.task, run.at);
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
  test('a search reports the knobs it actually ran with', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 's1', task: 'pick a backfill', at: 1_000, nodes: 2,
      config: { budget: 12, branches: 4, maxDepth: 6, explorationWeight: 0.9, judgeSamples: 3, mode: 'plan' },
    });
    expect(readForkRunParams(sql, ['s1'])).toEqual([{
      rootId: 's1',
      search: {
        budget: 12, branches: 4, maxDepth: 6, explorationWeight: 0.9,
        judgeSamplesRequested: 3,
        // No candidate's ensemble was observed on this row, so the realised size is
        // unknown. Unknown is reported as unknown: echoing the request here is
        // exactly the claim that made a clamped run read as an honoured one.
        judgeSamplesRealised: null,
        mode: 'plan',
      },
      transcripts: null,
    }]);
  });

  // The invisible spend ceiling (2026-08-18). `judgeSamples` is a REQUEST; it
  // shares one per-evaluation call pool with check generation, so a request the
  // pool cannot fund runs smaller. The surface used to show only the request.
  test('a search that asked for 20 judges and was seen running 3 says both numbers', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 'clamped', task: 'twenty judges please', at: 1_000, nodes: 1,
      config: { budget: 4, branches: 2, judgeSamples: 20, mode: 'build' },
      realised: 3,
    });
    expect(readForkRunParams(sql, ['clamped'])[0]?.search).toMatchObject({
      judgeSamplesRequested: 20,
      judgeSamplesRealised: 3,
    });
  });

  // The realised size is OBSERVED, never predicted. The pool arithmetic gives the
  // CEILING a request is clamped to (mcts/evaluation.ts judgeCallBudget, pinned in
  // unit-mcts-evaluation.test.ts), and an evaluation that short-circuits before
  // judging never reaches it — so a run whose knobs imply three and whose only
  // candidate sampled one reports one.
  test('the realised ensemble is what was seen, not what the knobs imply', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 'observed', task: 'short-circuited', at: 1_000, nodes: 1,
      config: { budget: 4, branches: 2, judgeSamples: 20, mode: 'build' },
      realised: 1,
    });
    expect(readForkRunParams(sql, ['observed'])[0]?.search).toMatchObject({
      judgeSamplesRequested: 20,
      judgeSamplesRealised: 1,
    });
  });

  test('a journalled run reports its strategy and node count, and no budget at all', () => {
    const { db, sql } = freshDb();
    seedSplit(db, { rootId: 'm1', task: 'audit', at: 1_000, heads: 5, strategy: 'best_of' });
    expect(readForkRunParams(sql, ['m1'])).toEqual([{
      rootId: 'm1', search: null, transcripts: { mergeStrategy: 'best_of', branches: 5 },
    }]);
  });

  test('two runs of the same task that wrote different stores are told apart', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'same-search', task: 'name the product', at: 1_000, nodes: 3 });
    seedSplit(db, { rootId: 'same-journal', task: 'name the product', at: 2_000, heads: 5, merged: true });

    const params = readForkRunParams(sql, ['same-search', 'same-journal']);
    expect(params.map((entry) => [entry.rootId, entry.search !== null, entry.transcripts !== null]))
      .toEqual([['same-search', true, false], ['same-journal', false, true]]);
  });

  // The params half of the same either/or defect. A swarm writes a ledger row AND
  // journals every node, and these were keyed by root id into one map — so the
  // transcript entry overwrote the search entry and every swarm reported a strategy
  // label and no budget, no branches, no depth cap and no judge clamp at all.
  test('a run that wrote both stores reports BOTH halves on one entry', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 'swarm-1', task: 'cut p99', at: 1_000, nodes: 3,
      config: { budget: 12, branches: 3, maxDepth: 4, judgeSamples: 5, mode: 'build' },
      realised: 2,
    });
    seedSplit(db, { rootId: 'swarm-1', task: 'cut p99', at: 1_400, heads: 3, strategy: 'best_of', rationale: 'optimise' });

    const params = readForkRunParams(sql, ['swarm-1']);
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
  test('each run arrives with its own parameters and its own tree', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'search', at: 1_000, nodes: 3 });
    seedSplit(db, { rootId: 'm1', task: 'journal', at: 4_000, heads: 2, merged: true });
    seedSearch(db, { rootId: 's2', task: 'search again', at: 6_000, nodes: 1 });

    const page = readExplorationCanvas(sql);
    expect(page.status).toBe('end');
    expect(page.items.map((entry) => entry.run.id)).toEqual(['s2', 'm1', 's1']);
    // Parameters travel WITH the run, so there is no id to re-associate on and
    // no way for a row to be labelled with another run's knobs.
    expect(page.items.map((entry) => entry.params?.search !== null)).toEqual([true, false, true]);
    expect(page.items.map((entry) => entry.tree.every((row) => row.root_id === entry.run.id)))
      .toEqual([true, true, true]);
    // A journal-only run keeps its branches in the journal, so it carries no tree
    // rows — and carries the journalled run instead. Empty on BOTH halves is what
    // "this run recorded nothing" means, so the two must not be confusable.
    const journalled = page.items.find((entry) => entry.run.id === 'm1')!;
    expect(journalled.tree).toEqual([]);
    expect(journalled.head?.heads.map((head) => head.task)).toEqual(['angle 0', 'angle 1']);
    // A search-only run's branches ARE its tree; there is no journalled run to fetch.
    expect(page.items.filter((entry) => entry.run.hasSearchTree).map((entry) => entry.head))
      .toEqual([null, null]);
    expect(page.items.find((entry) => entry.run.id === 's1')!.tree).toHaveLength(4);
  });

  // THE DEFECT THIS READ MODEL WAS REWRITTEN FOR. One swarm root, both stores
  // written: the canvas gated each half on a settlement tag, so it delivered two
  // rows with one half each, and the half that sorted newer — the journal, with no
  // tree — is the one a caller's dedup keeps. Four tree rows and a 0.71 winner were
  // dropped before the response was serialised.
  test('a run that wrote both stores arrives ONCE, carrying both halves', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_000, nodes: 3,
      config: { budget: 12, branches: 3, maxDepth: 4, judgeSamples: 5, mode: 'build' },
      realised: 2,
    });
    db.exec(`UPDATE search_nodes SET status = 'terminal', value = 0.71 WHERE id = 'swarm-1-b0'`);
    seedSplit(db, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_400, heads: 3,
      strategy: 'best_of', rationale: 'optimise',
    });

    const page = readExplorationCanvas(sql);
    expect(page.items).toHaveLength(1);
    const entry = page.items[0]!;
    expect(entry.run).toMatchObject({
      id: 'swarm-1',
      task: 'cut p99 latency',
      hasSearchTree: true,
      hasNodeTranscripts: true,
      branches: 3,
      winnerScore: 0.71,
    });
    // Both halves, in full: the tree the search grew AND the transcript of every
    // node that grew it.
    expect(entry.tree).toHaveLength(4);
    expect(entry.tree.every((row) => row.root_id === 'swarm-1')).toBe(true);
    expect(entry.head?.heads).toHaveLength(3);
    // And both halves of its parameters, which the map keyed by root id used to
    // collapse to one.
    expect(entry.params?.search).toMatchObject({
      budget: 12, branches: 3, maxDepth: 4,
      judgeSamplesRequested: 5, judgeSamplesRealised: 2,
    });
    expect(entry.params?.transcripts).toEqual({ mergeStrategy: 'best_of', branches: 3 });
  });

  // The invariant the surface may rely on: a half is present on the row exactly
  // when the run says it has it, so nothing downstream needs a second check.
  test('every row agrees with its own summary about which halves it has', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'tree-only', task: 'a', at: 1_000, nodes: 2 });
    seedSplit(db, { rootId: 'journal-only', task: 'b', at: 2_000, heads: 2 });
    seedSearch(db, { rootId: 'both', task: 'c', at: 3_000, nodes: 1 });
    seedSplit(db, { rootId: 'both', task: 'c', at: 3_500, heads: 1 });

    const items = readExplorationCanvas(sql).items;
    expect(items).toHaveLength(3);
    for (const entry of items) {
      expect(entry.tree.length > 0).toBe(entry.run.hasSearchTree);
      expect(entry.head !== null).toBe(entry.run.hasNodeTranscripts);
    }
  });

  test('a journal-only run on a later page still carries its branches', () => {
    const { db, sql } = freshDb();
    // It is the OLDEST run here, so it is off page one. The surface used to fetch
    // the journalled half as ONE bounded `getHeadRuns` read taken beside page one,
    // which is a second window over an overlapping set: every journalled run behind
    // that window drew as "no branches were ever written" while the journal held
    // them. The page a run is on now carries both halves of it.
    seedSplit(db, { rootId: 'm1', task: 'journal', at: 1_000, heads: 2, merged: true });
    for (let i = 0; i < 4; i++) {
      seedSearch(db, { rootId: `s${i}`, task: `t${i}`, at: 5_000 + i * 1_000, nodes: 1 });
    }

    const first = readExplorationCanvas(sql, null, 2);
    expect(first.items.map((entry) => entry.run.id)).toEqual(['s3', 's2']);
    expect(first.status).toBe('more');

    let cursor: SeekCursor | null = first.status === 'more' ? first.next : null;
    let journalled: ExplorationCanvasRun | undefined;
    for (let page = 0; cursor !== null && journalled === undefined && page < 5; page++) {
      const next: Page<ExplorationCanvasRun> = readExplorationCanvas(sql, cursor, 2);
      journalled = next.items.find((entry) => entry.run.id === 'm1');
      cursor = next.status === 'more' ? next.next : null;
    }
    expect(journalled?.run.hasNodeTranscripts).toBe(true);
    expect(journalled?.run.hasSearchTree).toBe(false);
    expect(journalled?.head?.rootId).toBe('m1');
    expect(journalled?.head?.heads).toHaveLength(2);
  });

  test('a big tree costs one slot, not forty', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'huge', task: 'huge', at: 1_000, nodes: 40 });
    seedSearch(db, { rootId: 'small', task: 'small', at: 5_000, nodes: 1 });

    const page = readExplorationCanvas(sql, null, 1);
    expect(page.items.map((entry) => entry.run.id)).toEqual(['small']);
    expect(page.status).toBe('more');
    // The page bounds RUNS. Asking for one still delivers that run whole.
    expect(readExplorationCanvas(sql, page.status === 'more' ? page.next : null, 1)
      .items[0]!.tree).toHaveLength(41);
  });

  test('a search still being written cannot displace the run the page shows', () => {
    const { db, sql } = freshDb();
    // `growing` STARTED first but is still receiving nodes, so it is the newest
    // by last write and the oldest by first write. The canvas used to pick its
    // trees by last write while the run list picked by first write, so at a
    // page of one the list showed `settled` and the trees beside it belonged to
    // `growing` — a listed run drawn with no tree, next to a tree for a run
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

  test('a run whose parameters are gone says so instead of inventing them', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'searched', at: 1_000, nodes: 1 });
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

  test('a full walk reaches every run exactly once', () => {
    const { db, sql } = freshDb();
    for (let i = 0; i < 7; i++) {
      seedSearch(db, { rootId: `s${i}`, task: `t${i}`, at: 1_000 * (i + 1), nodes: 1 });
    }
    seedSplit(db, { rootId: 'm1', task: 'journalled', at: 3_500, heads: 2, merged: true });

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

describe('Pareto canvas evidence', () => {
  test('derives a stable nondominated frontier from durable vectors, not scalar tree values', () => {
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 'pareto', task: 'trade quality for cost', at: 1_000, nodes: 3 });
    const axes = [
      { id: 'quality', direction: 'maximise' as const },
      { id: 'cost', direction: 'minimise' as const },
    ];
    for (const [nodeId, evidence] of [
      ['pareto-b0', { quality: 0.9, cost: 10 }],
      ['pareto-b1', { quality: 0.8, cost: 2 }],
      ['pareto-b2', { quality: 0.7, cost: 12 }],
    ] as const) {
      recordSwarmNode(sql, {
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
    expect(readExplorationRun(sql, 'pareto')?.frontier).toEqual({
      axes,
      candidates: [
        { nodeId: 'pareto-b0', evidence: { quality: 0.9, cost: 10 } },
        { nodeId: 'pareto-b1', evidence: { quality: 0.8, cost: 2 } },
      ],
    });
  });
});
/**
 * The permalink read: ONE run, composed exactly as the page composes it. The
 * drill-down opens a single run by id, and its dispatch parameters used to travel
 * only on the canvas page — so the surface with the most room to show the judge
 * clamp was the one surface that could not read it.
 */

describe('readExplorationRun', () => {
  test('answers one run with every half the page would have given it', () => {
    const { db, sql } = freshDb();
    seedSearch(db, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_000, nodes: 2,
      config: { budget: 9, branches: 3, judgeSamples: 5, mode: 'build' }, realised: 2,
    });
    seedSplit(db, {
      rootId: 'swarm-1', task: 'cut p99 latency', at: 1_400, heads: 2, rationale: 'optimise',
    });
    // Deliberately off the newest page, so this cannot be the list read in disguise.
    for (let i = 0; i < 5; i++) {
      seedSearch(db, { rootId: `newer-${i}`, task: `newer ${i}`, at: 9_000 + i, nodes: 1 });
    }

    const entry = readExplorationRun(sql, 'swarm-1');
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
    const { db, sql } = freshDb();
    seedSearch(db, { rootId: 's1', task: 'one run', at: 1_000, nodes: 2 });
    const page = readExplorationCanvas(sql);
    expect(page.items).toHaveLength(1);
    expect(readExplorationRun(sql, 's1')).toEqual(page.items[0]!);
  });

  test('a root nothing wrote is null, not an empty row', () => {
    const { sql } = freshDb();
    expect(readExplorationRun(sql, 'never-existed')).toBeNull();
  });
});
