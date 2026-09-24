/**
 * One request is one fork run however often its job is re-driven: a top-level split derives its root
 * from the stored task, so a re-drive reopens the same journal rows. Asserted through `listForkRuns`.
 * Spec: docs/EXPLORATION.md "One node, one row, across every re-entry".
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
import { initSwarmNodeRecords } from '../src/strategy/swarm-resume';
import { initMctsSearchTable } from '../src/mcts/search-store';
import { listForkRuns } from '../src/read-models/fork-runs';
import { makeSql, makeExecRaw, createTestActor } from './helpers';

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
  initHeadsTables(execRaw);
  initSearchTables(execRaw);
  initSwarmNodeRecords(execRaw);
  initMctsSearchTable(execRaw);
  const sql = makeSql(db);
  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'fork-identity-test');

  return { db, sql, actor, journal: new HeadJournal(sql, actor) };
}

/** `settles: false` is an interrupted attempt whose reports never arrive; `settles: true` lands. */
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

/** One drive as `resumeBackgroundJob` makes it: a fresh call with the stored input and no run identity. */
interface DriveOptions {
  journal: HeadJournal;
  spawned: HeadInput[];
  settles: boolean;
  branches?: number;
  pendingHeads?: PendingHead[];
}

function drive({ journal, spawned, settles, branches = 5, pendingHeads }: DriveOptions) {
  return new HeadController(runtime({ settles, spawned, pendingHeads }), journal).run({
    mode: 'build',
    parentHeadId: null,
    inheritedContext: [],
    request: splitRequest(branches),
    parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
  });
}

describe('a re-driven fork job stays one run', () => {
  test('three interrupted drives and a fourth that lands are ONE run, not four', async () => {
    const { sql, actor, journal } = freshJournal();
    const spawned: HeadInput[] = [];
    const pendingHeads: PendingHead[] = [];

    const interruptedRuns = Array.from(
      { length: 3 },
      () => drive({ journal, spawned, settles: false, pendingHeads }),
    );

    await drive({ journal, spawned, settles: true });

    const runs = listForkRuns(sql, actor, null, 30).items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ task: TASK, hasSearchTree: false, hasNodeTranscripts: true, status: 'completed' });

    expect(new Set(spawned.map((head) => head.rootId)).size).toBe(1);
    expect(spawned).toHaveLength(20);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  test('N heads requested stays exactly N journal rows through repeated resets', async () => {
    // A head id derives from its branch point and slot, so a re-drive reopens the same journal row
    // instead of aborting it and minting a fresh one.
    const { sql, actor, journal } = freshJournal();
    const spawned: HeadInput[] = [];
    const pendingHeads: PendingHead[] = [];

    const interruptedRuns = Array.from(
      { length: 3 },
      () => drive({ journal, spawned, settles: false, pendingHeads }),
    );

    await drive({ journal, spawned, settles: true });

    const rows = sql<{ id: string; status: string; error_message: string | null }>`
      SELECT id, status, error_message FROM head_journal
      WHERE actor_id = ${actor.actorId} AND root_id = ${spawned[0]?.rootId ?? ''} ORDER BY rowid`;

    // Five rows for five branches after four drives.
    expect(rows).toHaveLength(5);
    expect(new Set(spawned.map((head) => head.id)).size).toBe(5);
    // Heads are re-run on each reset, so spawns count attempts, not branches.
    expect(spawned).toHaveLength(20);

    // No row carries a takeover reason.
    expect(rows.every((row) => row.status === 'completed')).toBe(true);
    expect(rows.filter((row) => row.status === 'aborted')).toHaveLength(0);
    expect(rows.every((row) => row.error_message === null)).toBe(true);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${actor.actorId} AND error_message LIKE '%the retry%'`[0]?.n)
      .toBe(0);

    expect(listForkRuns(sql, actor, null, 30).items).toHaveLength(1);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_merge_results WHERE actor_id = ${actor.actorId}`[0]?.n).toBe(1);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  test('two parents splitting at one depth get distinct branch ids', async () => {
    // Keyed on the branch point: keyed on the root, two parents at one depth would share the `${rootId}-d${depth}-${idx}` prefix.
    const { journal } = freshJournal();
    const spawned: HeadInput[] = [];
    const controller = new HeadController(runtime({ settles: true, spawned }), journal);
    const shared = { mode: 'build' as const, inheritedContext: [], request: splitRequest(2) };

    // Nested splits run on the budget the parent head inherited, as `split_subheads` does in production.
    await controller.run({
      ...shared, parentHeadId: null,
      parentBudget: { maxDepth: 2, spawnedAt: Date.now() },
    });
    const [firstParent, secondParent] = spawned;

    if (!firstParent || !secondParent) throw new Error('Expected the root split to spawn two heads');
    await controller.run({
      ...shared, parentHeadId: firstParent.id, parentDepth: 1, parentBudget: firstParent.budget,
    });
    await controller.run({
      ...shared, parentHeadId: secondParent.id, parentDepth: 1, parentBudget: secondParent.budget,
    });

    expect(new Set(spawned.map((head) => head.id)).size).toBe(spawned.length);
  });

  test('one request compiles exactly ONE answer, however many times it is re-driven', async () => {
    // An attempt that never reported compiles nothing; the attempt that lands compiles once, not once per branch.
    const { sql, actor, journal } = freshJournal();
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
        parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
      }),
    );

    expect(compiled).toEqual([]);

    await new HeadController(runtime({ settles: true, spawned, compiled }), journal).run({
      mode: 'build', parentHeadId: null, inheritedContext: [], request: splitRequest(5),
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(compiled).toHaveLength(1);
    // `cacheMerge` is keyed on the root, so a fresh id would add a row rather than replace one.
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_merge_results WHERE actor_id = ${actor.actorId}`[0]?.n).toBe(1);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_runs WHERE actor_id = ${actor.actorId}`[0]?.n).toBe(1);

    const [row] = sql<{ merged_narrative: string }>`
      SELECT merged_narrative FROM head_merge_results WHERE actor_id = ${actor.actorId}`;

    expect(row?.merged_narrative).toBe(MERGE.narrative);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  test('a settled run is never reclaimed: the next fork on the same task is its own run', async () => {
    const { sql, actor, journal } = freshJournal();
    const spawned: HeadInput[] = [];

    await drive({ journal, spawned, settles: true });
    await drive({ journal, spawned, settles: true });

    const runs = listForkRuns(sql, actor, null, 30).items;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
    expect(new Set(spawned.map((head) => head.rootId)).size).toBe(2);
  });

  test('a different task never joins another run', async () => {
    const { sql, actor, journal } = freshJournal();
    const spawned: HeadInput[] = [];

    const pendingHeads: PendingHead[] = [];
    const interruptedRuns = [drive({ journal, spawned, settles: false, branches: 2, pendingHeads })];
    await new HeadController(runtime({ settles: true, spawned }), journal).run({
      mode: 'build',
      parentHeadId: null,
      inheritedContext: [],
      request: splitRequest(2, 'a completely different question'),
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    expect(listForkRuns(sql, actor, null, 30).items.map((run) => run.task).slice().sort())
      .toEqual([TASK, 'a completely different question']);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  /** A merge-policy run that never reached its synthesis is `partial`, not `merged`. */
  test('an interrupted split reads as stopped, never as merged', async () => {
    const { sql, actor, journal } = freshJournal();
    const spawned: HeadInput[] = [];
    const pendingHeads: PendingHead[] = [];

    const interruptedRuns = [drive({ journal, spawned, settles: false, pendingHeads })];

    for (let turn = 0; turn < 100 && pendingHeads.length < 5; turn += 1) {
      await Promise.resolve();
    }

    expect(pendingHeads).toHaveLength(5);
    // The stale-head reconciliation has run: the state a workspace reopens in.
    journal.abandonRunning('no executor: outlived the activation that spawned it');

    const [run] = listForkRuns(sql, actor, null, 30).items;
    expect(run).toMatchObject({ task: TASK, hasSearchTree: false, hasNodeTranscripts: true, status: 'partial' });

    if (!run) throw new Error('Expected an interrupted fork run');
    expect(run.winnerScore).toBeNull();
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });

  test('a recursive sub-split still anchors on its parent head, not on a task match', async () => {
    const { journal } = freshJournal();
    const spawned: HeadInput[] = [];

    const pendingHeads: PendingHead[] = [];
    const interruptedRuns = [drive({ journal, spawned, settles: false, branches: 2, pendingHeads })];
    await new HeadController(runtime({ settles: true, spawned }), journal).run({
      mode: 'build',
      parentHeadId: 'parent-head-1',
      parentDepth: 1,
      inheritedContext: [],
      request: splitRequest(2),
      // The parent head is synthetic, so its inherited room is authored.
      parentBudget: { maxDepth: 1, spawnedAt: Date.now() },
    });

    const subSplit = spawned.slice(-2);
    expect(subSplit.every((head) => head.rootId === 'parent-head-1')).toBe(true);
    expect(subSplit.every((head) => head.parentId === 'parent-head-1')).toBe(true);
    await settleInterruptedRuns(pendingHeads, interruptedRuns);
  });
});
