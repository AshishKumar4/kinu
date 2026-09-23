/**
 * Defends: the terminal sequence dropped its effect claims before running, so an interrupted
 * prefix read as a completed turn. Cases force a prefix; recovery is unit-durable-terminal-recovery.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  declareShadowCandidate, orchestratorHarness, chatSessionTurns, reactivateOrchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent, workspaceMainActor,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import type { TurnHarness } from './helpers/turn-harness';
import type { CompletedTurn } from '@kinu.run/core';

import { openTurnRun, TERMINAL_EFFECT_RETRY_CEILING_MS } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

function turns(harness: ActorHarness<HarnessOrchestratorAgent>): TurnHarness {
  return chatSessionTurns(harness.agent);
}

const OVERFLOW_ERROR = 'prompt is too long: 210000 tokens > 200000 maximum';

/** Owed reviews, written in the same insert as the turn: lost reads 0, doubled reads 2. */
function owedReviews(harness: ActorHarness<HarnessOrchestratorAgent>): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query(
      "SELECT COUNT(*) AS n FROM completed_turns WHERE review IN ('awaiting_followup','queued')",
    ).get(),
  ).n;
}

/** Take sets are append-only, so a replayed comparison is a second row. */
function takeSets(harness: ActorHarness<HarnessOrchestratorAgent>): number {
  return rowCount(harness, 'alternate_takes');
}

/** Durable branch-settle log: the only record of a settlement that writes no take set. */
function branchSettlements(harness: ActorHarness<HarnessOrchestratorAgent>): string[] {
  return v.parse(
    v.array(v.object({ detail: v.string() })),
    harness.db.query(
      "SELECT detail FROM activity_log WHERE event = 'branch_settle' ORDER BY created_at, rowid",
    ).all(),
  ).map((row) => row.detail);
}

/** Unsettled branch effect keys; empty means every branch row reached a disposition. */
function owedBranchEffects(
  harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string, messageId: string,
): string[] {
  return harness.agent.harnessTerminalEffects(turnId, messageId)
    .filter((row) => row.effect_key.startsWith('v1:branches:') && row.status !== 'completed')
    .map((row) => row.effect_key);
}

function rowCount(harness: ActorHarness<HarnessOrchestratorAgent>, table: string): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
  ).n;
}

function tickMarkers(harness: ActorHarness<HarnessOrchestratorAgent>, scope: string): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query('SELECT COUNT(*) AS n FROM effect_tombstones WHERE scope = ?').get(scope),
  ).n;
}

function windowedTurns(harness: ActorHarness<HarnessOrchestratorAgent>): number {
  return rowCount(harness, 'completed_turns');
}

/** Settle one response and await the sequence's own join, not a guessed tick count. */
async function settleResponse(
  harness: ActorHarness<HarnessOrchestratorAgent>, messageId: string, text = 'the answer',
): Promise<void> {
  await turns(harness).settle({ messageId, text });
  await harness.agent.harnessTerminalReported();
  await joinHarnessFibers();
}

describe('a terminal transition is claimed before its effects and released after', () => {
  test('a completed turn retains its terminal disposition so a duplicate callback is done', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-live');

    await settleResponse(harness, 'a-live');

    expect(harness.agent.harnessTerminalClaims()).toEqual([
      { turn_id: 'u-live', call_id: 'terminal:response:a-live', result_json: '"settled"' },
    ]);
    expect(harness.agent.harnessBeginTerminalTransition('u-live', 'a-live')).toBe('done');
    // Completed rows are pruned once the outer transition closes; the outer row gates duplicates.
    expect(harness.agent.harnessTerminalEffects('u-live', 'a-live')).toEqual([]);
  });

  /** Auto-continuations keep the user-message id, so the claim is keyed per response, not per turn. */
  test('each response of one durable turn settles its own sequence', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-multi');

    await settleResponse(harness, 'a-step', 'partway');
    await settleResponse(harness, 'a-final', 'the answer');

    expect(harness.agent.harnessTerminalClaims().map((row) => row.call_id)).toEqual([
      'terminal:response:a-final', 'terminal:response:a-step',
    ]);
    expect(windowedTurns(harness)).toBe(2);
  });

  /** An isolate reset between claim and first effect must leave a row with no result. */
  test('a claimed sequence that never finishes stays legible as unfinished', () => {
    const harness = orchestratorHarness();

    expect(harness.agent.harnessBeginTerminalTransition('u-cut')).toBe('first');

    expect(harness.agent.harnessTerminalClaims()).toEqual([
      { turn_id: 'u-cut', call_id: 'terminal:response:a-1', result_json: null },
    ]);
  });

  test('re-entering an unfinished sequence says so, and a released one reads as fresh', () => {
    const harness = orchestratorHarness();

    expect(harness.agent.harnessBeginTerminalTransition('u-again')).toBe('first');
    expect(harness.agent.harnessBeginTerminalTransition('u-again')).toBe('resumed');

    harness.agent.harnessEndTerminalTransition('u-again');
    expect(harness.agent.harnessBeginTerminalTransition('u-again')).toBe('done');
  });

  /** Invented identities would collide: every unclaimable turn would share one key. */
  test('a turn with no durable identity is unclaimed rather than invented', () => {
    const harness = orchestratorHarness();

    expect(harness.agent.harnessBeginTerminalTransition(null)).toBe('unclaimed');
    expect(harness.agent.harnessTerminalClaims()).toEqual([]);
  });
});

describe('an owed follow-up turn is a durable terminal effect', () => {
  /** Queued is RAM: the row stays owed until the retry turn's own row is on disk. */
  test('an overflow retry stays owed until its turn is on disk, across a refused dequeue', async () => {
    const harness = orchestratorHarness();

    await turns(harness).openInFlight('u-overflow');
    harness.agent.harnessRefuseDriving({ reason: 'unavailable', error: 'another activation is driving' });
    const { turnId, messageId } = await turns(harness).settle({ messageId: 'a-overflow', status: 'error', error: OVERFLOW_ERROR });
    await harness.agent.harnessTerminalReported();

    const retry = () => harness.agent.harnessTerminalEffects(turnId, messageId)
      .find((row) => row.effect_key === `v1:overflow_retry:${messageId}`);

    const retryOnDisk = () => harness.agent.harnessChatLoop.announcementOnDisk(`overflow-retry:${messageId}`);

    expect(retryOnDisk()).toBe(false);
    expect(retry()).toMatchObject({ status: 'pending' });

    harness.agent.harnessRefuseDriving(null);
    harness.agent.harnessAdvanceTerminalClock(TERMINAL_EFFECT_RETRY_CEILING_MS);
    await harness.agent.harnessResumeTerminalTransitions();
    await harness.agent.harnessChatLoop.pumpPromise;
    expect(retryOnDisk()).toBe(true);

    harness.agent.harnessAdvanceTerminalClock(TERMINAL_EFFECT_RETRY_CEILING_MS);
    await harness.agent.harnessResumeTerminalTransitions();

    expect(retry()).toBeUndefined();
    expect(harness.agent.harnessTerminalClaims().filter((row) => row.turn_id === turnId)).toEqual([
      { turn_id: turnId, call_id: `terminal:response:${messageId}`, result_json: '"settled"' },
    ]);
    // One retry turn: the replay that found it on disk queued no second.
    expect((await harness.agent.listRuns()).items).toHaveLength(2);
  });
});

/**
 * Each case cuts the sequence at an effect (`before`: owed, replay; `after`: indeterminate, keyed
 * effects replay) and recovers on a fresh activation; only the cut shows a repeat or a drop.
 */
describe('an interrupted terminal sequence replays its suffix and repeats nothing', () => {
  /** The whole sequence is claimed up front, so effects after a first-effect cut still have rows. */
  test('a cut at the first effect still leaves every later effect owed', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-head');
    harness.agent.harnessArmTerminalFault('takes', 'before');

    await expect(turns(harness).settle({ messageId: 'a-head' }))
      .rejects.toThrow('terminal effect takes:a-head interrupted before its side effect');

    const owed = harness.agent.harnessTerminalEffects('u-head', 'a-head');
    expect(owed.map((row) => row.effect_key)).toEqual([
      // No `branches` row: branches are claimed per branch id and this turn launched none.
      'v1:takes:a-head',
      'v1:turn_end_extensions:a-head', 'v1:turn_record:a-head',
      'v1:event_drain:a-head', 'v1:improvement_lanes:a-head',
      'v1:sleep_time:a-head', 'v1:auto_title:a-head', 'v1:auto_gepa:a-head',
    ]);
    expect(owed.every((row) => row.status === 'pending')).toBe(true);
    // The outer transition stays open, so the next activation gets the suffix.
    expect(harness.agent.harnessTerminalClaims()).toEqual([
      { turn_id: 'u-head', call_id: 'terminal:response:a-head', result_json: null },
    ]);
  });


  /**
   * Post-emit and pre-emit cuts are indistinguishable, so the boundary is idempotent and replayed;
   * the window append is keyed on the turn, so it stays one row.
   */
  test('an announcing effect cut after its side effect is replayed, never doubled', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-spine');
    harness.agent.harnessArmTerminalFault('turn_record', 'after');

    await expect(turns(harness).settle({ messageId: 'a-spine' }))
      .rejects.toThrow('terminal effect turn_record:a-spine interrupted after its side effect');
    expect(windowedTurns(harness)).toBe(1);

    // Past the backoff first: a replay before the row is due is correctly a no-op.
    const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
    });

    await restarted.agent.harnessResumeTerminalTransitions();

    // Replayed, not refused: nothing is owed and the outer row closes.
    expect(restarted.agent.harnessTerminalEffects('u-spine', 'a-spine')
      .filter((row) => row.status === 'pending')).toEqual([]);
    expect(windowedTurns(harness)).toBe(1);
  });

  /**
   * The fact upserts, cumulative decays, and tombstone commit as one unit; a separate tombstone
   * let a replay decay twice (0.4 for one turn). The lane's cadence is due on the third turn.
   */
  test('a fact update whose tombstone fails leaves no half-applied prefix', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessFacts().upsert('deploy_target', 'staging', { confidence: 0.6 });
    await turns(harness).settle({ turnId: 'u-one', messageId: 'a-one' });
    await turns(harness).settle({ turnId: 'u-two', messageId: 'a-two' });
    const decayOne = { upserts: [], decay: ['deploy_target'] };
    harness.agent.harnessRecordSleepTimeAnswer('a-decay', decayOne);
    turns(harness).open('u-decay');

    harness.db.exec(`CREATE TRIGGER probe_block_sleep_tombstone
      BEFORE INSERT ON effect_tombstones WHEN NEW.scope = 'sleep_time'
      BEGIN SELECT RAISE(ABORT, 'the tombstone write failed'); END`);

    await turns(harness).settle({ messageId: 'a-decay' });
    await joinHarnessFibers();

    // Unchanged: the decay rolled back with the tombstone.
    expect(harness.agent.harnessFacts().recall('deploy_target')?.confidence).toBe(0.6);
    expect(harness.agent.harnessTerminalEffects('u-decay', 'a-decay')
      .find((row) => row.effect_key === 'v1:sleep_time:a-decay')?.status).toBe('pending');

    harness.db.exec('DROP TRIGGER probe_block_sleep_tombstone');

    const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
      sleepTimeAnswer: ['a-decay', decayOne],
    });

    await restarted.agent.terminalRetryPass();

    // One decay; approximate because it is float subtraction.
    expect(restarted.agent.harnessFacts().recall('deploy_target')?.confidence)
      .toBeCloseTo(0.4, 10);
    expect(restarted.agent.harnessTerminalEffects('u-decay', 'a-decay')).toEqual([]);
  });

  /** A keyed effect cut after its side effect is re-run, because re-running cannot double. */
  test('a keyed effect cut after its side effect is replayed and the sequence closes', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-takes');
    harness.agent.harnessArmTerminalFault('takes', 'after');

    await expect(turns(harness).settle({ messageId: 'a-takes' })).rejects.toThrow('terminal effect takes:a-takes interrupted after its side effect');
    expect(harness.agent.harnessTerminalEffects('u-takes', 'a-takes')
      .find((row) => row.effect_key === 'v1:takes:a-takes')?.status).toBe('pending');

    const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
    });

    await restarted.agent.harnessResumeTerminalTransitions();

    expect(restarted.agent.harnessTerminalEffects('u-takes', 'a-takes')
      .filter((row) => row.status === 'pending')).toEqual([]);
    expect(restarted.agent.harnessBeginTerminalTransition('u-takes', 'a-takes')).toBe('done');
  });

  /** One owed effect keeps the whole transition open. */
  test('the outer transition does not settle while any effect is still owed', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-owed-gate');
    harness.agent.harnessArmTerminalFault('auto_gepa', 'before');

    await turns(harness).settle({ messageId: 'a-owed-gate' });
    await harness.agent.harnessTerminalReported();

    // Named, not an exact set: the injected rejection lands before sibling effects finish recording.
    expect(harness.agent.harnessTerminalEffects('u-owed-gate', 'a-owed-gate')
      .some((row) => row.effect_key === 'v1:auto_gepa:a-owed-gate' && row.status === 'pending'))
      .toBe(true);
    expect(harness.agent.harnessBeginTerminalTransition('u-owed-gate', 'a-owed-gate')).toBe('resumed');
  });

  /** `turn_record` writes the window row and its review in one insert, so each cut leaves exactly one review. */
  test('a cut around the turn recording leaves exactly one owed review', async () => {
    const before = orchestratorHarness();
    turns(before).open('u-rev-b');
    before.agent.harnessArmTerminalFault('turn_record', 'before');
    await expect(turns(before).settle({ messageId: 'a-rev-b' })).rejects.toThrow('terminal effect turn_record:a-rev-b interrupted before its side effect');
    expect(owedReviews(before)).toBe(0);

    const revived = await reactivateOrchestratorHarness(before.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
    });

    await revived.agent.terminalRetryPass();
    expect(owedReviews(before)).toBe(1);

    const after = orchestratorHarness();
    turns(after).open('u-rev-a');
    after.agent.harnessArmTerminalFault('turn_record', 'after');
    await expect(turns(after).settle({ messageId: 'a-rev-a' })).rejects.toThrow('terminal effect turn_record:a-rev-a interrupted after its side effect');
    expect(owedReviews(after)).toBe(1);
    await reactivateOrchestratorHarness(after.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
    });
    // The insert is idempotent on the turn's own id.
    expect(owedReviews(after)).toBe(1);
    expect(windowedTurns(after)).toBe(1);
  });

  /** One row per branch id, so a replay cannot re-settle a branch that already settled. */
  test('each steer branch is claimed under its own key', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-branch');
    harness.agent.harnessDeclarePendingBranch('branch-a', 'try the other library');
    harness.agent.harnessDeclarePendingBranch('branch-b', 'try the other algorithm');
    harness.agent.harnessArmTerminalFault('takes', 'before');

    await expect(turns(harness).settle({ messageId: 'a-branch' })).rejects.toThrow('terminal effect takes:a-branch interrupted before its side effect');

    expect(harness.agent.harnessTerminalEffects('u-branch', 'a-branch')
      .map((row) => row.effect_key)
      .filter((key) => key.startsWith('v1:branches:')))
      .toEqual(['v1:branches:branch-a', 'v1:branches:branch-b']);
  });

  /** Counts the append-only tables the effects touch, so a replayed write shows as a number. */
  test('a cut on either side of the recording leaves exactly one of every append', async () => {
    for (const phase of ['before', 'after'] as const) {
      const harness = orchestratorHarness();
      turns(harness).open(`u-sfx-${phase}`);
      harness.agent.harnessArmTerminalFault('turn_record', phase);

      await expect(turns(harness).settle({ messageId: `a-sfx-${phase}` })).rejects.toThrow(`terminal effect turn_record:a-sfx-${phase} interrupted ${phase} its side effect`);

      // Two passes: the second would double anything the first left un-tombstoned.
      for (let pass = 0; pass < 2; pass++) {
        const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
          clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS * (pass + 1),
        });

        await restarted.agent.harnessResumeTerminalTransitions();
      }

      // One row either side: the tombstone keeps `after` at one, the replay keeps `before` at one.
      expect(windowedTurns(harness)).toBe(1);
      expect(owedReviews(harness)).toBe(1);
    }
  });

  /** A branch is `completed` before its take set is written, so only the settlement key prevents a second set. */
  test('a branch settled twice writes one take set', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-take');
    await harness.agent.harnessRecordBranchReport('branch-x', 'try the other library', 'the branch answer');
    harness.agent.harnessDeclarePendingBranch('branch-x', 'try the other library');
    // Cut before the branch effect, then drop live handles: the journal is the only record.
    harness.agent.harnessArmTerminalFault('branches', 'before');
    await turns(harness).settle({ messageId: 'a-take', text: 'the live answer' });
    await harness.agent.harnessTerminalReported();
    harness.agent.harnessDropPendingBranches();
    expect(takeSets(harness)).toBe(0);

    for (let pass = 0; pass < 3; pass++) {
      const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
        clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS * (pass + 1),
      });

      await restarted.agent.harnessResumeTerminalTransitions();
    }

    // The settlement key names the comparison, not the row, so later replays write nothing.
    expect(takeSets(harness)).toBe(1);
  });

  /** Live settlement via `settlePendingBranch` must carry the settlement key too, or recovery writes a second set. */
  test('a branch settled LIVE and then replayed writes one take set', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-live-take');
    await harness.agent.harnessRecordBranchReport('branch-l', 'try the other library', 'the branch answer');
    harness.agent.harnessDeclareLiveBranch('branch-l', 'try the other library', 'the branch answer');
    harness.agent.harnessArmTerminalFault('branches', 'after');

    await turns(harness).settle({ messageId: 'a-live-take', text: 'the live answer' });
    await harness.agent.harnessTerminalReported();
    expect(takeSets(harness)).toBe(1);
    harness.agent.harnessDropPendingBranches();

    for (let pass = 0; pass < 2; pass++) {
      const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
        clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS * (pass + 1),
      });

      await restarted.agent.harnessResumeTerminalTransitions();
    }

    expect(takeSets(harness)).toBe(1);
  });

  /**
   * A failed head writes no take set, so this reads the settlement log. The replay must look the head
   * up under its derived id; `reconcileOrphanedBranches` stamps `errored` on reportless heads at cold start.
   */
  test('a branch whose head failed settles as a stated refusal, not silence', async () => {
    for (const [branchId, status, message] of [
      ['branch-e', 'errored', 'workspace restarted before the branch settled'],
      ['branch-q', 'budget_exceeded', 'the branch ran out of wall clock'],
    ] as const) {
      const harness = orchestratorHarness();
      turns(harness).open(`u-${branchId}`);
      await harness.agent.harnessSpawnBranchHead(branchId, 'try the other library', {
        status, summary: '', errorMessage: message,
      });
      harness.agent.harnessDeclarePendingBranch(branchId, 'try the other library');
      harness.agent.harnessArmTerminalFault('branches', 'before');
      await turns(harness).settle({ messageId: `a-${branchId}`, text: 'the live answer' });
      await harness.agent.harnessTerminalReported();
      harness.agent.harnessDropPendingBranches();

      const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
        clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
      });

      await restarted.agent.harnessResumeTerminalTransitions();

      // The head's own cause, via `settleBranchIntoTakes`.
      expect(branchSettlements(harness)).toEqual([`error: ${message}`]);
      // No answer, so no comparison — and the row is discharged rather than owed.
      expect(takeSets(harness)).toBe(0);
      expect(owedBranchEffects(restarted, `u-${branchId}`, `a-${branchId}`)).toEqual([]);
    }
  });

  /**
   * Only `running` and `interrupted` heads keep the row owed. Replayed on this activation because a
   * restart's `reconcileOrphanedBranches` seals reportless heads `errored` first.
   */
  test('a branch head still executing keeps the row owed until it reports', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-owed');
    await harness.agent.harnessSpawnBranchHead('branch-o', 'try the other library', null);
    harness.agent.harnessDeclarePendingBranch('branch-o', 'try the other library');
    harness.agent.harnessArmTerminalFault('branches', 'before');
    await turns(harness).settle({ messageId: 'a-owed', text: 'the live answer' });
    await harness.agent.harnessTerminalReported();
    harness.agent.harnessDropPendingBranches();
    harness.agent.harnessDisarmTerminalFault();

    for (const unsettled of ['running', 'interrupted'] as const) {
      if (unsettled === 'interrupted') harness.agent.harnessMarkHeadsInterrupted();
      harness.agent.harnessAdvanceTerminalClock(TERMINAL_EFFECT_RETRY_CEILING_MS);
      await harness.agent.harnessResumeTerminalTransitions();
      expect(harness.agent.harnessBranchHeadStatus('branch-o')).toBe(unsettled);
      expect(takeSets(harness)).toBe(0);
      expect(owedBranchEffects(harness, 'u-owed', 'a-owed')).toEqual(['v1:branches:branch-o']);
    }

    harness.agent.harnessReportBranchHead('branch-o', 'the branch answer');
    harness.agent.harnessAdvanceTerminalClock(TERMINAL_EFFECT_RETRY_CEILING_MS);
    await harness.agent.harnessResumeTerminalTransitions();
    expect(takeSets(harness)).toBe(1);
    expect(owedBranchEffects(harness, 'u-owed', 'a-owed')).toEqual([]);
  });

  /** Counts what the review appends (outcomes, lessons), not the window row. */
  test('a review re-run after a refusal grades the turn once', async () => {
    const harness = orchestratorHarness();

    const turn: CompletedTurn = {
      userMessage: 'use the streaming API', assistantResponse: 'here is a batch call',
      toolCalls: [], durationMs: 1, steps: 1, hadError: false, feedback: null,
      turnId: 'u-review', sessionId: 'default', origin: 'user',
    };

    // Second pass on a fresh activation over the first pass's writes.
    await harness.agent.harnessReviewTurn(turn, 'no, that is the batch API again');
    expect(rowCount(harness, 'turn_outcomes')).toBe(1);
    expect(rowCount(harness, 'lessons')).toBe(1);

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.harnessReviewTurn(turn, 'no, that is the batch API again');

    // The grading and review-step tombstones keep each at one.
    expect(rowCount(harness, 'turn_outcomes')).toBe(1);
    expect(rowCount(harness, 'lessons')).toBe(1);
  });

  /** Scaffold/prompt passes touch the live tool surface, so a cut pass is abandoned to the next tick, not re-run. */
  test('a cut optimisation pass is abandoned, not re-run', async () => {
    const harness = orchestratorHarness();
    let runs = 0;

    await expect(harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      runs++;
      await Promise.reject(new Error('the isolate went away mid-rollout'));
    })).rejects.toThrow('the isolate went away mid-rollout');
    expect(runs).toBe(1);

    await harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      runs++;
      await Promise.resolve();
    });
    expect(runs).toBe(1);

    await harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      runs++;
      await Promise.resolve();
    });
    expect(runs).toBe(1);

    // A new tick is a new obligation: delayed, never dropped.
    await harness.agent.harnessOncePerTick('probe_lane', 'tick-2', async () => {
      runs++;
      await Promise.resolve();
    });
    expect(runs).toBe(2);
  });

  /**
   * The marker is written in the same synchronous slice as the call; an earlier marker would let a
   * cut abandon a tick that never ran, and an idle workspace has no later carrier for it.
   */
  test('the tick marker says entered, not armed', async () => {
    const harness = orchestratorHarness();
    let markersWhenPassStarted = -1;

    await harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      markersWhenPassStarted = tickMarkers(harness, 'probe_lane');
      await Promise.resolve();
    });

    expect(markersWhenPassStarted).toBe(0);
    expect(tickMarkers(harness, 'probe_lane')).toBe(2);
  });

  /** Trials run on the live tool surface, so aborted, errored, and Plan turns must not declare one. */
  test('only a completed build turn declares a shadow trial', async () => {
    const sampled = (harness: ActorHarness<HarnessOrchestratorAgent>): string => {
      for (let i = 0; i < 500; i++) {
        if (harness.agent.harnessShadowPlan(`a-shadow-${i}`) !== null) return `a-shadow-${i}`;
      }

      throw new Error('no sampling id found');
    };

    // The queue, not the pruned ledger row; scoped to this actor because the queue is per-actor.
    const queued = (harness: ActorHarness<HarnessOrchestratorAgent>): number => v.parse(
      v.object({ n: v.number() }),
      harness.db.query('SELECT COUNT(*) AS n FROM scaffold_trial_queue WHERE actor_id = ?')
        .get(workspaceMainActor(harness.db).actorId),
    ).n;

    // Positive control: a completed build turn does owe a trial.
    const open = orchestratorHarness();
    declareShadowCandidate(open.db);
    const openId = sampled(open);
    turns(open).open('u-shadow-ok');
    await turns(open).settle({ messageId: openId });
    await open.agent.harnessTerminalReported();
    expect(queued(open)).toBe(1);

    for (const shut of ['error', 'aborted', 'plan'] as const) {
      const harness = orchestratorHarness();
      declareShadowCandidate(harness.db);
      const messageId = sampled(harness);
      turns(harness).open(`u-shadow-${shut}`);

      // The mode comes from the driving user message, which `onChatResponse` reads.
      if (shut === 'plan') harness.agent.harnessDrivingUserMessage('plan it', { kinuMode: 'plan' });
      await turns(harness).settle({
        messageId, text: 'the answer',
        ...(shut !== 'plan' && { status: shut === 'error' ? 'error' : 'aborted' }),
      });
      await harness.agent.harnessTerminalReported();
      expect(queued(harness)).toBe(0);
    }
  });

  /** Sampling is deterministic per id: a duplicate callback rebuilds the declaration and must claim the same rows. */
  test('one turn always makes the same sampling decision', async () => {
    const harness = orchestratorHarness();
    declareShadowCandidate(harness.db);

    const first = harness.agent.harnessShadowPlan('a-sample');

    for (let ask = 0; ask < 50; ask++) {
      expect(harness.agent.harnessShadowPlan('a-sample')).toEqual(first);
    }

    // A decision, not a constant: across ids both answers occur.
    const spread = new Set(
      Array.from({ length: 200 }, (_, i) => harness.agent.harnessShadowPlan(`a-${i}`) !== null),
    );

    expect(spread).toEqual(new Set([true, false]));
  });

  /**
   * A sequence this activation runs is deferred, not woken on its overdue instant (re-arms every second)
   * nor excluded (the SDK deletes the fired one-shot row, leaving no carrier).
   */
  test('a live sequence keeps a wake, pushed past the busy window', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-live-wake');
    harness.agent.harnessArmTerminalFault('turn_record', 'before');
    await expect(turns(harness).settle({ messageId: 'a-live-wake' })).rejects.toThrow('terminal effect turn_record:a-live-wake interrupted before its side effect');

    const owedAt = present(harness.agent.harnessNextRetryAt(new Set()), 'the owed retry instant');

    const live = new Set([harness.agent.harnessSequenceId('u-live-wake', 'a-live-wake')]);
    const deferredAt = present(harness.agent.harnessNextRetryAt(live), 'the deferred retry instant');
    // Not dropped, and not the overdue instant that would re-arm on every tick.
    expect(deferredAt).toBeGreaterThan(owedAt);
    expect(deferredAt).toBeGreaterThanOrEqual(Date.now() + TERMINAL_EFFECT_RETRY_CEILING_MS - 1_000);
  });

  /** No abandonment: an effect nobody can finish stays owed; convergence is backoff plus the durable wake. */
  test('an effect no activation can finish stays owed rather than being abandoned', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-stuck');
    harness.agent.harnessArmTerminalFault('auto_gepa', 'before');

    await turns(harness).settle({ messageId: 'a-stuck' });
    await harness.agent.harnessTerminalReported();

    for (let attempt = 0; attempt < 5; attempt++) {
      const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
        clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS * (attempt + 1),
        fault: ['auto_gepa', 'before'],
      });

      await restarted.agent.harnessResumeTerminalTransitions();
    }

    const stuck = harness.agent.harnessTerminalEffects('u-stuck', 'a-stuck')
      .find((row) => row.effect_key === 'v1:auto_gepa:a-stuck');

    expect(stuck?.status).toBe('pending');
    expect(harness.agent.harnessBeginTerminalTransition('u-stuck', 'a-stuck')).toBe('resumed');
  });

  /** A rejected close must release its sequence, or every later sweep and alarm skips it. */
  test('a close that rejects releases its sequence to the next sweep', async () => {
    const harness = orchestratorHarness();
    turns(harness).open('u-rejected-close');
    harness.agent.harnessArmTerminalFault('auto_gepa', 'before');

    await turns(harness).settle({ messageId: 'a-rejected-close' });
    await harness.agent.harnessTerminalReported();

    expect(harness.agent.harnessSequencesInFlight()).toBe(0);
  });

  /** A row from a build with a different effect set is blocked by name, never guessed at or dropped. */
  test('an effect this build does not implement is blocked by name, never skipped', async () => {
    const harness = orchestratorHarness();
    expect(harness.agent.harnessBeginTerminalTransition('u-alien', 'a-alien')).toBe('first');
    // Seeded under this agent's actor: `terminal_effects` is keyed by `actor_id`.
    harness.db.prepare(
      `INSERT INTO terminal_effects
         (actor_id, sequence_id, effect_key, effect_name, scope, seq, input_json, status, outcome, attempts, claimed_at, settled_at)
       VALUES (?, 'u-alien/a-alien', 'v9:teleport:a-alien', 'teleport', 'a-alien', 0, '{}', 'pending', NULL, 0, 1, NULL)`,
    ).run(workspaceMainActor(harness.db).actorId);

    await harness.agent.harnessResumeTerminalTransitions();

    const rows = harness.agent.harnessTerminalEffects('u-alien', 'a-alien');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.effect_key).toBe('v9:teleport:a-alien');
    expect(rows[0]?.status).toBe('blocked');
    expect(rows[0]?.outcome).toBe('unknown effect "teleport"');
    // Blocked still gates: a human resolves the deploy-shape problem.
    expect(harness.agent.harnessBeginTerminalTransition('u-alien', 'a-alien')).toBe('resumed');
  });
});

/**
 * Auto-continuations share the durable turn id, so claims are released only when no response can run.
 * `_inFlight` is clear after eviction; the surviving run row is the witness seeded here.
 */
describe('a turn releases its tool claims only when no response can still run', () => {
  /** An open run the isolate died inside; the restart re-opens it as a continuation. */
  function openRun(harness: ActorHarness<HarnessOrchestratorAgent>, runId: string, turnId: string): void {
    openTurnRun(harness.agent.harnessEventRecorder, runId, {
      agentId: workspaceMainActor(harness.db).actorId,
      causedBy: 'chat',
      userMessage: 'the message the turn answers',
      turnIndex: 1,
      turn: { turnId, messageId: 'a-first', kind: 'user', text: 'the message the turn answers' },
    });
  }

  const released = [
    { name: 'a settled response with nothing else running releases them', turn: 'u-done', answer: 'a-done' },
    /** The settling response's own fiber row may still exist at release; it is excluded by request id. */
    {
      name: 'the settling response is not mistaken for another one still running',
      turn: 'u-self',
      answer: 'a-self',
    },
  ] as const;

  for (const { name, turn, answer } of released) {
    test(name, async () => {
      const harness = orchestratorHarness();
      turns(harness).open(turn);
      harness.agent.harnessClaimTool(turn, 'call_send_1');

      await settleResponse(harness, answer);

      expect(harness.agent.harnessToolClaims(turn)).toEqual([]);
    });
  }

  /** Defends: closing the earlier response must keep a live continuation's tool claim. */
  test('cold recovery keeps the claims of a continuation it has not replayed yet', async () => {
    const harness = orchestratorHarness();
    await harness.agent.harnessPersistActiveTurn('u-cont');
    harness.agent.harnessClaimTool('u-cont', 'call_send_1');
    expect(harness.agent.harnessBeginTerminalTransition('u-cont', 'a-first')).toBe('first');
    openRun(harness, 'run-a-cont', 'u-cont');

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.harnessResumeTerminalTransitions();

    expect(restarted.agent.harnessBeginTerminalTransition('u-cont', 'a-first')).toBe('done');
    expect(restarted.agent.harnessToolClaims('u-cont')).toEqual(['call_send_1']);
  });

  /** Negative control: no response of the turn survived, so the close drops the claims. */
  test('cold recovery releases them when no response survived the isolate', async () => {
    const harness = orchestratorHarness();
    await harness.agent.harnessPersistActiveTurn('u-gone');
    harness.agent.harnessClaimTool('u-gone', 'call_send_1');
    expect(harness.agent.harnessBeginTerminalTransition('u-gone', 'a-first')).toBe('first');
    openRun(harness, 'run-other-turn', 'u-other');

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.harnessResumeTerminalTransitions();

    expect(restarted.agent.harnessToolClaims('u-gone')).toEqual([]);
  });
});
