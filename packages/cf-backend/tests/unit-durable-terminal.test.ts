/**
 * Defends: the terminal sequence dropped its effect claims before running, so an interrupted
 * prefix read as a completed turn. Cases force a prefix; recovery is unit-durable-terminal-recovery.test.ts.
 *
 * An isolate reset is built into the activation that suffers it (`world.cut`); the recovery is a fresh
 * activation over the same rows, time passes on the platform clock, and what each case reads is the
 * object's stored rows. Core's own ledger semantics are pinned in core's unit-terminal-transition-*.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import {
  CHAT_SESSION_ID, PROGRAMMATIC_MESSAGE_ID_PREFIX, RunEventRecorder,
  TERMINAL_EFFECT_RETRY_CEILING_MS, claimToolEffect, createFactsStore, openTurnRun,
  type TerminalEffectName, type TerminalEffectPhase,
} from '@kinu.run/core';
import { createRecordingLogger } from '@kinu.run/core/obs';
import { sqlOver } from '@kinu.run/test-utils';
import {
  admittedTurnClaim, chatSessionTurns, historyOver, ledgerOver, orchestratorHarness,
  reactivateOrchestratorHarness,
  tapDiagnostics, until, workspaceMainActor, type ActorHarness, type HarnessActorWorld, type HarnessOrchestratorAgent,
  type ScriptedHeadReport,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import type { TurnHarness } from './helpers/turn-harness';

type Harness = ActorHarness<HarnessOrchestratorAgent>;

afterEach(() => { setSystemTime(); });

function turns(harness: Harness): TurnHarness {
  return chatSessionTurns(harness.agent);
}

/** An activation whose isolate stops once at `name`, before or after its side effect. */
function cutAt(name: TerminalEffectName, phase: TerminalEffectPhase, world: HarnessActorWorld = {}): Harness {
  return orchestratorHarness(undefined, { ...world, cut: [name, phase] });
}

/** Past every backoff the ledger could have armed, on the platform's clock. */
function laterBy(passes: number): void {
  setSystemTime(new Date(Date.now() + TERMINAL_EFFECT_RETRY_CEILING_MS * passes));
}

/** A fresh activation over the same rows, after its wake came due, running the alarm's pass. */
async function recover(harness: Harness, world?: HarnessActorWorld): Promise<Harness> {
  laterBy(1);
  const restarted = await reactivateOrchestratorHarness(harness.db, undefined, world === undefined ? undefined : { world });
  await restarted.agent.terminalRetryPass();
  // A replayed detached effect closes in its own fiber, not inside the wake's job.
  await joinHarnessFibers();

  return restarted;
}

const OVERFLOW_ERROR = 'prompt is too long: 210000 tokens > 200000 maximum';

interface EffectRow {
  readonly effect_key: string;
  readonly status: string;
  readonly attempts: number;
}

/** Every per-effect disposition row of one sequence, in declared order, as stored. */
function effects(harness: Harness, turnId: string, messageId = 'a-1'): EffectRow[] {
  return harness.db.query<EffectRow, [string, string]>(
    `SELECT effect_key, status, attempts FROM terminal_effects
     WHERE actor_id = ? AND sequence_id = ? ORDER BY seq, effect_key`,
  ).all(workspaceMainActor(harness.db).actorId, ledgerOver(harness.db).sequenceId({ turnId, messageId }));
}

/** One turn's tool claims by call id. */
function toolClaims(harness: Harness, turnId: string): string[] {
  return harness.db.query<{ call_id: string }, [string]>(
    `SELECT normalized_call_id AS call_id FROM tool_effect_claims
     WHERE turn_id = ? AND normalized_call_id NOT LIKE 'terminal:response:%' ORDER BY normalized_call_id`,
  ).all(turnId).map((row) => row.call_id);
}

/** `done` once the object closed the sequence; a still-open one answers `resumed`. */
function disposition(harness: Harness, turnId: string, messageId: string): string {
  return ledgerOver(harness.db).begin({ turnId, messageId });
}

/** Owed reviews, written in the same insert as the turn: lost reads 0, doubled reads 2. */
function owedReviews(harness: Harness): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query(
      "SELECT COUNT(*) AS n FROM completed_turns WHERE review IN ('awaiting_followup','queued')",
    ).get(),
  ).n;
}

/** Take sets are append-only, so a replayed comparison is a second row. */
function takeSets(harness: Harness): number {
  return rowCount(harness, 'alternate_takes');
}

/** Durable branch-settle log: the only record of a settlement that writes no take set. */
function branchSettlements(harness: Harness): string[] {
  return v.parse(
    v.array(v.object({ detail: v.string() })),
    harness.db.query(
      "SELECT detail FROM activity_log WHERE event = 'branch_settle' ORDER BY created_at, rowid",
    ).all(),
  ).map((row) => row.detail);
}

/** Unsettled branch effect keys; empty means every branch row reached a disposition. */
function owedBranchEffects(harness: Harness, turnId: string, messageId: string): string[] {
  return effects(harness, turnId, messageId)
    .filter((row) => row.effect_key.startsWith('v1:branches:') && row.status !== 'completed')
    .map((row) => row.effect_key);
}

function rowCount(harness: Harness, table: string): number {
  return v.parse(
    v.object({ n: v.number() }),
    harness.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
  ).n;
}

function windowedTurns(harness: Harness): number {
  return rowCount(harness, 'completed_turns');
}

/** Settle one response and wait until its sequence is closed in storage. */
async function settleResponse(harness: Harness, turnId: string, messageId: string, text = 'the answer'): Promise<void> {
  await turns(harness).settle({ messageId, text });
  await until(() => disposition(harness, turnId, messageId) === 'done', `the sequence of ${messageId} closed`);
}

/** A steer branch launched while `turnId` runs toward answer `messageId`, through the public redirect;
 *  answers the branch's id. */
async function branchDuring(harness: Harness, turnId: string, messageId: string, task: string): Promise<string> {
  await turns(harness).openInFlight(turnId, messageId);
  const branch = await harness.agent.branchTurn(task);

  if (!branch.accepted) throw new Error(`the branch was refused: ${branch.reason}`);

  return branch.branchId;
}

/** A head platform where every branch head answers `report`. */
function headsAnswering(report: ScriptedHeadReport): HarnessActorWorld['heads'] {
  return async () => report;
}

describe('an owed follow-up turn is a durable terminal effect', () => {
  test('a rolled-back owed-turn effect reuses the follow-up still queued in RAM', async () => {
    const harness = cutAt('overflow_retry', 'after');
    await turns(harness).openInFlight('u-queue-cut');
    let replay: Promise<void> | null = null;

    const restore = tapDiagnostics({
      event: () => {},
      failure: (event) => {
        if (event === 'turn.finalization_failed' && replay === null) replay = harness.agent.terminalRetryPass();
      },
    });

    try {
      await expect(turns(harness).settle({ messageId: 'a-queue-cut', status: 'error', error: OVERFLOW_ERROR }))
        .rejects.toThrow(/terminal effect overflow_retry:/u);

      if (replay === null) throw new Error('the cut did not start the public recovery pass');
      await replay;

      const retry = sqlOver(harness.db)<{ scope: string }>`SELECT scope FROM terminal_effects
        WHERE effect_name = 'overflow_retry'`[0];

      if (retry === undefined) throw new Error('the queued retry lost its owed row');
      const transcript = historyOver(harness).transcript(CHAT_SESSION_ID);
      expect(transcript.has(`${PROGRAMMATIC_MESSAGE_ID_PREFIX}overflow-retry:${retry.scope}`)).toBe(true);
      expect((await harness.agent.listRuns()).items).toHaveLength(2);
    } finally {
      restore();
    }
  });
});

/**
 * Each case cuts the sequence at an effect (`before`: owed, replay; `after`: indeterminate, keyed
 * effects replay) and recovers on a fresh activation; only the cut shows a repeat or a drop.
 */
describe('an interrupted terminal sequence replays its suffix and repeats nothing', () => {

  /**
   * The fact upserts, cumulative decays, and tombstone commit as one unit; a separate tombstone
   * let a replay decay twice (0.4 for one turn). The lane's cadence is due on the third turn.
   */
  test('a fact update whose tombstone fails leaves no half-applied prefix', async () => {
    const harness = orchestratorHarness();
    const facts = () => createFactsStore(sqlOver(harness.db), workspaceMainActor(harness.db));
    facts().upsert('deploy_target', 'staging', { confidence: 0.6 });
    turns(harness).open('u-one');
    await turns(harness).settle({ messageId: 'a-one' });
    turns(harness).open('u-two');
    await turns(harness).settle({ messageId: 'a-two' });
    const decayOne = { upserts: [], decay: ['deploy_target'] };
    // The answer a first attempt persisted, with the lane on: the state the replay reads.
    workspaceMainActor(harness.db).config.setSleepTimeComputeEnabled(true);
    harness.db.prepare('INSERT INTO sleep_time_updates (effect_key, update_json) VALUES (?, ?)')
      .run('a-decay', JSON.stringify(decayOne));
    turns(harness).open('u-decay');

    harness.db.exec(`CREATE TRIGGER probe_block_sleep_tombstone
      BEFORE INSERT ON effect_tombstones WHEN NEW.scope = 'sleep_time'
      BEGIN SELECT RAISE(ABORT, 'the tombstone write failed'); END`);

    await turns(harness).settle({ messageId: 'a-decay' });
    await joinHarnessFibers();

    // Unchanged: the decay rolled back with the tombstone.
    expect(facts().recall('deploy_target')?.confidence).toBe(0.6);
    expect(effects(harness, 'u-decay', 'a-decay')
      .find((row) => row.effect_key === 'v1:sleep_time:a-decay')?.status).toBe('pending');

    harness.db.exec('DROP TRIGGER probe_block_sleep_tombstone');
    laterBy(1);
    const restarted = await reactivateOrchestratorHarness(harness.db, undefined, { sleepTimeAnswer: ['a-decay', decayOne] });
    await restarted.agent.terminalRetryPass();
    await joinHarnessFibers();

    // One decay; approximate because it is float subtraction.
    expect(facts().recall('deploy_target')?.confidence).toBeCloseTo(0.4, 10);
    expect(effects(restarted, 'u-decay', 'a-decay')).toEqual([]);
  });

  /** Recording and its review commit with the disposition, or recovery writes them together. */
  test('a cut around the turn recording recovers exactly one owed review', async () => {
    const before = cutAt('turn_record', 'before');
    turns(before).open('u-rev-b');
    await expect(turns(before).settle({ messageId: 'a-rev-b' })).rejects.toThrow('terminal effect turn_record:a-rev-b interrupted before its side effect');
    expect(owedReviews(before)).toBe(0);
    await recover(before);
    expect(owedReviews(before)).toBe(1);

    const after = cutAt('turn_record', 'after');
    turns(after).open('u-rev-a');
    await expect(turns(after).settle({ messageId: 'a-rev-a' })).rejects.toThrow('terminal effect turn_record:a-rev-a interrupted after its side effect');
    expect(owedReviews(after)).toBe(0);
    await recover(after);
    // The insert is idempotent on the turn's own id.
    expect(owedReviews(after)).toBe(1);
    expect(windowedTurns(after)).toBe(1);
  });

  /** One row per branch id, so a replay cannot re-settle a branch that already settled. */
  test('each steer branch is claimed under its own key', async () => {
    // Heads still running: their reports arrive only after the claims are read.
    const reports: Array<ReturnType<typeof Promise.withResolvers<ScriptedHeadReport>>> = [];

    const harness = cutAt('turn_end_extensions', 'before', {
      heads: () => {
        const report = Promise.withResolvers<ScriptedHeadReport>();
        reports.push(report);

        return report.promise;
      },
    });

    const first = await branchDuring(harness, 'u-branch', 'a-branch', 'try the other library');
    const second = await harness.agent.branchTurn('try the other algorithm');

    if (!second.accepted) throw new Error(`the branch was refused: ${second.reason}`);

    await expect(turns(harness).settle({ messageId: 'a-branch' })).rejects.toThrow('terminal effect turn_end_extensions:a-branch interrupted before its side effect');

    expect(effects(harness, 'u-branch', 'a-branch').map((row) => row.effect_key).filter((key) => key.startsWith('v1:branches:')).sort())
      .toEqual([`v1:branches:${first}`, `v1:branches:${second.branchId}`].sort());

    for (const report of reports) report.resolve({ status: 'completed', summary: 'the branch answer' });
  });

  /** Counts the append-only tables the effects touch, so a replayed write shows as a number. */
  test('a cut on either side of the recording leaves exactly one of every append', async () => {
    for (const phase of ['before', 'after'] as const) {
      const harness = cutAt('turn_record', phase);
      turns(harness).open(`u-sfx-${phase}`);

      await expect(turns(harness).settle({ messageId: `a-sfx-${phase}` })).rejects.toThrow(`terminal effect turn_record:a-sfx-${phase} interrupted ${phase} its side effect`);

      // Two recoveries: the second would double anything the first left un-tombstoned.
      await recover(await recover(harness));

      // One row either side: the tombstone keeps `after` at one, the replay keeps `before` at one.
      expect(windowedTurns(harness)).toBe(1);
      expect(owedReviews(harness)).toBe(1);
    }
  });

  /** A branch is `completed` before its take set is written, so only the settlement key prevents a second set. */
  test('a branch settled twice writes one take set', async () => {
    const harness = cutAt('branches', 'before', { heads: headsAnswering({ status: 'completed', summary: 'the branch answer' }) });
    await branchDuring(harness, 'u-take', 'a-take', 'try the other library');
    await turns(harness).settle({ messageId: 'a-take', text: 'the live answer' });
    await joinHarnessFibers();
    expect(takeSets(harness)).toBe(0);

    // Each recovery is a fresh activation: the journal is the only record of the branch.
    await recover(await recover(await recover(harness)));

    // The settlement key names the comparison, not the row, so later replays write nothing.
    expect(takeSets(harness)).toBe(1);
  });

  /** Live settlement must carry the settlement key too, or recovery writes a second set. */
  test('a branch settled LIVE and then replayed writes one take set', async () => {
    const harness = cutAt('branches', 'after', { heads: headsAnswering({ status: 'completed', summary: 'the branch answer' }) });
    await branchDuring(harness, 'u-live-take', 'a-live-take', 'try the other library');

    await turns(harness).settle({ messageId: 'a-live-take', text: 'the live answer' });
    await joinHarnessFibers();
    expect(takeSets(harness)).toBe(1);

    await recover(await recover(harness));

    expect(takeSets(harness)).toBe(1);
  });

  /** A failed head writes no take set, so this reads the settlement log; the replay looks the head up by its derived id. */
  test('a branch whose head failed settles as a stated refusal, not silence', async () => {
    for (const [status, message] of [
      ['errored', 'workspace restarted before the branch settled'],
      ['budget_exceeded', 'the branch ran out of wall clock'],
    ] as const) {
      const harness = cutAt('branches', 'before', { heads: headsAnswering({ status, summary: '', errorMessage: message }) });
      await branchDuring(harness, `u-${status}`, `a-${status}`, 'try the other library');
      await turns(harness).settle({ messageId: `a-${status}`, text: 'the live answer' });
      await joinHarnessFibers();

      const restarted = await recover(harness);

      // The head's own cause, via `settleBranchIntoTakes`.
      expect(branchSettlements(harness)).toEqual([`error: ${message}`]);
      // No answer, so no comparison, and the row is discharged rather than owed.
      expect(takeSets(harness)).toBe(0);
      expect(owedBranchEffects(restarted, `u-${status}`, `a-${status}`)).toEqual([]);
    }
  });

  /** A head still running when its turn's sequence stops keeps the branch row owed; its report discharges it. */
  test('a branch head still executing keeps the row owed until it reports', async () => {
    const report = Promise.withResolvers<ScriptedHeadReport>();
    const harness = cutAt('branches', 'before', { heads: () => report.promise });
    const log = createRecordingLogger();
    const untap = tapDiagnostics(log);

    try {
      const branchId = await branchDuring(harness, 'u-owed', 'a-owed', 'try the other library');
      await turns(harness).settle({ messageId: 'a-owed', text: 'the live answer' });
      await log.until((emitted) => emitted.some((line) => line.event === 'turn.terminal_transition_close_failed'));

      expect(takeSets(harness)).toBe(0);
      expect(owedBranchEffects(harness, 'u-owed', 'a-owed')).toEqual([`v1:branches:${branchId}`]);
      expect(disposition(harness, 'u-owed', 'a-owed')).toBe('resumed');

      report.resolve({ status: 'completed', summary: 'the branch answer' });
      laterBy(1);
      await harness.agent.terminalRetryPass();

      expect(takeSets(harness)).toBe(1);
      expect(owedBranchEffects(harness, 'u-owed', 'a-owed')).toEqual([]);
    } finally {
      untap();
    }
  });

});

/**
 * Auto-continuations share the durable turn id, so claims are released only when no response can run.
 * `_inFlight` is clear after eviction; the surviving run row is the witness seeded here.
 */
// Core's `creditedTurnId` decides; this pins that the orchestrator hands its verdict to the branch settle.
describe('mid-turn captures are credited to the turn only when it answered', () => {
  test('a completed turn credits its branch take set to its answer', async () => {
    const harness = orchestratorHarness(undefined, { heads: headsAnswering({ status: 'completed', summary: 'the branch answer' }) });
    await branchDuring(harness, 'u-credit', 'a-credit', 'try the other library');
    await turns(harness).settle({ messageId: 'a-credit', text: 'the live answer' });
    await joinHarnessFibers();

    expect(harness.db.query('SELECT turn_id FROM alternate_takes').all()).toEqual([{ turn_id: 'a-credit' }]);
  });

  test('a turn that failed credits nothing: its branch is aborted and no take set is written', async () => {
    const harness = orchestratorHarness(undefined, { heads: headsAnswering({ status: 'completed', summary: 'the branch answer' }) });
    await branchDuring(harness, 'u-fail', 'a-fail', 'try the other library');
    await turns(harness).settle({ messageId: 'a-fail', text: 'partial', status: 'error', error: 'the provider hung up' });
    await joinHarnessFibers();

    expect(takeSets(harness)).toBe(0);
    expect(owedBranchEffects(harness, 'u-fail', 'a-fail')).toEqual([]);
  });
});

describe('a turn releases its tool claims only when no response can still run', () => {
  /** A tool call claimed and unsettled: the state a still-executing turn leaves. */
  function claimTool(harness: Harness, turnId: string, callId: string): void {
    claimToolEffect(sqlOver(harness.db), workspaceMainActor(harness.db), { turnId, callId, digest: 'harness-tool-digest' });
  }

  /** An open run the isolate died inside; the restart re-opens it as a continuation. */
  function openRun(harness: Harness, runId: string, turnId: string): void {
    openTurnRun(new RunEventRecorder(sqlOver(harness.db), workspaceMainActor(harness.db)), runId, {
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
    { name: 'the settling response is not mistaken for another one still running', turn: 'u-self', answer: 'a-self' },
  ] as const;

  for (const { name, turn, answer } of released) {
    test(name, async () => {
      const harness = orchestratorHarness();
      turns(harness).open(turn);
      claimTool(harness, turn, 'call_send_1');

      await settleResponse(harness, turn, answer);

      expect(toolClaims(harness, turn)).toEqual([]);
    });
  }

  /** Defends: closing the earlier response must keep a live continuation's tool claim. */
  test('cold recovery keeps the claims of a continuation it has not replayed yet', async () => {
    const harness = orchestratorHarness();
    await admittedTurnClaim(harness, 'u-cont');
    claimTool(harness, 'u-cont', 'call_send_1');
    expect(disposition(harness, 'u-cont', 'a-first')).toBe('first');
    openRun(harness, 'run-a-cont', 'u-cont');

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.terminalRetryPass();

    expect(disposition(restarted, 'u-cont', 'a-first')).toBe('done');
    expect(toolClaims(restarted, 'u-cont')).toEqual(['call_send_1']);
  });

  /** Negative control: no response of the turn survived, so the close drops the claims. */
  test('cold recovery releases them when no response survived the isolate', async () => {
    const harness = orchestratorHarness();
    await admittedTurnClaim(harness, 'u-gone');
    claimTool(harness, 'u-gone', 'call_send_1');
    expect(disposition(harness, 'u-gone', 'a-first')).toBe('first');
    openRun(harness, 'run-other-turn', 'u-other');

    const restarted = await reactivateOrchestratorHarness(harness.db);
    await restarted.agent.terminalRetryPass();

    expect(toolClaims(restarted, 'u-gone')).toEqual([]);
  });
});
