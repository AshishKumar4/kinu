/**
 * Steer-as-Branch — the single-head branch run (HeadRuntime seam), the settle
 * into the Alternate Takes pipeline (branch-sourced sets), and the pick flow
 * over branch candidates (no search_nodes involvement, 'corrected' + the
 * chosen text as the correction follow-up).
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers.js';
import {
  initAlternateTakesTable, recordBranchTakeSet, claimAlternateTakesForTurn,
  latestAlternateTakeSet, recordTakePick, buildTakeContinuationPrompt,
} from '../src/mcts/takes.js';
import { initTurnOutcomeTables } from '../src/evolution/outcomes.js';
import { initHeadsTables } from '../src/heads/schema.js';
import { HeadJournal } from '../src/heads/journal.js';
import type { HeadRuntime, SpawnedHead } from '../src/heads/controller.js';
import type { HeadInput, HeadReport } from '../src/heads/types.js';
import {
  BRANCH_HEAD_BUDGET, BRANCH_RATIONALE, startBranchHead, settleBranchIntoTakes,
} from '../src/steer-branch.js';

function setup() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initAlternateTakesTable(execRaw);
  initTurnOutcomeTables(execRaw, sql);
  initHeadsTables(execRaw);
  return { db, sql, execRaw };
}

function completedReport(id: string, summary: string, status: HeadReport['status'] = 'completed'): HeadReport {
  return {
    id, status, summary,
    evidence: [], decisions: [], artifactRefs: [], childHeadIds: [], toolCalls: [], steps: [],
    tokenUsage: { input: 10, output: 20, total: 30 },
    wallClockMs: 5,
  };
}

/** A HeadRuntime whose single head resolves with the given report (or runs the
 *  given body). Records spawn inputs + abort calls for assertions. */
function fakeRuntime(run: (input: HeadInput) => Promise<HeadReport>) {
  const spawns: HeadInput[] = [];
  const aborts: string[] = [];
  const runtime: HeadRuntime = {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      spawns.push(input);
      return {
        id: input.id,
        run: () => run(input),
        async abort(reason: string) { aborts.push(reason); },
      };
    },
    mergeLLM: async () => { throw new Error('branch runs never merge'); },
  };
  return { runtime, spawns, aborts };
}

describe('startBranchHead — one budgeted head over the HeadRuntime seam', () => {
  test('runs the redirect as a journaled single head and resolves its report', async () => {
    const { sql } = setup();
    const journal = new HeadJournal(sql);
    const { runtime, spawns } = fakeRuntime(async (input) => completedReport(input.id, 'branch answer'));

    const handle = await startBranchHead(runtime, journal, {
      task: 'try the other approach',
      inheritedContext: [{ id: 'c1', role: 'user', content: 'original ask', createdAt: 1 }],
    });
    const report = await handle.result;

    expect(report.status).toBe('completed');
    expect(report.summary).toBe('branch answer');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!).toMatchObject({
      task: 'try the other approach',
      rationale: BRANCH_RATIONALE,
      rootId: handle.id,
      mergeStrategy: 'best_of',
    });
    expect(spawns[0]!.budget.maxDepth).toBe(BRANCH_HEAD_BUDGET.maxDepth);
    expect(spawns[0]!.inheritedContext[0]!.content).toBe('original ask');

    // Journaled like any head run: spawn row + final report status.
    const row = journal.readHead(spawns[0]!.id)!;
    expect(row.status).toBe('completed');
    expect(row.summary).toBe('branch answer');
    expect(journal.readTree(handle.id)).toHaveLength(1);
  });

  test('abort delegates to the spawned head', async () => {
    const { sql } = setup();
    const journal = new HeadJournal(sql);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runtime, aborts } = fakeRuntime(async (input) => {
      await gate;
      return completedReport(input.id, 'late', 'aborted');
    });

    const handle = await startBranchHead(runtime, journal, { task: 'x', inheritedContext: [] });
    await handle.abort('live turn did not complete');
    expect(aborts).toEqual(['live turn did not complete']);
    release();
    await handle.result;
  });
});

describe('settleBranchIntoTakes — honest settle into ONE takes pipeline', () => {
  test('a completed branch + completed live turn persist a claimed branch-sourced pair', () => {
    const { sql } = setup();
    const outcome = settleBranchIntoTakes(sql, {
      task: 'use approach B instead',
      report: completedReport('h1', 'B-style answer'),
      turnId: 'turn-9',
      sessionId: 'default',
      liveText: 'A-style answer',
    });
    expect(outcome.ok).toBe(true);

    const set = latestAlternateTakeSet(sql)!;
    expect(set).toMatchObject({ source: 'branch', turnId: 'turn-9', sessionId: 'default', task: 'use approach B instead' });
    expect(set.candidates).toHaveLength(2);
    expect(set.candidates[0]).toMatchObject({ text: 'A-style answer', origin: 'live' });
    expect(set.candidates[1]).toMatchObject({ text: 'B-style answer', origin: 'branch' });
    // The live answer is the winner until the user says otherwise.
    expect(set.winnerNodeId).toBe(set.candidates[0]!.nodeId);
    expect(set.chosenNodeId).toBeNull();

    // Already claimed — the turn-end claim sweep finds nothing unclaimed.
    expect(claimAlternateTakesForTurn(sql, { turnId: 'other', sessionId: 'default', startedAt: 0 })).toBe(0);
    expect(latestAlternateTakeSet(sql)!.turnId).toBe('turn-9');
  });

  test('an errored branch writes NO takes set and surfaces the failure reason', () => {
    const { sql } = setup();
    const report = { ...completedReport('h1', '', 'errored'), errorMessage: 'model exploded' };
    const outcome = settleBranchIntoTakes(sql, {
      task: 'x', report, turnId: 'turn-9', sessionId: 'default', liveText: 'live',
    });
    expect(outcome).toEqual({ ok: false, reason: 'model exploded' });
    expect(latestAlternateTakeSet(sql)).toBeNull();
  });

  test('an interrupted live turn writes NO takes set', () => {
    const { sql } = setup();
    const outcome = settleBranchIntoTakes(sql, {
      task: 'x', report: completedReport('h1', 'branch answer'),
      turnId: null, sessionId: 'default', liveText: '',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('live turn did not complete');
    expect(latestAlternateTakeSet(sql)).toBeNull();
  });

  test('identical answers offer no choice — no takes set', () => {
    const { sql } = setup();
    const outcome = settleBranchIntoTakes(sql, {
      task: 'x', report: completedReport('h1', 'same answer'),
      turnId: 'turn-9', sessionId: 'default', liveText: 'same answer',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('same answer as the live turn');
    expect(latestAlternateTakeSet(sql)).toBeNull();
  });
});

describe('recordTakePick over a branch-sourced set — the pipeline unchanged', () => {
  test('picking the branch records corrected + the branch text as the follow-up, without search_nodes', () => {
    // No search_nodes table at all — an agent that never ran MCTS can still
    // pick a branch take (the re-point only applies to mcts-sourced sets).
    const { sql } = setup();
    const set = recordBranchTakeSet(sql, {
      task: 'use approach B instead', turnId: 'turn-9', sessionId: 'default',
      liveText: 'A-style answer', branchText: 'B-style answer',
    })!;

    const record = recordTakePick(sql, { takeId: set.id, nodeId: set.candidates[1]!.nodeId });
    expect(record.outcome).toBe('corrected');
    expect(record.changedAnswer).toBe(true);
    expect(record.chosen.text).toBe('B-style answer');

    const ledger = sql<{ outcome: string; source: string; followup: string | null; turn_id: string }>`
      SELECT outcome, source, followup, turn_id FROM turn_outcomes`[0]!;
    expect(ledger).toMatchObject({
      outcome: 'corrected', source: 'take_pick', followup: 'B-style answer', turn_id: 'turn-9',
    });

    const prompt = buildTakeContinuationPrompt(record.set, record.chosen);
    expect(prompt).toContain('ran as a parallel branch');
    expect(prompt).toContain('B-style answer');
  });

  test('confirming the live answer records acceptance', () => {
    const { sql } = setup();
    const set = recordBranchTakeSet(sql, {
      task: 't', turnId: 'turn-9', sessionId: 'default',
      liveText: 'live answer', branchText: 'branch answer',
    })!;
    const record = recordTakePick(sql, { takeId: set.id, nodeId: set.candidates[0]!.nodeId });
    expect(record.outcome).toBe('accepted');
    expect(record.changedAnswer).toBe(false);
  });
});

describe('alternate_takes schema migration', () => {
  test('a pre-branch table gains the source column; old rows read as mcts', () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    db.exec(`CREATE TABLE alternate_takes (
      id TEXT PRIMARY KEY, turn_id TEXT, session_id TEXT, task TEXT NOT NULL,
      winner_node_id TEXT NOT NULL, chosen_node_id TEXT, candidates TEXT NOT NULL,
      created_at INTEGER NOT NULL, picked_at INTEGER)`);
    db.exec(`INSERT INTO alternate_takes (id, task, winner_node_id, candidates, created_at)
             VALUES ('take-old', 'old task', 'n1', '[]', 1)`);

    initAlternateTakesTable(makeExecRaw(db));
    expect(latestAlternateTakeSet(sql)!.source).toBe('mcts');

    // And the migrated table accepts branch-sourced inserts.
    expect(recordBranchTakeSet(sql, {
      task: 't', turnId: 'turn-1', sessionId: 'default', liveText: 'a', branchText: 'b',
    })).not.toBeNull();
  });
});
