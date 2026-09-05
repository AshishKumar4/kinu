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
 * recovery (jobs/runner.ts — five re-drives and then a give-up when this was
 * written; unbounded attempts at a capped pace since 2026-09-04, which makes
 * this defect's blast radius larger, not smaller), and `resumeBackgroundJob`
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
 *
 * Specified by docs/EXPLORATION.md — "One node, one row, across every re-entry",
 * whose fork paragraph states the derived-id rule and the one merged answer.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  HeadController,
  HeadJournal,
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

interface PendingHead {
  input: HeadInput;
  resolve: (report: HeadReport) => void;
}

function completedReport(input: HeadInput): HeadReport {
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
}

async function settleInterruptedRuns(
  pendingHeads: readonly PendingHead[],
  runs: readonly Promise<unknown>[],
): Promise<void> {
  for (const { input, resolve } of pendingHeads) {
    resolve(completedReport(input));
  }
  await Promise.all(runs);
}

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
function runtime(opts: { settles: boolean; spawned: HeadInput[]; pendingHeads?: PendingHead[]; compiled?: string[] }): HeadRuntime {
  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      opts.spawned.push(input);
      return {
        id: input.id,
        run: async () => {
          if (!opts.settles) {
            const pendingHeads = opts.pendingHeads;
            if (!pendingHeads) throw new Error('Unsettled test head must have an owner');
            const pending = Promise.withResolvers<HeadReport>();
            pendingHeads.push({ input, resolve: pending.resolve });
            return pending.promise;
          }
          return completedReport(input);
        },
        async abort() {},
      };
    },
    async mergeLLM(prompt: string): Promise<MergeOutput> {
      opts.compiled?.push(prompt);
      return MERGE;
    },
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
function drive(journal: HeadJournal, spawned: HeadInput[], settles: boolean, branches = 5, pendingHeads?: PendingHead[]) {
  return new HeadController(runtime({ settles, spawned, pendingHeads }), journal).run({
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
    const pendingHeads: PendingHead[] = [];
    const interruptedRuns = Array.from(
      { length: 3 },
      () => drive(journal, spawned, false, 5, pendingHeads),
    );

    await drive(journal, spawned, true);

    const runs = listForkRuns(sql, null, 30).items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ task: TASK, hasSearchTree: false, hasNodeTranscripts: true, status: 'completed' });

    // All four attempts' heads live under that one root.
    expect(new Set(spawned.map((head) => head.rootId)).size).toBe(1);
    expect(spawned).toHaveLength(20);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  test('N heads requested stays exactly N journal rows through repeated resets', async () => {
    // THE OWNER'S `Systemfork interrupted` REPORT, as a test. A re-drive used to
    // reclaim the run id, stamp every unreported row `aborted` with "Interrupted
    // before it reported. This fork was restarted, and the branches below it are the
    // retry.", and then mint a FRESH nanoid id per head — so one five-branch request
    // accumulated five more aborted rows on every re-drive, up to the runner's
    // attempt cap, and the surface drew every one of them as a failed branch.
    //
    // The head id is now derived from the branch point and the slot, so a re-drive
    // re-spawns the SAME ids and `insertSpawn` re-opens the rows they already have.
    const { sql, journal } = freshJournal();
    const spawned: HeadInput[] = [];
    const pendingHeads: PendingHead[] = [];

    // Three resets that never report, then one that lands.
    const interruptedRuns = Array.from(
      { length: 3 },
      () => drive(journal, spawned, false, 5, pendingHeads),
    );
    await drive(journal, spawned, true);

    const rows = sql<{ id: string; status: string; error_message: string | null }>`
      SELECT id, status, error_message FROM head_journal
      WHERE root_id = ${spawned[0]?.rootId ?? ''} ORDER BY rowid`;
    // FIVE ROWS FOR FIVE BRANCHES, after four drives. The incident produced twenty.
    expect(rows).toHaveLength(5);
    // …and they are the same five ids every attempt spawned.
    expect(new Set(spawned.map((head) => head.id)).size).toBe(5);
    // Each reset re-ran the work — that is unavoidable for an ephemeral facet — so
    // the spawn count still counts attempts, not branches.
    expect(spawned).toHaveLength(20);

    // NO FAKE TERMINAL ROW. Every row reached the real outcome of the attempt that
    // reported, and none carries a takeover reason of any kind.
    expect(rows.every((row) => row.status === 'completed')).toBe(true);
    expect(rows.filter((row) => row.status === 'aborted')).toHaveLength(0);
    expect(rows.every((row) => row.error_message === null)).toBe(true);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal WHERE error_message LIKE '%the retry%'`[0]?.n)
      .toBe(0);

    // ONE run, and its report compiles once: one cached merge for one root.
    expect(listForkRuns(sql, null, 30).items).toHaveLength(1);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_merge_results`[0]?.n).toBe(1);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  test('two parents splitting at one depth get distinct branch ids', async () => {
    // The other half of deriving the id. It used to be keyed on the ROOT, so two
    // parents splitting at the same depth under one root produced the same
    // `${rootId}-d${depth}-${idx}` prefix and only the random suffix kept them apart.
    // Keyed on the branch POINT, uniqueness needs no randomness.
    const { journal } = freshJournal();
    const spawned: HeadInput[] = [];
    const controller = new HeadController(runtime({ settles: true, spawned }), journal);
    const shared = { mode: 'build' as const, inheritedContext: [], request: splitRequest(2) };

    await controller.run({ ...shared, parentHeadId: null });
    const [firstParent, secondParent] = spawned.map((head) => head.id);
    await controller.run({ ...shared, parentHeadId: firstParent ?? '', parentDepth: 1 });
    await controller.run({ ...shared, parentHeadId: secondParent ?? '', parentDepth: 1 });

    expect(new Set(spawned.map((head) => head.id)).size).toBe(spawned.length);
  });

  test('one request compiles exactly ONE answer, however many times it is re-driven', async () => {
    // EXACTLY-ONCE COMPILATION. The heads are re-RUN on every reset — they are
    // ephemeral facets with no checkpoint, so there is nothing else a resume can
    // do — but the SYNTHESIS is the run's answer, and a run holds one. Two ways
    // that could break, and both are asserted here rather than reasoned about:
    // an attempt that never reported must compile nothing, because there is no
    // set of findings to compile; and the attempt that lands must compile once,
    // not once per branch.
    const { sql, journal } = freshJournal();
    const spawned: HeadInput[] = [];
    const compiled: string[] = [];
    const pendingHeads: PendingHead[] = [];

    const interruptedRuns = Array.from(
      { length: 3 },
      () => new HeadController(
        runtime({ settles: false, spawned, pendingHeads, compiled }),
        journal,
      ).run({
        mode: 'build', parentHeadId: null, inheritedContext: [], request: splitRequest(5),
      }),
    );
    expect(compiled).toEqual([]);

    await new HeadController(runtime({ settles: true, spawned, compiled }), journal).run({
      mode: 'build', parentHeadId: null, inheritedContext: [], request: splitRequest(5),
    });

    // ONE synthesis for five branches and four drives.
    expect(compiled).toHaveLength(1);
    // One durable answer, under one run identity — `cacheMerge` is keyed on the
    // root, so a re-drive that had minted a fresh id would have added a row here
    // rather than replaced one.
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_merge_results`[0]?.n).toBe(1);
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM head_runs`[0]?.n).toBe(1);
    const [row] = sql<{ merged_narrative: string }>`
      SELECT merged_narrative FROM head_merge_results`;
    expect(row?.merged_narrative).toBe(MERGE.narrative);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
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

    const pendingHeads: PendingHead[] = [];
    const interruptedRuns = [drive(journal, spawned, false, 2, pendingHeads)];
    await new HeadController(runtime({ settles: true, spawned }), journal).run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: splitRequest(2, 'a completely different question'),
    });

    expect(listForkRuns(sql, null, 30).items.map((run) => run.task).slice().sort())
      .toEqual([TASK, 'a completely different question']);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
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
    const pendingHeads: PendingHead[] = [];

    const interruptedRuns = [drive(journal, spawned, false, 5, pendingHeads)];
    for (let turn = 0; turn < 100 && pendingHeads.length < 5; turn += 1) {
      await Promise.resolve();
    }
    expect(pendingHeads).toHaveLength(5);
    // Nothing retried it: the reconciliation that retires stale heads has run,
    // which is the state a workspace reopens in.
    journal.abandonRunning('no executor: outlived the activation that spawned it');

    const [run] = listForkRuns(sql, null, 30).items;
    expect(run).toMatchObject({ task: TASK, hasSearchTree: false, hasNodeTranscripts: true, status: 'partial' });
    if (!run) throw new Error('Expected an interrupted fork run');
    expect(run.winnerScore).toBeNull();
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  test('a recursive sub-split still anchors on its parent head, not on a task match', async () => {
    const { journal } = freshJournal();
    const spawned: HeadInput[] = [];

    const pendingHeads: PendingHead[] = [];
    const interruptedRuns = [drive(journal, spawned, false, 2, pendingHeads)];
    await new HeadController(runtime({ settles: true, spawned }), journal).run({
      mode: 'build',
      parentHeadId: 'parent-head-1',
      parentDepth: 1,
      inheritedContext: [],
      request: splitRequest(2),
    });

    const subSplit = spawned.slice(-2);
    expect(subSplit.every((head) => head.rootId === 'parent-head-1')).toBe(true);
    expect(subSplit.every((head) => head.parentId === 'parent-head-1')).toBe(true);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });
});
