/**
 * One request is one fork run, however many times its job is re-driven.
 *
 * The reproduction, from the owner's own workspace: a single research fork
 * showed as FOUR near-identical `merged · 5 branches` rows in the Exploration
 * list, same task text, same day. They were not one run recorded four times —
 * they were four runs really executed, each spawning and paying for its own
 * five heads.
 *
 * Mechanism: a detached fork's background job is re-driven by evict/exit
 * recovery (jobs/runner.ts, MAX_RESUME_ATTEMPTS = 5), and `resumeBackgroundJob`
 * re-executes the raw `agents` call with the stored input. MCTS survives that
 * because re-entry reclaims the same search by task, keeping ONE `root_id`.
 * `HeadController.run` had no such reclaim: `opts.rootId ?? opts.parentHeadId ??
 * nanoid()` with a top-level split passing neither, so every re-drive minted a
 * fresh root.
 *
 * These tests drive the controller the way a re-drive drives it — same stored
 * task, fresh call, no root id — and assert on what `listForkRuns` (the read
 * model behind that list) actually returns, not on internals.
 *
 * No timers: the controller records the split and every spawn synchronously,
 * before its first await, so an interrupted drive has already left its journal
 * rows by the time `run()` yields.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  HeadController,
  HeadJournal,
  RECLAIMED_RUN_REASON,
  type HeadInput,
  type HeadReport,
  type HeadRuntime,
  type MergeOutput,
  type SpawnedHead,
  type SplitRequest,
  initHeadsTables,
} from '../src/heads/index';
import { initSearchTables } from '../src/mcts/schemas';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { listForkRuns } from '../src/read-models/fork-runs';
import { makeSql, makeExecRaw } from './helpers';

const TASK = 'Curate and hand-pick the best brand names for the product';

const MERGE: MergeOutput = {
  narrative: 'Five angles on the brand-name question, merged.',
  selected_decisions: [],
  unresolved_questions: [],
  recommendations: [],
  blind_spots: [],
};

function freshJournal() {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initHeadsTables(execRaw, makeSql(db));
  initSearchTables(execRaw, makeSql(db));
  initMctsSearchTable(execRaw, makeSql(db));
  const sql = makeSql(db);
  return { db, sql, journal: new HeadJournal(sql) };
}

/**
 * A head runtime, in one of the two shapes this file needs.
 *
 * `settles: false` is an interrupted attempt: the heads spawn and their reports
 * never arrive, which is what a fork looks like when the activation driving it
 * dies. `settles: true` is the attempt that lands.
 */
function runtime(opts: { settles: boolean; spawned: HeadInput[] }): HeadRuntime {
  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      opts.spawned.push(input);
      return {
        id: input.id,
        run: async () => {
          if (!opts.settles) return Promise.withResolvers<HeadReport>().promise;
          return {
            id: input.id,
            status: 'completed',
            summary: `${input.task} reported`,
            evidence: [],
            decisions: [],
            artifactRefs: [],
            fileChanges: [],
            childHeadIds: [],
            toolCalls: [],
            usage: { input: 10, output: 10 },
            wallClockMs: 5,
            stepCount: 1,
          };
        },
        async abort() {},
      };
    },
    async mergeLLM(): Promise<MergeOutput> { return MERGE; },
  };
}

function splitRequest(branches: number, rationale = TASK): SplitRequest {
  return {
    rationale,
    heads: Array.from({ length: branches }, (_, i) => ({
      task: `angle ${i + 1}`,
      rationale: `the ${i + 1}th angle`,
    })),
  };
}

/** One drive of the head, exactly as `resumeBackgroundJob` drives it: a
 *  fresh controller call carrying the stored input and no run identity. */
function drive(journal: HeadJournal, spawned: HeadInput[], settles: boolean, branches = 5) {
  return new HeadController(runtime({ settles, spawned }), journal).run({
    mode: 'build',
    parentHeadId: null,
    inheritedContext: [],
    request: splitRequest(branches),
  });
}

describe('a re-driven fork job stays one run', () => {
  test('three interrupted drives and a fourth that lands are ONE run, not four', async () => {
    const { sql, journal } = freshJournal();
    const spawned: HeadInput[] = [];

    for (let i = 0; i < 3; i++) void drive(journal, spawned, false);
    await drive(journal, spawned, true);

    const runs = listForkRuns(sql, null, 30).items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ task: TASK, settle: 'merged', status: 'completed' });

    // All four attempts' heads live under that one root.
    expect(new Set(spawned.map((head) => head.rootId)).size).toBe(1);
    expect(spawned).toHaveLength(20);
  });

  test('the interrupted attempt stays visible as retired branches, with a reason a human can read', async () => {
    const { sql, journal } = freshJournal();
    const spawned: HeadInput[] = [];

    void drive(journal, spawned, false);
    await drive(journal, spawned, true);

    const rows = sql<{ id: string; status: string; error_message: string | null }>`
      SELECT id, status, error_message FROM head_journal
      WHERE root_id = ${spawned[0]!.rootId} ORDER BY spawned_at, id`;
    expect(rows.filter((row) => row.status === 'aborted')).toHaveLength(5);
    expect(rows.filter((row) => row.status === 'completed')).toHaveLength(5);
    expect(rows.filter((row) => row.status === 'aborted')
      .every((row) => row.error_message === RECLAIMED_RUN_REASON)).toBe(true);
    expect(RECLAIMED_RUN_REASON).not.toMatch(/nanoid|root_id|epoch|null/);

    // Both attempts are branches of the same single run.
    expect(listForkRuns(sql, null, 30).items).toHaveLength(1);
  });

  test('a settled run is never reclaimed: the next fork on the same task is its own run', async () => {
    const { sql, journal } = freshJournal();
    const spawned: HeadInput[] = [];

    await drive(journal, spawned, true);
    await drive(journal, spawned, true);

    const runs = listForkRuns(sql, null, 30).items;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
    expect(new Set(spawned.map((head) => head.rootId)).size).toBe(2);
  });

  test('a different task never joins another run', async () => {
    const { sql, journal } = freshJournal();
    const spawned: HeadInput[] = [];

    void drive(journal, spawned, false, 2);
    await new HeadController(runtime({ settles: true, spawned }), journal).run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: splitRequest(2, 'a completely different question'),
    });

    expect(listForkRuns(sql, null, 30).items.map((run) => run.task).slice().sort())
      .toEqual([TASK, 'a completely different question']);
  });

  /**
   * "They say merged but there is no information on them."
   *
   * A run under the merge POLICY that never reached its synthesis has not merged
   * anything, and the list must not claim it did. The status vocabulary is what
   * carries that: `partial` is "it stopped without an answer", which is exactly
   * what an interrupted split is until something retries it.
   */
  test('an interrupted split reads as stopped, never as merged', async () => {
    const { sql, journal } = freshJournal();
    const spawned: HeadInput[] = [];

    void drive(journal, spawned, false);
    // Nothing retried it: the reconciliation that retires stale heads has run,
    // which is the state a workspace reopens in.
    journal.abandonRunning('no executor: outlived the activation that spawned it');

    const [run] = listForkRuns(sql, null, 30).items;
    expect(run).toMatchObject({ task: TASK, settle: 'merged', status: 'partial' });
    expect(run!.winnerScore).toBeNull();
  });

  test('a recursive sub-split still anchors on its parent head, not on a task match', async () => {
    const { journal } = freshJournal();
    const spawned: HeadInput[] = [];

    void drive(journal, spawned, false, 2);
    await new HeadController(runtime({ settles: true, spawned }), journal).run({
      mode: 'build',
      parentHeadId: 'parent-head-1',
      inheritedContext: [],
      request: splitRequest(2),
    });

    const subSplit = spawned.slice(-2);
    expect(subSplit.every((head) => head.rootId === 'parent-head-1')).toBe(true);
    expect(subSplit.every((head) => head.parentId === 'parent-head-1')).toBe(true);
  });
});
