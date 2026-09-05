/**
 * Steer-as-Branch — the single-head branch run (HeadRuntime seam), the settle
 * into the Alternate Takes pipeline (branch-sourced sets), and the pick flow
 * over branch candidates (no search_nodes involvement, 'corrected' + the
 * chosen text as the correction follow-up).
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw, createTestWorkspace } from './helpers';
import {
  initAlternateTakesTable, recordBranchTakeSet, claimAlternateTakesForTurn,
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

function setup() {
  const ws = createTestWorkspace();
  // The production schema, minus search_nodes on purpose: a branch-sourced set
  // has no convergence record, and only an absent table proves the pipeline
  // never reaches for one — an UPDATE matching no row is indistinguishable
  // from an UPDATE that was never issued.
  ws.execRaw('DROP TABLE search_nodes');
  return ws;
}

function completedReport(id: string, summary: string, status: HeadReport['status'] = 'completed'): HeadReport {
  return {
    id, status, summary,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [], toolCalls: [], stepCount: 0,
    usage: { input: 10, output: 20 },
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

/**
 * What a COLD settle reads, and the two things it has to get right: whether the
 * comparison is still owed, and which status to report when it is not.
 *
 * Driven through a real journal row rather than a literal, because the row's ID
 * is half the defect this reading exists for — a branch's head is journalled
 * under `branchHeadId(runId)`, and both backends' replays used to look it up
 * under the run id and find nothing at all.
 */
describe('branchOutcomeFromJournal — the journal read a cold settle makes', () => {
  /** One real branch run, left with the status a caller wants to read back. */
  async function journalled(
    status: HeadReport['status'] | null, summary = 'the branch answer', errorMessage?: string,
  ) {
    const { sql } = setup();
    const journal = new HeadJournal(sql);
    const { runtime } = fakeRuntime(async (input) => {
      if (status === null) return new Promise<HeadReport>(() => { /* spawned, never reports */ });
      const reported = completedReport(input.id, summary, status);
      return errorMessage === undefined ? reported : { ...reported, errorMessage };
    });
    const handle = await startBranchHead(runtime, journal, { task: 'try the other way', inheritedContext: [] });
    if (status !== null) await handle.result;
    return { journal, runId: handle.id };
  }

  /** The row a replay reads, addressed the way a replay addresses it. */
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
    // Spawned, no report.
    expect(readBack(journal, runId)).toBeNull();
    // And after a cold activation's first transition, which is not a settlement.
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
    // The re-point only applies to mcts-sourced sets (see setup()).
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

    initAlternateTakesTable(makeExecRaw(db), makeSql(db));
    expect(latestAlternateTakeSet(sql)!.source).toBe('mcts');

    // And the migrated table accepts branch-sourced inserts.
    expect(recordBranchTakeSet(sql, {
      task: 't', turnId: 'turn-1', sessionId: 'default', liveText: 'a', branchText: 'b',
    })).not.toBeNull();
  });
});

// Every set id here is a fresh `take-${nanoid()}`, so the table has no natural
// conflict to catch a settlement that ran twice: the second attempt would insert
// a second set for one branch and broadcast a different take-set id.
describe('recordBranchTakeSet — the settlement key', () => {
  const args = (settlementKey?: string) => {
    const base = {
      task: 'use approach B instead', turnId: 'turn-9', sessionId: 'default',
      liveText: 'A-style answer', branchText: 'B-style answer',
    };
    return settlementKey === undefined ? base : { ...base, settlementKey };
  };

  test('a replayed keyed settlement returns the SAME set and writes no second one', () => {
    const { sql } = setup();
    const first = recordBranchTakeSet(sql, args('branch:b-1'))!;
    expect(first).not.toBeNull();

    const replay = recordBranchTakeSet(sql, args('branch:b-1'))!;
    expect(replay.id).toBe(first.id);
    expect(replay.candidates).toEqual(first.candidates);
    expect(listAlternateTakeSets(sql)).toHaveLength(1);
  });

  test('a replay after the set row was retired writes nothing', () => {
    const { sql } = setup();
    const first = recordBranchTakeSet(sql, args('branch:b-1'))!;
    void sql`DELETE FROM alternate_takes WHERE id = ${first.id}`;

    // The set existed and was consumed. Re-minting one is the duplicate the key
    // exists to prevent.
    expect(recordBranchTakeSet(sql, args('branch:b-1'))).toBeNull();
    expect(listAlternateTakeSets(sql)).toEqual([]);
  });

  test('a different branch key still records its own set', () => {
    const { sql } = setup();
    recordBranchTakeSet(sql, args('branch:b-1'));
    recordBranchTakeSet(sql, args('branch:b-2'));
    expect(listAlternateTakeSets(sql)).toHaveLength(2);
  });

  test('unkeyed settlements are unchanged — two calls, two sets', () => {
    const { sql } = setup();
    const a = recordBranchTakeSet(sql, args())!;
    const b = recordBranchTakeSet(sql, args())!;
    expect(a.id).not.toBe(b.id);
    expect(listAlternateTakeSets(sql)).toHaveLength(2);
  });
});

describe('settlePendingBranch — the keyed settle both backends run at turn end', () => {
  /** One pending branch whose head resolves with the given answer. */
  async function pendingBranch(answer: string, task = 'try the other way') {
    const { sql } = setup();
    const journal = new HeadJournal(sql);
    const { runtime } = fakeRuntime(async (input) => completedReport(input.id, answer));
    const handle = await startBranchHead(runtime, journal, {
      task,
      inheritedContext: [{ id: 'c1', role: 'user', content: 'original ask', createdAt: 1 }],
    });
    const entry: PendingBranch = { id: handle.id, task, handle: Promise.resolve(handle) };
    return { sql, entry };
  }

  test('settles one branch with its settlement key and broadcasts the take set', async () => {
    const { sql, entry } = await pendingBranch('branch answer');
    const events: BranchStatusEvent[] = [];
    await settlePendingBranch(
      { sql, sessionId: 'default', broadcast: (e) => { events.push(e); } },
      entry,
      'turn-1',
      'the live answer',
      `branch:${entry.id}`,
    );
    const settled = events.filter((e) => e.status === 'settled');
    expect(settled).toHaveLength(1);
    if (settled[0]?.status !== 'settled') throw new Error('expected a settled event');
    expect(settled[0].takeSetId).toBe(latestAlternateTakeSet(sql)!.id);
    expect(listAlternateTakeSets(sql)).toHaveLength(1);
  });

  test('a replayed settlement key returns the same set and writes no second one', async () => {
    const { sql, entry } = await pendingBranch('branch answer');
    const events: BranchStatusEvent[] = [];
    const deps = { sql, sessionId: 'default', broadcast: (e: BranchStatusEvent) => { events.push(e); } };
    await settlePendingBranch(deps, entry, 'turn-1', 'the live answer', `branch:${entry.id}`);
    await settlePendingBranch(deps, entry, 'turn-1', 'the live answer', `branch:${entry.id}`);
    expect(listAlternateTakeSets(sql)).toHaveLength(1);
    const settled = events.filter((e) => e.status === 'settled');
    expect(settled).toHaveLength(2);
    if (settled[0]?.status !== 'settled' || settled[1]?.status !== 'settled') {
      throw new Error('expected settled events');
    }
    expect(settled[1].takeSetId).toBe(settled[0].takeSetId);
  });

  test('a dead live turn aborts the branch and broadcasts an error', async () => {
    const { sql, entry } = await pendingBranch('branch answer');
    const events: BranchStatusEvent[] = [];
    await settlePendingBranch(
      { sql, sessionId: 'default', broadcast: (e) => { events.push(e); } },
      entry,
      null,
      '',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('error');
    expect(latestAlternateTakeSet(sql)).toBeNull();
  });
});
