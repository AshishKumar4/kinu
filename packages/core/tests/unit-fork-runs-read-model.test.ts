/** One root id, one run: journal (`head_journal`) and tree (`search_nodes`) halves fold into one
 *  row with one order and status vocabulary; Steer-as-Branch redirects never appear. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createMockSession, createTestRuntime, makeSql, makeExecRaw } from './helpers';
import { createTestActors, present } from '@kinu.run/test-utils';
import { initSearchTables } from '../src/mcts/schemas';
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { backpropagate } from '../src/mcts/backpropagation';
import { converge } from '../src/mcts/convergence';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { initHeadsTables } from '../src/heads/schema';
import { listForkRuns, readForkRun } from '../src/read-models/fork-runs';
import { readExplorationCanvas } from '../src/read-models/exploration-canvas';
import { explorationForkTree } from '../src/read-models/fork-tree-rows';
import { readSearchTree } from '../src/read-models/search-tree';
import { terminalForkNode } from '../src/read-models/swarm-tree-model';
import { HeadJournal } from '../src/heads/journal';
import { newBranchId } from '../src/steer-branch';
import type { Page, SeekCursor } from '../src/session/page';
import type { ForkRunSummary } from '../src/read-models/fork-runs';

function freshDb() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  const sql = makeSql(db);
  initSearchTables(execRaw);
  initSwarmNodeRecords(execRaw);
  initMctsSearchTable(execRaw);
  initHeadsTables(execRaw);
  // Both stores are actor-private; the directory is returned so a case can issue a real sibling.
  const actors = createTestActors(sql, execRaw);

  return { db, sql, actors, actor: actors.main, actorId: actors.main.actorId };
}

/** A top-level split's root id is synthetic (no journal row carries it), hence grouping by
 *  head_journal. `parentHead` covers the recursive case, where a real head is the root. */
function seedJournalledRun(
  db: Database,
  actorId: string,
  run: {
    rootId: string; task: string; at: number; heads: Array<{ status: string }>;
    merged?: boolean; parentHead?: { status: string }; rationale?: string;
  },
): void {
  db.prepare(`INSERT INTO head_runs (actor_id, root_id, rationale, spawned_at) VALUES (?, ?, ?, ?)`)
    .run(actorId, run.rootId, run.rationale ?? run.task, run.at);

  if (run.parentHead) {
    db.prepare(
      `INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
       VALUES (?, ?, NULL, ?, 0, ?, '', ?, ?, 'synthesize')`,
    ).run(actorId, run.rootId, run.rootId, `parent of ${run.task}`, run.parentHead.status, run.at);
  }

  for (const [i, head] of run.heads.entries()) {
    db.prepare(
      `INSERT INTO head_journal (actor_id, id, parent_id, root_id, depth, task, rationale, status, spawned_at, merge_strategy)
       VALUES (?, ?, ?, ?, 1, ?, '', ?, ?, 'synthesize')`,
    ).run(actorId, `${run.rootId}-h${i}`, run.parentHead ? run.rootId : null, run.rootId, `branch ${i}`, head.status, run.at + i);
  }

  if (run.merged) {
    db.prepare(
      `INSERT INTO head_merge_results
         (actor_id, root_id, merged_narrative, cost_head_count, cost_total_tokens, cost_total_wall_ms, cost_max_depth, merged_at, merge_strategy)
       VALUES (?, ?, 'synthesis', ?, 0, 0, 1, ?, 'synthesize')`,
    ).run(actorId, run.rootId, run.heads.length, run.at + 100);
  }
}

function seedSearchRun(
  db: Database,
  actorId: string,
  run: {
    rootId: string; task: string; at: number; branches: number;
    /** The root's own label, which is the run's name. */
    name?: string;
    winner?: number;
    ledger?: 'running' | 'converged' | 'failed' | 'no_acceptable_candidate';
  },
): void {
  const node = db.prepare(
    `INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, action, observation, visits, value, depth, status, created_at, evaluation_json)
     VALUES (?, ?, ?, ?, ?, ?, '', 1, ?, ?, ?, ?, ?)`,
  );

  node.run(actorId, run.rootId, null, run.rootId, run.task, run.name ?? '', 0, 0, 'open', run.at, null);

  for (let i = 0; i < run.branches; i++) {
    const isWinner = run.winner !== undefined && i === 0;
    // A leaf's mean is its own score: one reward reached it.
    const score = isWinner ? run.winner ?? 0 : 0.2;
    node.run(
      actorId, `${run.rootId}-n${i}`, run.rootId, run.rootId, run.task, '',
      score, 1, isWinner ? 'terminal' : 'pruned', run.at + i + 1, JSON.stringify({ score }),
    );
  }

  if (run.ledger) {
    db.prepare(
      `INSERT INTO mcts_search_runs (actor_id, root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch, created_at, updated_at)
       VALUES (?, ?, ?, 'mcts', 'm1', '{}', 3, 9, ?, 0, ?, ?)`,
    ).run(actorId, run.rootId, run.task, run.ledger, run.at, run.at);
  }
}

/** A run's name: the caller's name (the root node's label), else derived from the task. */
describe('a run carries a name', () => {
  test('the name the caller gave is what the run is called', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearchRun(db, actorId, {
      rootId: 'r-named', task: 'Security and code audit of the repo at /home/main/kinu — a self-evolving agent runtime',
      at: 1000, branches: 3, name: 'repo audit', ledger: 'converged',
    });
    expect(readForkRun(sql, actor, 'r-named')?.name).toBe('repo audit');
  });

  test('a run that named nothing is called by its task\'s first clause', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearchRun(db, actorId, {
      rootId: 'r-derived', task: 'Security and code audit of the repo — a self-evolving agent runtime with a Cloudflare backend',
      at: 1000, branches: 2, ledger: 'converged',
    });
    // Cut where the task itself offers a cut, and never the whole paragraph.
    expect(readForkRun(sql, actor, 'r-derived')?.name).toBe('Security and code audit of the repo');
  });

  test('a task with no clause break is cut at a word, not mid-word', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearchRun(db, actorId, {
      rootId: 'r-long',
      task: 'Reproduce the checkout regression against the staging snapshot and report what the guard actually does',
      at: 1000, branches: 1, ledger: 'converged',
    });
    const name = readForkRun(sql, actor, 'r-long')?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name.endsWith(' ')).toBe(false);
    expect('Reproduce the checkout regression against the staging snapshot'.startsWith(name)).toBe(true);
  });

  test('a journal-only run is named too', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedJournalledRun(db, actorId, {
      rootId: 'r-journal', task: 'Audit the CLI surface, then the daemon', at: 1000,
      heads: [{ status: 'completed' }], merged: true,
    });
    expect(readForkRun(sql, actor, 'r-journal')?.name).toBe('Audit the CLI surface');
  });
});

describe('listForkRuns', () => {
  test('lists runs from both stores in one chronological order', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedJournalledRun(db, actorId, { rootId: 'r-merge-old', task: 'audit the CLI', at: 1000, heads: [{ status: 'completed' }, { status: 'completed' }], merged: true });
    seedSearchRun(db, actorId, { rootId: 'r-search', task: 'pick a backfill', at: 2000, branches: 5, winner: 0.82, ledger: 'converged' });
    seedJournalledRun(db, actorId, { rootId: 'r-merge-new', task: 'split the docs', at: 3000, heads: [{ status: 'running' }] });

    const runs = listForkRuns(sql, actor, null, 20).items;
    expect(runs.map((r) => r.id)).toEqual(['r-merge-new', 'r-search', 'r-merge-old']);
    expect(runs.map((r) => [r.hasSearchTree, r.hasNodeTranscripts]))
      .toEqual([[false, true], [true, false], [false, true]]);
  });

  test('a run with a tree carries its branch count and winning score', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearchRun(db, actorId, { rootId: 'r1', task: 'pick a backfill', at: 2000, branches: 6, winner: 0.82, ledger: 'converged' });
    const [run] = listForkRuns(sql, actor).items;
    expect(run).toMatchObject({
      task: 'pick a backfill', hasSearchTree: true, hasNodeTranscripts: false,
      status: 'completed', branches: 6, winnerScore: 0.82,
    });
  });

  test("the run list and the explorer page show the winner score converge reported, not its subtree mean", async () => {
    const { rt } = createTestRuntime();
    const { sql } = rt.storage;
    const actorId = rt.actor.actorId;

    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${actorId}, 'R', NULL, 'R', 'pick a backfill', 'pick a backfill', 0)`;

    // A strong proposal whose refinement scored low: its own score stays 0.9, its mean falls to 0.5.
    for (const [id, parent, depth, score] of [['a', 'R', 1, 0.9], ['a1', 'a', 2, 0.1]] as const) {
      void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth, evaluation_json)
        VALUES (${actorId}, ${id}, ${parent}, 'R', 'pick a backfill', ${`answer ${id}`}, ${depth}, ${JSON.stringify({ score })})`;
      backpropagate(sql, rt.actor, id, score);
    }

    const result = await converge(rt, createMockSession(), 'R', { mode: 'plan' });
    const mean = sql<{ value: number }>`SELECT value FROM search_nodes WHERE actor_id = ${actorId} AND id = 'a'`[0]?.value;

    expect(result).toMatchObject({ converged: true, winnerId: 'a', winnerValue: 0.9 });
    expect(mean).toBeCloseTo(0.5, 12);
    expect(readForkRun(sql, rt.actor, 'R')?.winnerScore).toBe(result.winnerValue);
    // The explorer page folds `getSearchTree`'s rows and names the terminal vertex Winner.
    const drawn = explorationForkTree({ tree: readSearchTree(sql, rt.actor, 'R'), head: null });
    expect(terminalForkNode(present(drawn, 'the drawn tree'))?.value).toBe(result.winnerValue);
  });

  test('a journalled run counts its nodes and has no winner — nothing there ranked', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedJournalledRun(db, actorId, { rootId: 'r1', task: 'audit the CLI', at: 1000, heads: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }], merged: true });
    const [run] = listForkRuns(sql, actor).items;
    expect(run).toMatchObject({
      task: 'audit the CLI', hasSearchTree: false, hasNodeTranscripts: true,
      status: 'completed', branches: 3, winnerScore: null,
    });
  });

  const SECOND_HEAD_DECIDES = [
    { name: 'a run with a node still going reads as running', second: 'running', status: 'running' },
    { name: 'nodes that errored without a synthesis read as partial, not completed', second: 'errored', status: 'partial' },
  ] as const;

  for (const decided of SECOND_HEAD_DECIDES) {
    test(decided.name, () => {
      const { db, sql, actor, actorId } = freshDb();
      seedJournalledRun(db, actorId, {
        rootId: 'r1', task: 'audit', at: 1000,
        heads: [{ status: 'completed' }, { status: decided.second }],
      });

      expect(listForkRuns(sql, actor).items[0].status).toBe(decided.status);
    });
  }

  test("a recursive sub-split is judged by its parent head, as the detail view judges it", () => {
    // Must agree with HeadJournal.assembleRun's preference for the root head row's status.
    const { db, sql, actor, actorId } = freshDb();
    seedJournalledRun(db, actorId, {
      rootId: 'r1', task: 'nested', at: 1000, parentHead: { status: 'running' },
      heads: [{ status: 'completed' }, { status: 'completed' }],
    });
    const [run] = listForkRuns(sql, actor).items;
    expect(run).toMatchObject({ status: 'running', branches: 2, task: 'parent of nested' });
  });

  test('a search whose ledger row was pruned still lists, judged by its own tree', () => {
    // mcts_search_runs prunes settled rows after a day; search_nodes keeps the tree forever.
    const { db, sql, actor, actorId } = freshDb();
    seedSearchRun(db, actorId, { rootId: 'r-won', task: 'old but decided', at: 1000, branches: 3, winner: 0.9 });
    seedSearchRun(db, actorId, { rootId: 'r-stopped', task: 'old and abandoned', at: 900, branches: 2 });
    const runs = listForkRuns(sql, actor).items;
    expect(runs.map((r) => [r.id, r.status])).toEqual([['r-won', 'completed'], ['r-stopped', 'partial']]);
  });

  test('a failed search says failed', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearchRun(db, actorId, { rootId: 'r1', task: 'doomed', at: 1000, branches: 1, ledger: 'failed' });
    expect(listForkRuns(sql, actor).items[0].status).toBe('failed');
  });

  test('a settled search with no acceptable candidate never reads completed', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSearchRun(db, actorId, {
      rootId: 'r1',
      task: 'nothing cleared the floor',
      at: 1000,
      branches: 2,
      ledger: 'no_acceptable_candidate',
    });
    const [run] = listForkRuns(sql, actor).items;
    expect(run).toMatchObject({
      status: 'failed',
      winnerScore: null,
    });
  });

  test('Steer-as-Branch redirects are not exploration runs', () => {
    // A mid-turn redirect renders as a chip on the message it forked, not as a run here.
    const { db, sql, actor, actorId } = freshDb();
    const branchId = newBranchId();
    seedJournalledRun(db, actorId, { rootId: branchId, task: 'user redirect', at: 2000, heads: [{ status: 'completed' }], merged: true });
    seedJournalledRun(db, actorId, { rootId: 'r-real', task: 'a real run', at: 1000, heads: [{ status: 'completed' }], merged: true });
    expect(listForkRuns(sql, actor).items.map((r) => r.id)).toEqual(['r-real']);
  });

  test('Steer-as-Branch rows cannot consume the page limit before they are excluded', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedJournalledRun(db, actorId, {
      rootId: 'r-real', task: 'the real run', at: 1000,
      heads: [{ status: 'completed' }], merged: true,
    });

    for (let index = 0; index < 30; index += 1) {
      seedJournalledRun(db, actorId, {
        rootId: newBranchId(), task: `redirect ${index}`, at: 2000 + index,
        heads: [{ status: 'completed' }], merged: true,
      });
    }

    expect(listForkRuns(sql, actor, null, 30).items.map((run) => run.id)).toEqual(['r-real']);
  });

  test('the limit bounds the run list, not each store', () => {
    const { db, sql, actor, actorId } = freshDb();

    for (let i = 0; i < 4; i++) {
      seedJournalledRun(db, actorId, { rootId: `m${i}`, task: `merge ${i}`, at: 1000 + i * 10, heads: [{ status: 'completed' }], merged: true });
      seedSearchRun(db, actorId, { rootId: `s${i}`, task: `search ${i}`, at: 1005 + i * 10, branches: 2, winner: 0.5, ledger: 'converged' });
    }

    const runs = listForkRuns(sql, actor, null, 3).items;
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.id)).toEqual(['s3', 'm3', 's2']);
  });

  test('an exact lookup reaches a run outside the recent-list window', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedJournalledRun(db, actorId, {
      rootId: 'bookmarked', task: 'historical run', at: 1,
      heads: [{ status: 'completed' }], merged: true,
    });

    for (let index = 0; index < 30; index += 1) {
      seedSearchRun(db, actorId, {
        rootId: `recent-${index}`, task: `recent ${index}`, at: 100 + index,
        branches: 1, winner: 0.5, ledger: 'converged',
      });
    }

    expect(listForkRuns(sql, actor, null, 30).items.some((run) => run.id === 'bookmarked')).toBe(false);
    expect(readForkRun(sql, actor, 'bookmarked')).toMatchObject({
      id: 'bookmarked', task: 'historical run', hasSearchTree: false, hasNodeTranscripts: true,
    });
    expect(readForkRun(sql, actor, 'missing')).toBeNull();
  });

  test('nothing searched yet is an empty list, not a throw', () => {
    const { sql, actor } = freshDb();
    expect(listForkRuns(sql, actor).items).toEqual([]);
  });
});

/** Two actors, one database: tree aggregates sum over `root_id`, so they must be actor-scoped.
 *  Each case asserts the own read first, so seeding nothing cannot pass. */
describe('the run list is folded per actor, not per database', () => {
  test('a sibling search tree is neither listed nor readable as a run', () => {
    const { db, sql, actors, actor, actorId } = freshDb();
    const other = actors.sibling('other');
    seedSearchRun(db, actorId, {
      rootId: 'mine', task: 'my search', at: 100, branches: 2, winner: 0.7, ledger: 'converged',
    });
    seedSearchRun(db, other.actorId, {
      rootId: 'theirs', task: 'their search', at: 200, branches: 3, winner: 0.9, ledger: 'converged',
    });

    const listed = listForkRuns(sql, actor, null, 50).items;

    expect(listed.map((run) => run.id)).toEqual(['mine']);
    expect(listed[0]).toMatchObject({ task: 'my search', branches: 2, hasSearchTree: true });
    // Not visible even by exact id.
    expect(readForkRun(sql, actor, 'theirs')).toBeNull();
    // The stranger still sees its own: a filter, not a broken read.
    expect(listForkRuns(sql, other, null, 50).items.map((run) => run.id)).toEqual(['theirs']);
  });

  test('two actors that ran the same root id do not pool their branches', () => {
    const { db, sql, actors, actor, actorId } = freshDb();
    const other = actors.sibling('other');
    seedSearchRun(db, actorId, {
      rootId: 'shared', task: 'mine', at: 100, branches: 2, winner: 0.7, ledger: 'converged',
    });
    seedSearchRun(db, other.actorId, {
      rootId: 'shared', task: 'theirs', at: 100, branches: 5, winner: 0.9, ledger: 'converged',
    });

    const mine = listForkRuns(sql, actor, null, 50).items;

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: 'shared', task: 'mine', branches: 2 });
    expect(listForkRuns(sql, other, null, 50).items[0]).toMatchObject({ task: 'theirs', branches: 5 });
  });

  test("a sibling's child node does not make my open root read as expanded", () => {
    // A stranger's node parented on mine must not empty my frontier and settle a running search.
    const { db, sql, actors, actor, actorId } = freshDb();
    const other = actors.sibling('other');
    seedSearchRun(db, actorId, { rootId: 'mine', task: 'my search', at: 100, branches: 0 });

    expect(listForkRuns(sql, actor, null, 50).items[0]).toMatchObject({
      id: 'mine', status: 'running',
    });

    db.prepare(
      `INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, action, observation,
                                 visits, value, depth, status, created_at)
       VALUES (?, 'squatter', 'mine', 'their-root', 'their search', '', '', 1, 0.1, 1, 'open', 150)`,
    ).run(other.actorId);

    expect(listForkRuns(sql, actor, null, 50).items[0]).toMatchObject({
      id: 'mine', status: 'running',
    });
  });
});

/** `mcts_search_runs.status='running'` is a lease, not an observation: the engine closes the tree
 *  before recording an outcome, so the tree's frontier decides running vs settled. */
describe('a stale running lease', () => {
  /** Raw inserts: the node statuses are the evidence under test. */
  function seedTree(
    db: Database,
    actorId: string,
    run: { rootId: string; root: string; branches: readonly string[]; ledger?: string },
  ): void {
    const node = db.prepare(
      `INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, action, observation, visits, value, depth, status, created_at, evaluation_json)
       VALUES (?, ?, ?, ?, 'audit the coupon guard', '', '', 1, ?, ?, ?, ?, ?)`,
    );

    node.run(actorId, run.rootId, null, run.rootId, 0, 0, run.root, 1000, null);

    for (const [index, status] of run.branches.entries()) {
      node.run(actorId, `${run.rootId}-n${index}`, run.rootId, run.rootId, 0.4, 1, status, 1001 + index, JSON.stringify({ score: 0.4 }));
    }

    if (run.ledger) {
      db.prepare(
        `INSERT INTO mcts_search_runs (actor_id, root_id, task, engine, root_msg_id, config_json, iteration, budget, status, epoch, created_at, updated_at)
         VALUES (?, ?, 'audit the coupon guard', 'mcts', 'm1', '{}', 3, 0, ?, 0, 1000, 1000)`,
      ).run(actorId, run.rootId, run.ledger);
    }
  }

  test('a closed tree under a running row stopped without an answer', () => {
    // Nodes reported/stopped, nothing won, lease never settled (`abandonSearchTree` marks `failed`).
    const { db, sql, actor, actorId } = freshDb();
    seedTree(db, actorId, {
      rootId: 'r-stale', root: 'failed',
      branches: ['failed', 'failed', 'failed', 'failed'],
      ledger: 'running',
    });
    expect(listForkRuns(sql, actor).items[0].status).toBe('partial');
  });

  test('a tree that converged under a running row is settled, not running', () => {
    // `converge` closed the tree and the `converged` write never landed.
    const { db, sql, actor, actorId } = freshDb();
    seedTree(db, actorId, {
      rootId: 'r-won', root: 'pruned', branches: ['terminal', 'pruned'], ledger: 'running',
    });
    expect(listForkRuns(sql, actor).items[0]).toMatchObject({ status: 'completed', winnerScore: 0.4 });
  });

  test('a search with a frontier left is still running', () => {
    // An open childless node is selectable, so this run is at work.
    const { db, sql, actor, actorId } = freshDb();
    seedTree(db, actorId, {
      rootId: 'r-live', root: 'open', branches: ['open', 'failed'], ledger: 'running',
    });
    expect(listForkRuns(sql, actor).items[0].status).toBe('running');
  });

  test('a search that has not expanded anything yet is running', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedTree(db, actorId, { rootId: 'r-fresh', root: 'open', branches: [], ledger: 'running' });
    expect(listForkRuns(sql, actor).items[0].status).toBe('running');
  });

  test('an expanded parent left open is not a frontier', () => {
    // Matches `frontier.ts`: `status='open' AND NOT EXISTS (children)`.
    const { db, sql, actor, actorId } = freshDb();
    seedTree(db, actorId, { rootId: 'r-open-root', root: 'open', branches: ['pruned', 'pruned'] });
    expect(listForkRuns(sql, actor).items[0].status).toBe('partial');
  });
});

/** An agent-unit swarm writes both stores under one root; it must read as one run. */
describe('a run that wrote both stores', () => {
  const TASK = 'cut p99 latency on the search path';
  const PRESET = 'optimise';

  /** The journal starts after the tree, making the tree-less half sort newer. */
  function seedSwarmRun(db: Database, actorId: string, rootId = 'swarm-1'): void {
    seedSearchRun(db, actorId, { rootId, task: TASK, at: 1000, branches: 3, winner: 0.71, ledger: 'converged' });
    seedJournalledRun(db, actorId, {
      rootId, task: TASK, at: 1400, rationale: PRESET,
      heads: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }],
    });
  }

  test('is ONE run, and it carries every half it wrote', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSwarmRun(db, actorId);
    const runs = listForkRuns(sql, actor).items;
    // Exactly one row per root.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'swarm-1',
      hasSearchTree: true,
      hasNodeTranscripts: true,
      // Only tool-using nodes write journal rows; the tree is the complete structure.
      branches: 3,
      winnerScore: 0.71,
      status: 'completed',
    });
    expect(new Set(runs.map((run) => run.id)).size).toBe(runs.length);
  });

  test('starts when its FIRST half was written, not when its second was', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSwarmRun(db, actorId);
    expect(listForkRuns(sql, actor).items[0].startedAt).toBe(1000);
  });

  test('reports the task it ran, never the preset name in the split rationale', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSwarmRun(db, actorId);
    // `head_runs.rationale` holds `label ?? preset` for a swarm; the tree root holds the real task.
    expect(listForkRuns(sql, actor).items[0].task).toBe(TASK);
    expect(listForkRuns(sql, actor).items[0].task).not.toBe(PRESET);
  });

  test('a run with no tree still falls back to the split rationale for its task', () => {
    // A journal-only run has only the rationale to say what it was for.
    const { db, sql, actor, actorId } = freshDb();
    seedJournalledRun(db, actorId, {
      rootId: 'j1', task: 'unused', at: 1000, rationale: 'compare two rewrites',
      heads: [{ status: 'completed' }],
    });
    expect(listForkRuns(sql, actor).items[0].task).toBe('compare two rewrites');
  });

  const BOTH_HALVES = [
    { name: 'is running while either half is still writing', winner: 0.5, second: 'running', status: 'running' },
    {
      // The tree's ledger states how it ended; a failed branch does not make a swarm `partial`.
      name: 'a settled search with one failed node reads as settled, not partial',
      winner: 0.6, second: 'errored', status: 'completed',
    },
  ] as const;

  for (const both of BOTH_HALVES) {
    test(both.name, () => {
      const { db, sql, actor, actorId } = freshDb();
      seedSearchRun(db, actorId, { rootId: 'swarm-1', task: TASK, at: 1000, branches: 2, winner: both.winner, ledger: 'converged' });
      seedJournalledRun(db, actorId, {
        rootId: 'swarm-1', task: TASK, at: 1400, rationale: PRESET,
        heads: [{ status: 'completed' }, { status: both.second }],
      });

      expect(listForkRuns(sql, actor).items[0].status).toBe(both.status);
    });
  }

  test('arrives whole on whichever page it falls on, halves together', () => {
    // Bounding each store separately would tear a run straddling the page boundary.
    const { db, sql, actor, actorId } = freshDb();
    seedSwarmRun(db, actorId);
    seedJournalledRun(db, actorId, { rootId: 'middle', task: 'in between', at: 1200, heads: [{ status: 'completed' }] });
    seedSearchRun(db, actorId, { rootId: 'newest', task: 'newest', at: 9000, branches: 1, ledger: 'converged' });

    const seen: ForkRunSummary[] = [];
    let cursor: SeekCursor | null = null;

    for (let page = 0; page < 5; page++) {
      const next: Page<ForkRunSummary> = listForkRuns(sql, actor, cursor, 1);
      seen.push(...next.items);

      if (next.status === 'end') break;
      cursor = next.next;
    }

    expect(seen.map((run) => run.id)).toEqual(['newest', 'middle', 'swarm-1']);
    const swarm = seen.find((run) => run.id === 'swarm-1');
    expect(swarm).toMatchObject({ hasSearchTree: true, hasNodeTranscripts: true, branches: 3 });
  });

  test('an exact lookup carries both halves too', () => {
    const { db, sql, actor, actorId } = freshDb();
    seedSwarmRun(db, actorId);
    expect(readForkRun(sql, actor, 'swarm-1')).toMatchObject({
      hasSearchTree: true, hasNodeTranscripts: true, task: TASK, winnerScore: 0.71,
    });
  });
});

/** Canvas pages must not grow with trace length (no renderer reads traces there), while the
 *  per-branch read still delivers every step. */
describe('the canvas page does not carry step traces', () => {
  function seedWithTrace(fixture: ReturnType<typeof freshDb>, chars: number) {
    seedJournalledRun(fixture.db, fixture.actorId, {
      rootId: 'traced', task: 'a swarm that talked a lot', at: 1_000,
      heads: [{ status: 'completed' }, { status: 'completed' }],
    });
    const journal = new HeadJournal(fixture.sql, fixture.actor);

    for (const id of ['traced-h0', 'traced-h1']) {
      journal.appendStep(id, 0, { text: 'x'.repeat(chars), toolCalls: [{ name: 'file' }] });
      journal.appendStep(id, 1, { text: 'y'.repeat(chars), toolCalls: [] });
    }

    return journal;
  }

  test('a page of a run whose heads wrote long traces is the same size as one whose heads wrote short ones', () => {
    const short = freshDb();
    seedWithTrace(short, 10);
    const long = freshDb();
    seedWithTrace(long, 50_000);

    const shortBytes = JSON.stringify(readExplorationCanvas(short.sql, short.actor)).length;
    const longBytes = JSON.stringify(readExplorationCanvas(long.sql, long.actor)).length;
    // Identical: nothing derived from step length may reach this payload.
    expect(longBytes).toBe(shortBytes);
  });

  test('the branch reader still delivers every step', () => {
    const fixture = freshDb();
    const { sql, actor } = fixture;
    const journal = seedWithTrace(fixture, 10);
    // The canvas lists the head…
    const page = readExplorationCanvas(sql, actor);
    const head = page.items[0]?.head?.heads.find((candidate) => candidate.id === 'traced-h0');
    expect(head).toBeDefined();
    // …and its lifecycle is intact, including aggregates over rows the page omits.
    expect(head?.lastStepAt).toBeGreaterThan(0);
    // …and opening it reads the trace.
    const steps = journal.readSteps('traced-h0');
    expect(steps.map((step) => step.text)).toEqual(['x'.repeat(10), 'y'.repeat(10)]);
    expect(steps[0]?.toolCalls.map((call) => call.name)).toEqual(['file']);
    expect(new HeadJournal(sql, actor).readHeadView('traced-h0')?.task).toBe('branch 0');
  });
});
