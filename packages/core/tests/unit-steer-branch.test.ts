/** Steer-as-Branch: the single-head branch run, its settle into Alternate Takes, and the pick flow. */
import { describe, test, expect } from 'bun:test';
import { createTestActor, createTestWorkspace } from './helpers';
import { SessionHistory } from '../src/session/history';
import { CHAT_SESSION_ID } from '../src/session/transcript-schema';
import {
  recordBranchTakeSet, claimAlternateTakesForTurn,
  latestAlternateTakeSet, listAlternateTakeSets, recordTakePick, buildTakeContinuationPrompt,
} from '../src/mcts/takes';
import { HeadJournal } from '../src/heads/journal';
import type { HeadRuntime, SpawnedHead } from '../src/heads/controller';
import type { HeadInput, HeadReport } from '../src/heads/types';
import {
  BRANCH_HEAD_BUDGET, BRANCH_RATIONALE, startBranchHead, settleBranchIntoTakes,
  settlePendingBranch, branchHeadId, branchOutcomeFromJournal,
  type BranchStatusEvent, type PendingBranch,
} from '../src/steer-branch';
import { branchesTerminalEffect } from '../src/orchestrator/terminal-effects';
import { present } from '@kinu.run/test-utils';

function setup() {
  const ws = createTestWorkspace();
  // search_nodes omitted on purpose: only an absent table proves a branch-sourced set never
  // reaches for a convergence record.
  ws.execRaw('DROP TABLE search_nodes');

  const actor = createTestActor(ws.sql, ws.execRaw, 'ws-steer', 'steer');

  const history = new SessionHistory({
    sql: ws.sql, actor, transactionSync: write => ws.db.transaction(write)(),
    files: async () => ({ vfs: ws.vfs, artifactDirectory: '/actor/.kinu/context' }),
  });

  return { ...ws, actor, transcript: history.transcript(CHAT_SESSION_ID) };
}

function completedReport(id: string, summary: string, status: HeadReport['status'] = 'completed'): HeadReport {
  return {
    id, status, summary,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [], stepCount: 0,
    usage: { input: 10, output: 20 },
    wallClockMs: 5,
  };
}

/** A HeadRuntime whose single head resolves with `report` (or runs `body`), recording spawns and aborts. */
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
    const { sql, actor } = setup();
    const journal = new HeadJournal(sql, actor);
    const { runtime, spawns } = fakeRuntime(async (input) => completedReport(input.id, 'branch answer'));

    const handle = await startBranchHead(runtime, journal, {
      task: 'try the other approach',
      inheritedContext: [{ id: 'c1', role: 'user', content: 'original ask', createdAt: 1 }],
    });

    const report = await handle.result;

    expect(report.status).toBe('completed');
    expect(report.summary).toBe('branch answer');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      task: 'try the other approach',
      rationale: BRANCH_RATIONALE,
      rootId: handle.id,
      mergeStrategy: 'best_of',
    });
    expect(spawns[0].budget.maxDepth).toBe(BRANCH_HEAD_BUDGET.maxDepth);
    expect(spawns[0].inheritedContext[0].content).toBe('original ask');

    const row = present(journal.readHead(spawns[0].id), 'the journaled head row');
    expect(row.status).toBe('completed');
    expect(row.summary).toBe('branch answer');
    expect(journal.readTree(handle.id)).toHaveLength(1);
  });

  test('abort delegates to the spawned head', async () => {
    const { sql, actor } = setup();
    const journal = new HeadJournal(sql, actor);
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

/**
 * What a cold settle reads: whether the comparison is still owed, and which status to report.
 * A branch's head is journalled under `branchHeadId(runId)`, not the run id.
 */
describe('branchOutcomeFromJournal — the journal read a cold settle makes', () => {
  async function journalled(
    status: HeadReport['status'] | null, summary = 'the branch answer', errorMessage?: string,
  ) {
    const { sql, actor } = setup();
    const journal = new HeadJournal(sql, actor);

    const { runtime } = fakeRuntime(async (input) => {
      if (status === null) return new Promise<HeadReport>(() => { /* spawned, never reports */ });
      const reported = completedReport(input.id, summary, status);

      return errorMessage === undefined ? reported : { ...reported, errorMessage };
    });

    const handle = await startBranchHead(runtime, journal, { task: 'try the other way', inheritedContext: [] });

    if (status !== null) await handle.result;

    return { journal, runId: handle.id };
  }

  function readBack(journal: HeadJournal, runId: string) {
    const head = journal.readHeadView(branchHeadId(runId));

    if (head === null) throw new Error(`no journal row for the head of ${runId}`);

    return branchOutcomeFromJournal(head);
  }

  test('a reported head comes back under its OWN status, not flattened to errored', async () => {
    for (const status of ['completed', 'budget_exceeded', 'aborted', 'errored'] as const) {
      const { journal, runId } = await journalled(status, 'what it found', 'the stated cause');
      expect(readBack(journal, runId)).toEqual({
        status, summary: 'what it found', errorMessage: 'the stated cause',
      });
    }
  });

  test('a reported head with no failure message carries none', async () => {
    const { journal, runId } = await journalled('completed');
    expect(readBack(journal, runId)).toEqual({ status: 'completed', summary: 'the branch answer' });
  });

  test('a head still executing is owed — under both unsettled statuses', async () => {
    const { journal, runId } = await journalled(null);
    expect(readBack(journal, runId)).toBeNull();
    // A cold activation's first transition is not a settlement.
    journal.markInterrupted();
    expect(journal.readHeadView(branchHeadId(runId))?.status).toBe('interrupted');
    expect(readBack(journal, runId)).toBeNull();
  });

  test('a status no journal writes is reported errored rather than owed forever', async () => {
    const { journal, runId } = await journalled(null);
    expect(branchOutcomeFromJournal({ status: 'teleported', summary: null, errorMessage: null })).toEqual({
      status: 'errored', summary: '',
      errorMessage: 'the branch head\'s journal row carries an unrecognized status "teleported"',
    });
    // The real row is untouched by that reading, and is still owed.
    expect(readBack(journal, runId)).toBeNull();
  });
});

describe('settleBranchIntoTakes — honest settle into ONE takes pipeline', () => {
  test('a completed branch + completed live turn persist a claimed branch-sourced pair', () => {
    const { sql, actor } = setup();

    const outcome = settleBranchIntoTakes(sql, actor, {
      task: 'use approach B instead',
      report: completedReport('h1', 'B-style answer'),
      turnId: 'turn-9',
      sessionId: 'default',
      liveText: 'A-style answer',
    });

    expect(outcome.ok).toBe(true);

    const set = present(latestAlternateTakeSet(sql, actor), 'the latest alternate-take set');
    expect(set).toMatchObject({ source: 'branch', turnId: 'turn-9', sessionId: 'default', task: 'use approach B instead' });
    expect(set.candidates).toHaveLength(2);
    expect(set.candidates[0]).toMatchObject({ text: 'A-style answer', origin: 'live' });
    expect(set.candidates[1]).toMatchObject({ text: 'B-style answer', origin: 'branch' });
    expect(set.winnerNodeId).toBe(set.candidates[0].nodeId);
    expect(set.chosenNodeId).toBeNull();

    // Already claimed — the turn-end claim sweep finds nothing unclaimed.
    expect(claimAlternateTakesForTurn(sql, actor, { turnId: 'other', sessionId: 'default', startedAt: 0 })).toBe(0);
    expect(present(latestAlternateTakeSet(sql, actor), 'the latest alternate-take set').turnId).toBe('turn-9');
  });

  test('an errored branch writes NO takes set and surfaces the failure reason', () => {
    const { sql, actor } = setup();
    const report = { ...completedReport('h1', '', 'errored'), errorMessage: 'model exploded' };

    const outcome = settleBranchIntoTakes(sql, actor, {
      task: 'x', report, turnId: 'turn-9', sessionId: 'default', liveText: 'live',
    });

    expect(outcome).toEqual({ ok: false, reason: 'model exploded' });
    expect(latestAlternateTakeSet(sql, actor)).toBeNull();
  });

  test('an interrupted live turn writes NO takes set', () => {
    const { sql, actor } = setup();

    const outcome = settleBranchIntoTakes(sql, actor, {
      task: 'x', report: completedReport('h1', 'branch answer'),
      turnId: null, sessionId: 'default', liveText: '',
    });

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) expect(outcome.reason).toContain('live turn did not complete');
    expect(latestAlternateTakeSet(sql, actor)).toBeNull();
  });

  test('identical answers offer no choice — no takes set', () => {
    const { sql, actor } = setup();

    const outcome = settleBranchIntoTakes(sql, actor, {
      task: 'x', report: completedReport('h1', 'same answer'),
      turnId: 'turn-9', sessionId: 'default', liveText: 'same answer',
    });

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) expect(outcome.reason).toContain('same answer as the live turn');
    expect(latestAlternateTakeSet(sql, actor)).toBeNull();
  });
});

describe('recordTakePick over a branch-sourced set — the pipeline unchanged', () => {
  test('picking the branch records corrected + the branch text as the follow-up, without search_nodes', async () => {
    // The re-point only applies to mcts-sourced sets (see setup()).
    const { sql, actor, transcript } = setup();

    const set = present(recordBranchTakeSet(sql, actor, {
      task: 'use approach B instead', turnId: 'turn-9', sessionId: 'default',
      liveText: 'A-style answer', branchText: 'B-style answer',
    }), 'the recorded take set');

    const record = await recordTakePick(sql, actor, transcript, { takeId: set.id, nodeId: set.candidates[1].nodeId });
    expect(record.outcome).toBe('corrected');
    expect(record.changedAnswer).toBe(true);
    expect(record.chosen.text).toBe('B-style answer');

    const ledger = sql<{ outcome: string; source: string; followup: string | null; turn_id: string }>`
      SELECT outcome, source, followup, turn_id FROM turn_outcomes`[0];

    expect(ledger).toMatchObject({
      outcome: 'corrected', source: 'take_pick', followup: 'B-style answer', turn_id: 'turn-9',
    });

    const prompt = buildTakeContinuationPrompt(record.set, record.chosen);
    expect(prompt).toContain('ran as a parallel branch');
    expect(prompt).toContain('B-style answer');
  });

  test('confirming the live answer records acceptance', async () => {
    const { sql, actor, transcript } = setup();

    const set = present(recordBranchTakeSet(sql, actor, {
      task: 't', turnId: 'turn-9', sessionId: 'default',
      liveText: 'live answer', branchText: 'branch answer',
    }), 'the recorded take set');

    const record = await recordTakePick(sql, actor, transcript, { takeId: set.id, nodeId: set.candidates[0].nodeId });
    expect(record.outcome).toBe('accepted');
    expect(record.changedAnswer).toBe(false);
  });
});


// Set ids are fresh, so no natural conflict catches a settlement that ran twice.
describe('recordBranchTakeSet — the settlement key', () => {
  const args = (settlementKey?: string) => {
    const base = {
      task: 'use approach B instead', turnId: 'turn-9', sessionId: 'default',
      liveText: 'A-style answer', branchText: 'B-style answer',
    };

    return settlementKey === undefined ? base : { ...base, settlementKey };
  };

  test('a replayed keyed settlement returns the SAME set and writes no second one', () => {
    const { sql, actor } = setup();
    const first = present(recordBranchTakeSet(sql, actor, args('branch:b-1')), 'the recorded take set');

    const replay = present(recordBranchTakeSet(sql, actor, args('branch:b-1')), 'the recorded take set');
    expect(replay.id).toBe(first.id);
    expect(replay.candidates).toEqual(first.candidates);
    expect(listAlternateTakeSets(sql, actor)).toHaveLength(1);
  });

  test('a replay after the set row was retired writes nothing', () => {
    const { sql, actor } = setup();
    const first = present(recordBranchTakeSet(sql, actor, args('branch:b-1')), 'the recorded take set');
    void sql`DELETE FROM alternate_takes WHERE id = ${first.id}`;

    // Re-minting a consumed set is the duplicate the key prevents.
    expect(recordBranchTakeSet(sql, actor, args('branch:b-1'))).toBeNull();
    expect(listAlternateTakeSets(sql, actor)).toEqual([]);
  });

  test('a different branch key still records its own set', () => {
    const { sql, actor } = setup();
    recordBranchTakeSet(sql, actor, args('branch:b-1'));
    recordBranchTakeSet(sql, actor, args('branch:b-2'));
    expect(listAlternateTakeSets(sql, actor)).toHaveLength(2);
  });

  test('unkeyed settlements are unchanged — two calls, two sets', () => {
    const { sql, actor } = setup();
    const a = present(recordBranchTakeSet(sql, actor, args()), 'the recorded take set');
    const b = present(recordBranchTakeSet(sql, actor, args()), 'the recorded take set');
    expect(a.id).not.toBe(b.id);
    expect(listAlternateTakeSets(sql, actor)).toHaveLength(2);
  });
});

describe('settlePendingBranch — the keyed settle both backends run at turn end', () => {
  async function pendingBranch(answer: string, task = 'try the other way') {
    const { sql, actor } = setup();
    const journal = new HeadJournal(sql, actor);
    const { runtime } = fakeRuntime(async (input) => completedReport(input.id, answer));

    const handle = await startBranchHead(runtime, journal, {
      task,
      inheritedContext: [{ id: 'c1', role: 'user', content: 'original ask', createdAt: 1 }],
    });

    const entry: PendingBranch = { id: handle.id, task, handle: Promise.resolve(handle) };

    return { sql, actor, entry };
  }

  test('settles one branch with its settlement key and broadcasts the take set', async () => {
    const { sql, actor, entry } = await pendingBranch('branch answer');
    const events: BranchStatusEvent[] = [];
    await settlePendingBranch(
      { sql, actor, sessionId: 'default', broadcast: (e) => { events.push(e); } },
      { entry, turnId: 'turn-1', liveText: 'the live answer', settlementKey: `branch:${entry.id}` },
    );
    const settled = events.filter((e) => e.status === 'settled');
    expect(settled).toHaveLength(1);

    if (settled[0]?.status !== 'settled') throw new Error('expected a settled event');
    expect(settled[0].takeSetId).toBe(present(latestAlternateTakeSet(sql, actor), 'the latest alternate-take set').id);
    expect(listAlternateTakeSets(sql, actor)).toHaveLength(1);
  });

  test('a replayed settlement key returns the same set and writes no second one', async () => {
    const { sql, actor, entry } = await pendingBranch('branch answer');
    const events: BranchStatusEvent[] = [];

    const deps = {
      sql, actor, sessionId: 'default', broadcast: (e: BranchStatusEvent) => { events.push(e); },
    };

    const settlement = { entry, turnId: 'turn-1', liveText: 'the live answer', settlementKey: `branch:${entry.id}` };
    await settlePendingBranch(deps, settlement);
    await settlePendingBranch(deps, settlement);
    expect(listAlternateTakeSets(sql, actor)).toHaveLength(1);
    const settled = events.filter((e) => e.status === 'settled');
    expect(settled).toHaveLength(2);

    if (settled[0]?.status !== 'settled' || settled[1]?.status !== 'settled') {
      throw new Error('expected settled events');
    }

    expect(settled[1].takeSetId).toBe(settled[0].takeSetId);
  });

  test('a dead live turn aborts the branch and broadcasts an error', async () => {
    const { sql, actor, entry } = await pendingBranch('branch answer');
    const events: BranchStatusEvent[] = [];
    await settlePendingBranch(
      { sql, actor, sessionId: 'default', broadcast: (e) => { events.push(e); } },
      { entry, turnId: null, liveText: '' },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('error');
    expect(latestAlternateTakeSet(sql, actor)).toBeNull();
  });

  test('a branch whose head never started settles with its reason recorded, as a journal settle does', async () => {
    const { sql, actor } = setup();
    const events: BranchStatusEvent[] = [];

    const effect = branchesTerminalEffect({
      sql, actor, sessionId: 'default', broadcast: (e) => { events.push(e); },
      pending: [{ id: 'b-1', task: 'try the other way', handle: Promise.reject(new Error('the head could not start')) }],
      journal: new HeadJournal(sql, actor),
    });

    const outcome = await effect.run({ id: 'b-1', task: 'try the other way', turnId: 'turn-1', liveText: 'the live answer' }, 'scope');

    expect(outcome).toEqual({ status: 'completed', detail: 'the head could not start' });
    expect(events.map((e) => e.status)).toEqual(['error']);
  });
});
