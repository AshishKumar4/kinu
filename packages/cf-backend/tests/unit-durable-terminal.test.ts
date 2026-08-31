/**
 * What a settled turn causes, and what survives an interruption in the middle
 * of causing it.
 *
 * A durable turn ends once, and everything downstream hangs off that one
 * moment: the reply an answered event batch owes, the takes claim, the extension
 * turn-end, the between-turn evolution lanes. The sequence had no durable
 * marker, so an interruption left a prefix nobody could tell from a completed
 * turn — and the effect claims that would have made a replay safe were dropped
 * at the TOP of the sequence, before any of it ran.
 *
 * Every case here forces a prefix rather than asserting an end state. The defect
 * was an ordering one, so a test that let the whole sequence run would read the
 * same either way.
 *
 * What a resumed activation does with the leases and fibers an interruption left
 * behind is unit-durable-terminal-recovery.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  orchestratorHarness,
  reactivateOrchestratorHarness,
  type ActorHarness,
  type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import type { AgentSignal, CompletedTurn } from '@kinu.run/core';
import { createChatFiberSnapshot, wrapChatFiberSnapshot } from 'agents/chat';
import { CHAT_TURN_SNAPSHOT_KEY } from '../src/fiber-recovery';
import { projectJsonValue, TERMINAL_EFFECT_RETRY_CEILING_MS } from '@kinu.run/core';

/** One settled assistant response, as Think reports it. */
function settledResponse(messageId: string, text = 'the answer'): Parameters<
  HarnessOrchestratorAgent['onChatResponse']
>[0] {
  return {
    message: { id: messageId, role: 'assistant', parts: [{ type: 'text', text }] },
    requestId: `req-${messageId}`, continuation: false, status: 'completed',
  };
}

function overflowResponse(messageId: string): Parameters<
  HarnessOrchestratorAgent['onChatResponse']
>[0] {
  return {
    message: { id: messageId, role: 'assistant', parts: [] },
    requestId: `req-${messageId}`,
    continuation: false,
    status: 'error',
    error: 'prompt is too long: 210000 tokens > 200000 maximum',
  };
}

/**
 * How many reviews the window OWES — parked awaiting a follow-up or queued for a
 * host, since both are obligations somebody still has to discharge.
 *
 * The oracle for the review obligation: `turn_record` writes it in the same
 * insert as the turn, so a lost review counts 0 and a doubled one counts 2.
 */
function owedReviews(harness: ActorHarness<HarnessOrchestratorAgent>): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query(
      "SELECT COUNT(*) AS n FROM completed_turns WHERE review IN ('awaiting_followup','queued')",
    ).get(),
  ).n;
}

/** How many alternate-take sets exist. The oracle for the branch settlement key:
 *  the write is append-only, so a replayed comparison shows up as a second row. */
function takeSets(harness: ActorHarness<HarnessOrchestratorAgent>): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query('SELECT COUNT(*) AS n FROM alternate_takes').get(),
  ).n;
}

/**
 * What each branch settlement told the workspace, oldest first.
 *
 * The oracle for a settlement that writes NO take set: a failed branch has no
 * answer to compare, so the takes table cannot tell a stated refusal from a
 * dropped one. `branchSettle` is the durable half of the same broadcast the chip
 * renders, so it survives the activation that wrote it — which the broadcast,
 * being a live socket write, does not.
 */
function branchSettlements(harness: ActorHarness<HarnessOrchestratorAgent>): string[] {
  return v.parse(
    v.array(v.object({ detail: v.string() })),
    harness.db.query(
      "SELECT detail FROM activity_log WHERE event = 'branch_settle' ORDER BY created_at, rowid",
    ).all(),
  ).map((row) => row.detail);
}

/** The branch effects this sequence still owes, by key. Empty means every branch
 *  row reached a disposition — pruned or recorded — rather than being carried. */
function owedBranchEffects(
  harness: ActorHarness<HarnessOrchestratorAgent>, turnId: string, messageId: string,
): string[] {
  return harness.agent.harnessTerminalEffects(turnId, messageId)
    .filter((row) => row.effect_key.startsWith('v1:branches:') && row.status !== 'completed')
    .map((row) => row.effect_key);
}

/** How many turns the evolution window holds. The duplicate oracle for the
 *  settle spine: its recording mints a fresh row id per append, so a spine that
 *  ran twice for one answer is two rows and nothing else could make it two. */
function rowCount(harness: ActorHarness<HarnessOrchestratorAgent>, table: string): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
  ).n;
}

/** The cadence markers one lane holds. The oracle for what the abandonment
 *  branch reads: entry and completion are one row each. */
function tickMarkers(harness: ActorHarness<HarnessOrchestratorAgent>, scope: string): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query('SELECT COUNT(*) AS n FROM effect_tombstones WHERE scope = ?').get(scope),
  ).n;
}

function windowedTurns(harness: ActorHarness<HarnessOrchestratorAgent>): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query('SELECT COUNT(*) AS n FROM completed_turns').get(),
  ).n;
}

/**
 * Drive one settled response and wait for its terminal sequence to finish.
 *
 * `harnessTerminalReported` is the sequence's OWN join, so this waits on the
 * outcome rather than on a guessed number of ticks: the detached effects each
 * await real work (a dynamic import, a between-turn model call), and a fixed
 * wait would assert against whatever had happened by then.
 */
async function settleResponse(
  harness: ActorHarness<HarnessOrchestratorAgent>, messageId: string, text = 'the answer',
): Promise<void> {
  await harness.agent.onChatResponse(settledResponse(messageId, text));
  await harness.agent.harnessTerminalReported();
  await joinHarnessFibers();
}

describe('a terminal transition is claimed before its effects and released after', () => {
  test('a completed turn retains its terminal disposition so a duplicate callback is done', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-live');

    await settleResponse(harness, 'a-live');

    expect(harness.agent.harnessTerminalClaims()).toEqual([
      { turn_id: 'u-live', call_id: 'terminal:response:a-live', result_json: '"settled"' },
    ]);
    expect(harness.agent.harnessBeginTerminalTransition('u-live', 'a-live')).toBe('done');
    // Completed rows are pruned once the outer transition closes: their whole
    // purpose was to gate it, and the settled outer row is what a duplicate
    // callback reads.
    expect(harness.agent.harnessTerminalEffects('u-live', 'a-live')).toEqual([]);
  });

  /**
   * The defect this identity exists for.
   *
   * Think fires this hook once per RESPONSE and an auto-continuation keeps the
   * turn's user-message id. Keyed on the turn alone, the first continuation's
   * sequence settled the claim and the SECOND — the one carrying the actual
   * answer — read `done` and skipped every effect it owed. The oracle is the
   * evolution window: two answers, two recorded turns.
   */
  test('each response of one durable turn settles its own sequence', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-multi');

    await settleResponse(harness, 'a-step', 'partway');
    await settleResponse(harness, 'a-final', 'the answer');

    expect(harness.agent.harnessTerminalClaims().map((row) => row.call_id)).toEqual([
      'terminal:response:a-final', 'terminal:response:a-step',
    ]);
    expect(windowedTurns(harness)).toBe(2);
  });

  /**
   * The forced prefix: the claim is written, and then nothing else happens.
   *
   * This is what an isolate reset between the claim and the first effect leaves
   * behind, and the assertion is that it is LEGIBLE — a row with no result. The
   * old code had no row at all here, which is why an interrupted sequence and a
   * completed one were the same observation.
   */
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
    // A second attempt against a claim with no recorded result: resume, not
    // repeat, and not a silent first-run.
    expect(harness.agent.harnessBeginTerminalTransition('u-again')).toBe('resumed');

    harness.agent.harnessEndTerminalTransition('u-again');
    // The settled disposition is durable, so duplicate terminal callbacks are
    // no-ops rather than a new first attempt.
    expect(harness.agent.harnessBeginTerminalTransition('u-again')).toBe('done');
  });

  /** The negative control for the claim itself. A turn with no durable identity
   *  must not be given one — otherwise every unclaimable turn would share a key
   *  and the second of them would read as already done. */
  test('a turn with no durable identity is unclaimed rather than invented', () => {
    const harness = orchestratorHarness();

    expect(harness.agent.harnessBeginTerminalTransition(null)).toBe('unclaimed');
    expect(harness.agent.harnessTerminalClaims()).toEqual([]);
  });
});

describe('overflow retry delivery is a durable terminal effect', () => {
  test('an undelivered retry stays owed and replays with the same identity', async () => {
    const harness = orchestratorHarness();
    const delivered: AgentSignal[] = [];
    harness.agent.harnessSetSignalDeliverer(async (signal) => {
      delivered.push(signal);
      return 'undelivered';
    });
    harness.agent.declareTurnCheckpoint('u-overflow');

    await harness.agent.onChatResponse(overflowResponse('a-overflow'));
    await harness.agent.harnessTerminalReported();
    await joinHarnessFibers();

    const first = harness.agent.harnessTerminalEffects('u-overflow', 'a-overflow')
      .find((row) => row.effect_key === 'v1:overflow_retry:a-overflow');
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });

    const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
      beforeStart: (agent) => {
        agent.harnessSetSignalDeliverer(async (signal) => {
          delivered.push(signal);
          return 'queued';
        });
      },
    });
    // Reactivation CLASSIFIES and arms; the durable wake is what replays.
    await restarted.agent._kinuTerminalRetryTick();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.idempotencyKey).toBe('overflow-retry:a-overflow');
    expect(delivered[1]?.idempotencyKey).toBe(delivered[0]?.idempotencyKey);
    expect(restarted.agent.harnessTerminalEffects('u-overflow', 'a-overflow')).toEqual([]);
    expect(restarted.agent.harnessTerminalClaims()).toEqual([
      { turn_id: 'u-overflow', call_id: 'terminal:response:a-overflow', result_json: '"settled"' },
    ]);
  });
});

/**
 * The exactly-once claim, tested where it is actually made: at a named instant
 * inside the sequence.
 *
 * Every case here CUTS the sequence — `harnessArmTerminalFault` throws at a
 * chosen effect, before or after its side effect — and then re-drives recovery
 * on a FRESH activation over the surviving storage. An end-state test cannot
 * distinguish the two failures this design exists to prevent: an effect repeated
 * because nobody recorded that it happened, and an effect dropped because the
 * marker said the turn was done. Both are only visible at the cut.
 *
 * `before` and `after` are the two instants that matter. `before` is "nothing
 * happened" — the effect is owed and must be replayed. `after` is "it happened
 * and nothing recorded it" — the indeterminate case, where a keyed effect is
 * replayed and an announcing one is refused rather than announced twice.
 */
describe('an interrupted terminal sequence replays its suffix and repeats nothing', () => {
  /**
   * The reason the whole sequence is claimed before any of it runs.
   *
   * Cut at the FIRST effect and every later effect must already have a row with
   * its input written down. Claiming each effect just before its own side effect
   * would leave the ones after the cut with no row at all — indistinguishable
   * from effects that were never owed, which is a suffix nobody can replay.
   */
  test('a cut at the first effect still leaves every later effect owed', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-head');
    harness.agent.harnessArmTerminalFault('takes', 'before');

    await expect(harness.agent.onChatResponse(settledResponse('a-head')))
      .rejects.toThrow(/interrupted before its side effect/u);

    const owed = harness.agent.harnessTerminalEffects('u-head', 'a-head');
    expect(owed.map((row) => row.effect_key)).toEqual([
      // No `branches` row: this turn launched none, and branches are claimed one
      // row per branch id rather than one row for the list.
      'v1:takes:a-head',
      'v1:turn_end_extensions:a-head', 'v1:turn_record:a-head',
      'v1:event_drain:a-head', 'v1:improvement_lanes:a-head',
      'v1:sleep_time:a-head', 'v1:auto_title:a-head', 'v1:auto_gepa:a-head',
    ]);
    expect(owed.every((row) => row.status === 'pending')).toBe(true);
    // And the outer transition is still open, so the next activation is handed
    // the suffix rather than told the turn was done.
    expect(harness.agent.harnessTerminalClaims()).toEqual([
      { turn_id: 'u-head', call_id: 'terminal:response:a-head', result_json: null },
    ]);
  });

  /**
   * The window between a PERSISTED ANSWER and the claim that makes its effects
   * recoverable.
   *
   * Think commits the assistant message before it calls `onChatResponse`, and the
   * hook used to await the response-to-model-message conversion before any claim
   * existed. A conversion that throws — or an eviction inside it — therefore left
   * a durable answer with no incomplete transition, so `resumeAll()` found nothing
   * and every effect the turn owed was lost. The conversion now runs inside the
   * `turn_end_extensions` body, where the claim already exists.
   *
   * The oracle is a message the conversion CANNOT read. Before the move it took
   * the whole sequence with it and left no row at all; now the roster is claimed,
   * every other effect runs, and only that one effect records the refusal.
   */
  test('a message the conversion cannot read costs that effect and no others', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-unreadable');
    harness.agent.harnessArmTerminalFault('turn_record', 'before');

    const unreadable = settledResponse('a-unreadable');
    // The one shape `convertToModelMessages` refuses outright. Cast because the
    // SDK's own type forbids it — which is the point: this is a stored row the
    // converter will never accept, however many times it is replayed.
    Reflect.set(unreadable.message, 'role', 'tool');

    await expect(harness.agent.onChatResponse(unreadable))
      .rejects.toThrow(/interrupted before its side effect/u);

    // THE CLAIM EXISTS. Nothing before it awaited, so the answer's effects are
    // recoverable even though reading the answer itself failed.
    expect(harness.agent.harnessTerminalClaims()).toEqual([
      { turn_id: 'u-unreadable', call_id: 'terminal:response:a-unreadable', result_json: null },
    ]);

    const rows = harness.agent.harnessTerminalEffects('u-unreadable', 'a-unreadable');
    const turnEnd = rows.find((row) => row.effect_key === 'v1:turn_end_extensions:a-unreadable');
    // A REFUSAL, not an owed row: the stored message never changes, so retrying
    // it would hold the transition open for good.
    expect(turnEnd?.status).toBe('completed');
    expect(turnEnd?.outcome).toMatch(/recorded assistant message/u);
    // The effect before it ran, and the suffix after the cut is still owed.
    expect(rows.filter((row) => row.status === 'pending').map((row) => row.effect_key)).toEqual([
      'v1:turn_record:a-unreadable', 'v1:event_drain:a-unreadable',
      'v1:improvement_lanes:a-unreadable', 'v1:sleep_time:a-unreadable',
      'v1:auto_title:a-unreadable', 'v1:auto_gepa:a-unreadable',
    ]);
  });

  /**
   * The instant that used to be unrecoverable, on the effect where repeating is
   * worst.
   *
   * The extension emit fired and then the isolate died before anything recorded
   * that. The earlier design REFUSED this row on every recovery, which also
   * dropped it when the interruption had come BEFORE the emit — so the answer is
   * not to refuse but to make the boundary idempotent and replay it. The oracle
   * is the evolution window: its append is keyed on the turn's own identity, so a
   * recording that ran twice for one answer would still be ONE row, and a
   * recording that never ran would be zero.
   */
  test('an announcing effect cut after its side effect is replayed, never doubled', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-spine');
    harness.agent.harnessArmTerminalFault('turn_record', 'after');

    await expect(harness.agent.onChatResponse(settledResponse('a-spine')))
      .rejects.toThrow(/interrupted after its side effect/u);
    expect(windowedTurns(harness)).toBe(1);

    // Past the backoff BEFORE the activation runs its own reconcile: an owed row
    // is retried on a schedule, never abandoned, so a replay before it is due is
    // correctly a no-op.
    const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
    });
    await restarted.agent.harnessResumeTerminalTransitions();

    // Replayed, not refused: nothing is owed and the outer row closes.
    expect(restarted.agent.harnessTerminalEffects('u-spine', 'a-spine')
      .filter((row) => row.status === 'pending')).toEqual([]);
    // And the idempotent append is what makes the replay safe: one answer, one
    // window row, across the restart.
    expect(windowedTurns(harness)).toBe(1);
  });

  /**
   * The fact update and its tombstone, as ONE unit.
   *
   * `applySleepTimeUpdate` commits several upserts and several CUMULATIVE
   * confidence decays, and the tombstone used to be a statement after all of
   * them. A termination in between left the whole update retryable with a prefix
   * already applied, so a replay took another 0.2 off a fact it had already
   * decayed — 0.4 for one turn's decision.
   *
   * The injected failure is the exact instant the defect names: the fact writes
   * have landed and the tombstone write throws. Rolled back, the retry applies the
   * update once; committed separately, it would apply the decay twice.
   */
  test('a fact update whose tombstone fails leaves no half-applied prefix', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessFacts().upsert('deploy_target', 'staging', { confidence: 0.6 });
    const decayOne = { upserts: [], decay: ['deploy_target'] };
    harness.agent.harnessRecordSleepTimeAnswer('a-decay', decayOne);
    harness.agent.declareTurnCheckpoint('u-decay');

    harness.db.exec(`CREATE TRIGGER probe_block_sleep_tombstone
      BEFORE INSERT ON effect_tombstones WHEN NEW.scope = 'sleep_time'
      BEGIN SELECT RAISE(ABORT, 'the tombstone write failed'); END`);

    await harness.agent.onChatResponse(settledResponse('a-decay'));
    await joinHarnessFibers();

    // UNCHANGED. The decay rolled back with the tombstone, so nothing is left for
    // the retry to repeat.
    expect(harness.agent.harnessFacts().recall('deploy_target')?.confidence).toBe(0.6);
    // And the row is still owed, which is what brings the retry at all.
    expect(harness.agent.harnessTerminalEffects('u-decay', 'a-decay')
      .find((row) => row.effect_key === 'v1:sleep_time:a-decay')?.status).toBe('pending');

    harness.db.exec('DROP TRIGGER probe_block_sleep_tombstone');
    const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
      sleepTimeAnswer: ['a-decay', decayOne],
    });
    await restarted.agent._kinuTerminalRetryTick();

    // ONE decay for one decision, and the sequence closes. Approximate because
    // the decay is float subtraction; a second one would land near 0.2.
    expect(restarted.agent.harnessFacts().recall('deploy_target')?.confidence)
      .toBeCloseTo(0.4, 10);
    expect(restarted.agent.harnessTerminalEffects('u-decay', 'a-decay')).toEqual([]);
  });

  /**
   * The other half of the same instant: a KEYED effect cut after its side effect
   * is re-run, because re-running it cannot double.
   */
  test('a keyed effect cut after its side effect is replayed and the sequence closes', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-takes');
    harness.agent.harnessArmTerminalFault('takes', 'after');

    await expect(harness.agent.onChatResponse(settledResponse('a-takes'))).rejects.toThrow();
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

  /** The gate, stated on its own: one owed effect keeps the whole transition
   *  open. Without it the marker would say "finished" over work nobody did. */
  test('the outer transition does not settle while any effect is still owed', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-owed-gate');
    harness.agent.harnessArmTerminalFault('auto_gepa', 'before');

    await harness.agent.onChatResponse(settledResponse('a-owed-gate'));
    await harness.agent.harnessTerminalReported();

    // Named, not an exact set: the detached effects are started in one tick, so
    // the injected rejection of one of them arrives before its siblings have
    // finished recording. What the gate claims is about THIS row.
    expect(harness.agent.harnessTerminalEffects('u-owed-gate', 'a-owed-gate')
      .some((row) => row.effect_key === 'v1:auto_gepa:a-owed-gate' && row.status === 'pending'))
      .toBe(true);
    expect(harness.agent.harnessBeginTerminalTransition('u-owed-gate', 'a-owed-gate')).toBe('resumed');
  });

  /**
   * The review obligation, at both instants.
   *
   * `turn_record` writes the window row AND the review it owes. Those used to be
   * two writes with a dispatch between them, so a cut after the insert lost the
   * review while a replay ran it twice. One insert now carries both, so the
   * oracle is the row's own review state: exactly one queued review, whichever
   * side of the effect the interruption landed on.
   */
  test('a cut around the turn recording leaves exactly one owed review', async () => {
    const before = orchestratorHarness();
    before.agent.declareTurnCheckpoint('u-rev-b');
    before.agent.harnessArmTerminalFault('turn_record', 'before');
    await expect(before.agent.onChatResponse(settledResponse('a-rev-b'))).rejects.toThrow();
    expect(owedReviews(before)).toBe(0);
    const revived = await reactivateOrchestratorHarness(before.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
    });
    await revived.agent._kinuTerminalRetryTick();
    expect(owedReviews(before)).toBe(1);

    const after = orchestratorHarness();
    after.agent.declareTurnCheckpoint('u-rev-a');
    after.agent.harnessArmTerminalFault('turn_record', 'after');
    await expect(after.agent.onChatResponse(settledResponse('a-rev-a'))).rejects.toThrow();
    expect(owedReviews(after)).toBe(1);
    await reactivateOrchestratorHarness(after.db, undefined, {
      clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
    });
    // Replayed, and still ONE: the insert is idempotent on the turn's own id, so
    // the obligation cannot be written a second time.
    expect(owedReviews(after)).toBe(1);
    expect(windowedTurns(after)).toBe(1);
  });

  /**
   * A branch gets its OWN row, so a replay cannot redo a branch that settled.
   *
   * One row for the whole list meant the second branch's retry re-settled the
   * first and wrote a second take set. The oracle is the row set itself: one
   * `branches` row per branch id, keyed and independently disposable.
   */
  test('each steer branch is claimed under its own key', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-branch');
    harness.agent.harnessDeclarePendingBranch('branch-a', 'try the other library');
    harness.agent.harnessDeclarePendingBranch('branch-b', 'try the other algorithm');
    harness.agent.harnessArmTerminalFault('takes', 'before');

    await expect(harness.agent.onChatResponse(settledResponse('a-branch'))).rejects.toThrow();

    expect(harness.agent.harnessTerminalEffects('u-branch', 'a-branch')
      .map((row) => row.effect_key)
      .filter((key) => key.startsWith('v1:branches:')))
      .toEqual(['v1:branches:branch-a', 'v1:branches:branch-b']);
  });

  /**
   * The PRODUCTION side effects, counted across a crash at both instants.
   *
   * The earlier oracles counted obligations and ledger rows, which pass over the
   * failure this design exists to prevent: an effect whose row was interrupted
   * after its write, replayed, and written a second time. These count the
   * append-only tables the effects actually touch, so a duplicate is visible as a
   * number.
   */
  test('a cut on either side of the recording leaves exactly one of every append', async () => {
    for (const phase of ['before', 'after'] as const) {
      const harness = orchestratorHarness();
      harness.agent.declareTurnCheckpoint(`u-sfx-${phase}`);
      harness.agent.harnessArmTerminalFault('turn_record', phase);

      await expect(harness.agent.onChatResponse(settledResponse(`a-sfx-${phase}`))).rejects.toThrow();
      // Replayed twice: the second pass is the one that would double anything the
      // first left un-tombstoned.
      for (let pass = 0; pass < 2; pass++) {
        const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
          clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS * (pass + 1),
        });
        await restarted.agent.harnessResumeTerminalTransitions();
      }

      // ONE window row and ONE owed review, whichever side of the write the
      // interruption landed on. The keyed append plus its tombstone is what makes
      // the `after` case one rather than two, and the replay is what makes the
      // `before` case one rather than zero.
      expect(windowedTurns(harness)).toBe(1);
      expect(owedReviews(harness)).toBe(1);
    }
  });

  /**
   * The take set, at the instant that used to double it.
   *
   * A branch reaches `completed` in the journal when its report lands, which is
   * BEFORE the comparison writes its take set — so a replay that keyed only on
   * head status wrote a second set. The settlement key is what closes it, and the
   * oracle is the table the sets live in.
   */
  test('a branch settled twice writes one take set', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-take');
    await harness.agent.harnessRecordBranchReport('branch-x', 'try the other library', 'the branch answer');
    harness.agent.harnessDeclarePendingBranch('branch-x', 'try the other library');
    // Cut BEFORE the branch effect runs, so its row is claimed and owed. Then the
    // live handles are gone, which is exactly what an eviction leaves: the journal
    // is the only record, and the replay settles from it.
    harness.agent.harnessArmTerminalFault('branches', 'before');
    await harness.agent.onChatResponse(settledResponse('a-take', 'the live answer'));
    await harness.agent.harnessTerminalReported();
    harness.agent.harnessDropPendingBranches();
    expect(takeSets(harness)).toBe(0);

    for (let pass = 0; pass < 3; pass++) {
      const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
        clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS * (pass + 1),
      });
      await restarted.agent.harnessResumeTerminalTransitions();
    }

    // The first replay writes the set; the two after it write nothing, because the
    // settlement key names the comparison rather than the row that held it.
    expect(takeSets(harness)).toBe(1);
  });

  /**
   * The LIVE settlement, at the same instant.
   *
   * The oracle above cuts before the body, so the branch only ever settles from
   * the journal. This one lets the live handle settle — the path that writes
   * through `settlePendingBranch` — and then interrupts before the row reaches a
   * disposition. Recovery finds the journal head completed and settles it again,
   * so a live write that did not carry the settlement key is a second take set.
   */
  test('a branch settled LIVE and then replayed writes one take set', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-live-take');
    await harness.agent.harnessRecordBranchReport('branch-l', 'try the other library', 'the branch answer');
    harness.agent.harnessDeclareLiveBranch('branch-l', 'try the other library', 'the branch answer');
    // AFTER the body: the live comparison has run and written its set, and the
    // row is interrupted before it can record that it did.
    harness.agent.harnessArmTerminalFault('branches', 'after');

    await harness.agent.onChatResponse(settledResponse('a-live-take', 'the live answer'));
    await harness.agent.harnessTerminalReported();
    // The live pass wrote it, which is what makes the count below a duplicate
    // test rather than a replay test.
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
   * The SAME eviction, over a branch whose head FAILED.
   *
   * A failed branch has no answer to compare, so it writes no take set — which is
   * why the take table cannot tell a settled refusal from a dropped one, and why
   * this reads what the settlement TOLD the workspace instead. The replay used to
   * look the head up under the RUN's id, find nothing (a branch's head is
   * journalled under a derived id), and report `completed` with "the journal holds
   * no such branch head": the row was pruned, nothing was said, and the only
   * record of why the user's redirect produced no take was gone.
   *
   * `errored` is not a hypothetical here: it is what `reconcileOrphanedBranches`
   * stamps onto every reportless branch head at the START of the very activation
   * that then replays this row, so it is the status a cold settle meets most.
   */
  test('a branch whose head failed settles as a stated refusal, not silence', async () => {
    for (const [branchId, status, message] of [
      ['branch-e', 'errored', 'workspace restarted before the branch settled'],
      ['branch-q', 'budget_exceeded', 'the branch ran out of wall clock'],
    ] as const) {
      const harness = orchestratorHarness();
      harness.agent.declareTurnCheckpoint(`u-${branchId}`);
      await harness.agent.harnessSpawnBranchHead(branchId, 'try the other library', {
        status, summary: '', errorMessage: message,
      });
      harness.agent.harnessDeclarePendingBranch(branchId, 'try the other library');
      harness.agent.harnessArmTerminalFault('branches', 'before');
      await harness.agent.onChatResponse(settledResponse(`a-${branchId}`, 'the live answer'));
      await harness.agent.harnessTerminalReported();
      harness.agent.harnessDropPendingBranches();

      const restarted = await reactivateOrchestratorHarness(harness.db, undefined, {
        clockSkewMs: TERMINAL_EFFECT_RETRY_CEILING_MS,
      });
      await restarted.agent.harnessResumeTerminalTransitions();

      // The head's OWN cause, under the branch the user started. The status
      // reaches it through `settleBranchIntoTakes`, which prefers the recorded
      // message and falls back to naming the status — the fallback the earlier
      // body could only ever have spelled `errored`.
      expect(branchSettlements(harness)).toEqual([`error: ${message}`]);
      // No answer, so no comparison — and the row is discharged rather than owed.
      expect(takeSets(harness)).toBe(0);
      expect(owedBranchEffects(restarted, `u-${branchId}`, `a-${branchId}`)).toEqual([]);
    }
  });

  /**
   * The two states that are still OWED, and nothing else.
   *
   * A head reaches `completed` when its report lands, which is before any take set
   * exists — so the effect cannot key on "not running". What it may key on is the
   * two statuses under which a head is still executing, and this holds the replay
   * to exactly those: a spawned head with no report keeps the row, an `interrupted`
   * one keeps it too, and the pass after the report lands settles it.
   *
   * Replayed on THIS activation rather than across a restart, because a restart is
   * the case where neither status survives: `reconcileOrphanedBranches` seals every
   * reportless branch head `errored` before any row is resumed, which is what makes
   * the failed-head case above the cold one and this one the live one.
   */
  test('a branch head still executing keeps the row owed until it reports', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-owed');
    // Spawned, no report: `running`, exactly as an in-flight head is journalled.
    await harness.agent.harnessSpawnBranchHead('branch-o', 'try the other library', null);
    harness.agent.harnessDeclarePendingBranch('branch-o', 'try the other library');
    harness.agent.harnessArmTerminalFault('branches', 'before');
    await harness.agent.onChatResponse(settledResponse('a-owed', 'the live answer'));
    await harness.agent.harnessTerminalReported();
    // No live handle left, so the replay has only the journal to read.
    harness.agent.harnessDropPendingBranches();
    harness.agent.harnessDisarmTerminalFault();

    for (const unsettled of ['running', 'interrupted'] as const) {
      // The second pass runs over the OTHER unsettled status, written by the
      // journal's own cold-activation transition.
      if (unsettled === 'interrupted') harness.agent.harnessMarkHeadsInterrupted();
      harness.agent.harnessAdvanceTerminalClock(TERMINAL_EFFECT_RETRY_CEILING_MS);
      await harness.agent.harnessResumeTerminalTransitions();
      expect(harness.agent.harnessBranchHeadStatus('branch-o')).toBe(unsettled);
      expect(takeSets(harness)).toBe(0);
      expect(owedBranchEffects(harness, 'u-owed', 'a-owed')).toEqual(['v1:branches:branch-o']);
    }

    // The report lands. The kept row is what makes this settle at all.
    harness.agent.harnessReportBranchHead('branch-o', 'the branch answer');
    harness.agent.harnessAdvanceTerminalClock(TERMINAL_EFFECT_RETRY_CEILING_MS);
    await harness.agent.harnessResumeTerminalTransitions();
    expect(takeSets(harness)).toBe(1);
    expect(owedBranchEffects(harness, 'u-owed', 'a-owed')).toEqual([]);
  });

  /**
   * The REVIEW, executed across the interruption.
   *
   * Counting window rows says the recording did not double; it says nothing
   * about the review that recording owes, which is where the model calls and the
   * append-only writes are. This drains the queued review on each pass and counts
   * the tables it appends to.
   */
  test('a review re-run after a refusal grades the turn once', async () => {
    const harness = orchestratorHarness();
    const turn: CompletedTurn = {
      userMessage: 'use the streaming API', assistantResponse: 'here is a batch call',
      toolCalls: [], durationMs: 1, steps: 1, hadError: false, feedback: null,
      turnId: 'u-review', sessionId: 'default', origin: 'user',
    };

    // Twice, and on a fresh activation the second time: the retry a refused
    // review gets, over storage that already holds the first pass's writes.
    await harness.agent.harnessReviewTurn(turn, 'no, that is the batch API again');
    expect(rowCount(harness, 'turn_outcomes')).toBe(1);
    expect(rowCount(harness, 'lessons')).toBe(1);

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.harnessReviewTurn(turn, 'no, that is the batch API again');

    // ONE verdict, ONE reflection. The grading tombstone is what keeps the
    // outcome row at one; the review-step tombstone is what keeps the lesson at
    // one when the retry re-reaches the reflection call behind it.
    expect(rowCount(harness, 'turn_outcomes')).toBe(1);
    expect(rowCount(harness, 'lessons')).toBe(1);
  });

  /**
   * The lanes that must NOT be replayed.
   *
   * The scaffold and prompt-section passes drive candidates through the live
   * tool surface, so a pass the platform cut may already have written files or
   * cut a release. Replaying it from the top repeats those — the same loss this
   * ledger exists to prevent, arriving from the other side. So a cut pass is
   * abandoned to the next cadence tick, and the tick converges either way.
   */
  test('a cut optimisation pass is abandoned, not re-run', async () => {
    const harness = orchestratorHarness();
    let runs = 0;

    // Interrupted: the attempt is on record, the completion is not.
    await expect(harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      runs++;
      await Promise.reject(new Error('the isolate went away mid-rollout'));
    })).rejects.toThrow();
    expect(runs).toBe(1);

    // The replay finds the attempt and converges the tick without repeating it.
    await harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      runs++;
      await Promise.resolve();
    });
    expect(runs).toBe(1);

    // And it stays converged, rather than re-opening on the pass after that.
    await harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      runs++;
      await Promise.resolve();
    });
    expect(runs).toBe(1);

    // A NEW tick is a new obligation — the work is delayed, never dropped.
    await harness.agent.harnessOncePerTick('probe_lane', 'tick-2', async () => {
      runs++;
      await Promise.resolve();
    });
    expect(runs).toBe(2);
  });

  /**
   * The other half of that trade, which the abandonment used to lose outright.
   *
   * The marker was written BEFORE the pass was called, so a cut in between
   * abandoned a tick whose pass had not run a single statement — an idle
   * workspace simply never ran the cadence work that tick owed, and no future
   * turn is a recovery carrier for it. The marker now says ENTERED: it is written
   * in the same synchronous slice as the call, so the pass's own opening writes
   * and it reach storage together.
   */
  test('the tick marker says entered, not armed', async () => {
    const harness = orchestratorHarness();
    let markersWhenPassStarted = -1;

    await harness.agent.harnessOncePerTick('probe_lane', 'tick-1', async () => {
      markersWhenPassStarted = tickMarkers(harness, 'probe_lane');
      await Promise.resolve();
    });

    // Nothing was on record when the pass began, so a cut before this instant
    // leaves the tick owed rather than abandoned.
    expect(markersWhenPassStarted).toBe(0);
    // Entry and completion are both recorded once it has run.
    expect(tickMarkers(harness, 'probe_lane')).toBe(2);
  });

  /**
   * What a turn the promotion gate cannot learn from OWES.
   *
   * The shadow trial is its own effect now, declared outside the improvement
   * lanes, so the advisor-lane gate oracles say nothing about it. A trial runs
   * the candidate scaffold through the LIVE tool surface, so an aborted, errored
   * or Plan turn declaring one both contaminates the evidence and spends that
   * surface on a turn that earned nothing.
   */
  test('only a completed build turn declares a shadow trial', async () => {
    const sampled = (harness: ActorHarness<HarnessOrchestratorAgent>): string => {
      for (let i = 0; i < 500; i++) {
        if (harness.agent.harnessShadowPlan(`a-shadow-${i}`) !== null) return `a-shadow-${i}`;
      }
      throw new Error('no sampling id found');
    };
    // The QUEUE, not the ledger row: a completed effect is pruned once its
    // sequence closes, and what the gate is about is whether the candidate got
    // scored against this turn at all.
    const queued = (harness: ActorHarness<HarnessOrchestratorAgent>): number =>
      rowCount(harness, 'scaffold_trial_queue');

    // The completed build turn: the trial IS owed, which is what makes the three
    // refusals below a gate rather than a broken declaration.
    const open = orchestratorHarness();
    open.agent.harnessDeclareShadowCandidate();
    const openId = sampled(open);
    open.agent.declareTurnCheckpoint('u-shadow-ok');
    await open.agent.onChatResponse(settledResponse(openId));
    await open.agent.harnessTerminalReported();
    expect(queued(open)).toBe(1);

    for (const shut of ['error', 'aborted', 'plan'] as const) {
      const harness = orchestratorHarness();
      harness.agent.harnessDeclareShadowCandidate();
      const messageId = sampled(harness);
      harness.agent.declareTurnCheckpoint(`u-shadow-${shut}`);
      // The mode comes off the driving user message, which is where production
      // reads it — stubbing the orchestrator's live turn instead would assert
      // against a path `onChatResponse` never consults.
      if (shut === 'plan') harness.agent.harnessDrivingUserMessage('plan it', { kinuMode: 'plan' });
      const response = settledResponse(messageId);
      await harness.agent.onChatResponse(
        shut === 'plan' ? response : { ...response, status: shut === 'error' ? 'error' : 'aborted' },
      );
      await harness.agent.harnessTerminalReported();
      expect(queued(harness)).toBe(0);
    }
  });

  /**
   * The sampling decision, asked twice.
   *
   * A duplicate callback rebuilds the whole declaration before the ledger
   * recognises it, so a rolled coin would claim a different set of rows than the
   * sequence already on record — a `shadow_trial` row that the first attempt
   * never owed, or the loss of one it did.
   */
  test('one turn always makes the same sampling decision', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessDeclareShadowCandidate();

    const first = harness.agent.harnessShadowPlan('a-sample');
    for (let ask = 0; ask < 50; ask++) {
      expect(harness.agent.harnessShadowPlan('a-sample')).toEqual(first);
    }
    // And it is a decision, not a constant: across ids both answers occur.
    const spread = new Set(
      Array.from({ length: 200 }, (_, i) => harness.agent.harnessShadowPlan(`a-${i}`) !== null),
    );
    expect(spread).toEqual(new Set([true, false]));
  });

  /**
   * The wake a LIVE sequence still gets.
   *
   * A sequence this activation is running is skipped by the sweep — its rows are
   * pending because a model lane has not answered, not because they need
   * re-driving — and waking on their overdue instant re-armed one second later,
   * every second, for the whole call. Excluding them outright was the other
   * failure: the activation can die at any moment, and the SDK deletes the
   * one-shot row that fired, so the sequence would be left with no carrier at all.
   * DEFERRED is the answer, and the deferral is what this pins.
   */
  test('a live sequence keeps a wake, pushed past the busy window', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-live-wake');
    harness.agent.harnessArmTerminalFault('turn_record', 'before');
    await expect(harness.agent.onChatResponse(settledResponse('a-live-wake'))).rejects.toThrow();

    const owedAt = harness.agent.harnessNextRetryAt(new Set());
    expect(owedAt).not.toBeNull();

    // The same roster, read while this activation owns the sequence.
    const live = new Set([harness.agent.harnessSequenceId('u-live-wake', 'a-live-wake')]);
    const deferredAt = harness.agent.harnessNextRetryAt(live);
    expect(deferredAt).not.toBeNull();
    // Not dropped, and not the overdue instant that would re-arm on every tick.
    expect(deferredAt!).toBeGreaterThan(owedAt!);
    expect(deferredAt!).toBeGreaterThanOrEqual(Date.now() + TERMINAL_EFFECT_RETRY_CEILING_MS - 1_000);
  });

  /**
   * NO ABANDONMENT. An effect nothing can finish yet stays owed, however many
   * activations have tried it.
   *
   * The earlier design turned the third attempt into a recorded refusal and then
   * treated the sequence as settled, so a parent RPC or a model service that was
   * unavailable across three activations was abandoned permanently. A fixed
   * activation count must never convert owed work into success: convergence is
   * the backoff plus the durable wake, and a row nobody can finish keeps the
   * transition open and visible instead.
   */
  test('an effect no activation can finish stays owed rather than being abandoned', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-stuck');
    harness.agent.harnessArmTerminalFault('auto_gepa', 'before');

    await harness.agent.onChatResponse(settledResponse('a-stuck'));
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
    // Still owed, so the outer transition is still open and the next activation
    // is still handed the suffix.
    expect(harness.agent.harnessBeginTerminalTransition('u-stuck', 'a-stuck')).toBe('resumed');
  });

  /**
   * A row this build cannot interpret — written by a build whose effect set was
   * different. It must be REFUSED by name: guessing at its input would be worse,
   * and dropping it would leave the outer transition closed over work nobody
   * ever looked at.
   */
  test('an effect this build does not implement is blocked by name, never skipped', async () => {
    const harness = orchestratorHarness();
    expect(harness.agent.harnessBeginTerminalTransition('u-alien', 'a-alien')).toBe('first');
    harness.db.prepare(
      `INSERT INTO terminal_effects
         (sequence_id, effect_key, effect_name, scope, seq, input_json, status, outcome, attempts, claimed_at, settled_at)
       VALUES ('u-alien/a-alien', 'v9:teleport:a-alien', 'teleport', 'a-alien', 0, '{}', 'pending', NULL, 0, 1, NULL)`,
    ).run();

    await harness.agent.harnessResumeTerminalTransitions();

    const rows = harness.agent.harnessTerminalEffects('u-alien', 'a-alien');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.effect_key).toBe('v9:teleport:a-alien');
    expect(rows[0]?.status).toBe('blocked');
    expect(rows[0]?.outcome).toContain('teleport');
    // BLOCKED still gates: a row this build cannot interpret is a deploy-shape
    // problem a human resolves, so it keeps the transition open and visible
    // rather than converging to a success nobody earned.
    expect(harness.agent.harnessBeginTerminalTransition('u-alien', 'a-alien')).toBe('resumed');
  });
});

/**
 * When a turn's tool claims may be dropped.
 *
 * The close releases them once its turn can no longer act, and a turn is not
 * over when its last SETTLED response is: Think fires the hook once per
 * response and an auto-continuation runs under the same durable turn id, so a
 * continuation can already be executing a claimed tool with no terminal claim
 * of its own yet. Releasing there hands the next interruption a free replay of
 * an external effect.
 *
 * The witness cannot be `_inFlight`, and that is what these cases force: after
 * an eviction a fresh actor has it clear while the interrupted continuation is
 * still owed a replay. The chat-turn fiber row is what survives the isolate, so
 * it is what is seeded here.
 */
describe('a turn releases its tool claims only when no response can still run', () => {
  /**
   * The row Think leaves for one response of a turn.
   *
   * Composed by the SDK's OWN builders rather than by a literal here: the
   * snapshot's field names are the framework's, and a hand-written fixture
   * would keep passing after a version renamed the one field the production
   * read depends on. The row's NAME is decoration — the read matches on the
   * snapshot — and is spelled as Think spells it so the fixture reads true.
   */
  function chatTurnFiber(
    harness: ActorHarness<HarnessOrchestratorAgent>, requestId: string, turnId: string,
  ): void {
    const snapshot = createChatFiberSnapshot({
      kind: 'think-chat-turn',
      requestId,
      recoveryRootRequestId: requestId,
      continuation: true,
      messages: [{ id: turnId, role: 'user' }],
    });
    harness.agent.harnessSeedOrphanFiber(
      `__cf_internal_chat_turn:${requestId}`,
      projectJsonValue({ value: wrapChatFiberSnapshot(CHAT_TURN_SNAPSHOT_KEY, snapshot, null) }),
    );
  }

  test('a settled response with nothing else running releases them', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-done');
    harness.agent.harnessClaimTool('u-done', 'call_send_1');

    await settleResponse(harness, 'a-done');

    expect(harness.agent.harnessToolClaims('u-done')).toEqual([]);
  });

  /**
   * The response being closed owns a chat fiber row of its own, and the close
   * can reach the release before Think's fiber returns and deletes it. Read as
   * "somebody else may still run", every ordinary turn would keep its claims
   * for good — so the settling response is excluded by request id.
   */
  test('the settling response is not mistaken for another one still running', async () => {
    const harness = orchestratorHarness();
    harness.agent.declareTurnCheckpoint('u-self');
    harness.agent.harnessClaimTool('u-self', 'call_send_1');
    chatTurnFiber(harness, 'req-a-self', 'u-self');

    await settleResponse(harness, 'a-self');

    expect(harness.agent.harnessToolClaims('u-self')).toEqual([]);
  });

  /**
   * The defect. The isolate died while an auto-continuation was executing a
   * claimed tool, so the fresh activation resuming the EARLIER response has
   * `_inFlight` clear while `active_durable_turn` still names the turn. Its
   * close used to delete the continuation's claim, and chat recovery then
   * replayed the continuation with nothing left to refuse the second call.
   */
  test('cold recovery keeps the claims of a continuation it has not replayed yet', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessPersistActiveTurn('u-cont');
    harness.agent.harnessClaimTool('u-cont', 'call_send_1');
    // The earlier response: claimed, interrupted, and now being recovered.
    expect(harness.agent.harnessBeginTerminalTransition('u-cont', 'a-first')).toBe('first');
    chatTurnFiber(harness, 'req-a-cont', 'u-cont');

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.harnessResumeTerminalTransitions();

    // The recovered response is closed — and the continuation's guard is intact.
    expect(restarted.agent.harnessBeginTerminalTransition('u-cont', 'a-first')).toBe('done');
    expect(restarted.agent.harnessToolClaims('u-cont')).toEqual(['call_send_1']);
  });

  /** The negative control: no response of the turn survived the isolate, so
   *  nothing can replay under it and the claims are the close's to drop. */
  test('cold recovery releases them when no response survived the isolate', async () => {
    const harness = orchestratorHarness();
    harness.agent.harnessPersistActiveTurn('u-gone');
    harness.agent.harnessClaimTool('u-gone', 'call_send_1');
    expect(harness.agent.harnessBeginTerminalTransition('u-gone', 'a-first')).toBe('first');
    chatTurnFiber(harness, 'req-other-turn', 'u-other');

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.harnessResumeTerminalTransitions();

    expect(restarted.agent.harnessToolClaims('u-gone')).toEqual([]);
  });
});
