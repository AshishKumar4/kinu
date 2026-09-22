// AgentOrchestrator: evolution cadence and the event→turn reactor.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestActors, createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { AgentOrchestrator, type AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import { RUN_END_REASONS, creditedTurnId } from '../src/orchestrator/turn-lifecycle';
import { declareTerminalRoster } from '../src/orchestrator/terminal-roster';
import { MissionGovernor } from '../src/mission-budget';
import { initCompletedTurnTable, createCompletedTurnStore } from '../src/evolution/session-window';
import { initEventsHubTables, EventLog, type IngressDescriptor } from '../src/events/hub/index';
import type { BackendHost, BroadcastEvent, ProgrammaticTurn } from '../src/types/backend-host';
import type { AgentSignal } from '../src/types/signals';
import type { CompletedTurn } from '../src/evolution/types';
import type { JsonObject } from '../src/index';
import { makeSqlExec } from './helpers';
import type { ToolOutcome } from '../src/tools/outcome';
import { present } from '@kinu.run/test-utils';

function newEventLog(): EventLog {
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);
  initEventsHubTables(sql);

  return new EventLog(sql, createTestActorsOver(db).main);
}

function webhook(deliveryId: string, body: JsonObject = { x: 1 }): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body, delivery_id: deliveryId },
    auth_outcome: 'verified', webhook_id: 'w1',
  };
}

function fakeEngine(opts?: { enabled?: boolean }) {
  const reviews: Array<{ turn: CompletedTurn; followup: string | null }> = [];
  const sessions: number[] = [];
  const trials: number[] = [];
  const { sql, execRaw } = createTestSql();
  initCompletedTurnTable(execRaw);
  const store = createCompletedTurnStore(sql, createTestActors(sql, execRaw).main);
  const crafted: string[] = [];
  const observed: Array<{ names: string[]; quality: number }> = [];

  const reviewTurn = async (turn: CompletedTurn, followup: string | null): Promise<void> => {
    reviews.push({ turn, followup });
  };

  const engine: AgentOrchestratorDeps['engine'] = {
    enabled: opts?.enabled ?? true,
    get recordsTurns() { return this.enabled; },
    recoverInterruptedWork: () => {},
    recentAdvisorNotes: () => [],
    recordAdvisorNote: () => { throw new Error('This fixture runs no advisor'); },
    hasAdvisorNoteForTurn: () => false,
    sessionWindow: store,
    craftLedger: {
      names: () => crafted,
      observe: (names: readonly string[], quality: number) => {
        observed.push({ names: [...names], quality });

        return [];
      },
    },
    reviewTurn,
    onSessionComplete: async (s: { turns: CompletedTurn[] }) => { sessions.push(s.turns.length); },
    runDueShadowTrials: async () => { trials.push(Date.now()); },
    recordRecovery: () => {},
    // Real store, so deferral and drain run the production path.
    deferTurnReview: (turn, followup, review) => store.enqueueReview(turn, followup, review),
    runDeferredTurnReviews: async () => {
      const taken = store.takeQueuedReviews(5);
      let reviewed = 0;

      for (const row of taken.reviews) {
        await engine.reviewTurn(row.turn, row.followup);
        store.settleReview(row.id);
        reviewed++;
      }

      return { reviewed, refused: taken.refused };
    },
    runStoredTurnReview: async (rowId, turn, followup) => {
      await engine.reviewTurn(turn, followup);
      store.settleReview(rowId);
    },
  };

  return { engine, reviews, sessions, crafted, observed, trials, sql, store };
}

function fakeHost(opts?: { activeTurn?: boolean }) {
  const enqueued: ProgrammaticTurn[] = [];
  const broadcasts: BroadcastEvent[] = [];
  const timers: Array<{ fn: () => Promise<void>; ms: number }> = [];

  const host: BackendHost = {
    broadcast: (event) => { broadcasts.push(event); },
    enqueueTurn: async (i) => {
      enqueued.push(i);

      return { status: 'queued' };
    },
    turnInFlight: () => opts?.activeTurn === true,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); },
  };

  return { host, enqueued, broadcasts, timers };
}

async function absorb(orch: AgentOrchestrator): Promise<readonly AgentSignal[]> {
  const extension = orch.turnExtension;

  if (!extension.prepareStep) throw new Error('Expected orchestrator prepareStep extension');
  await extension.prepareStep({ stepNumber: 0, messages: [{ role: 'user', content: 'q' }] });

  return orch.inbox.settle({ completed: true }).absorbed;
}

const aTurn = (i: number, origin: 'user' | 'programmatic' = 'user'): CompletedTurn => ({
  userMessage: `t${i}`, assistantResponse: 'r', toolCalls: [], durationMs: 1, steps: 1,
  hadError: false, feedback: null, turnId: `m${i}`, origin,
});

describe('AgentOrchestrator.recordTurn — session cadence', () => {
  test('session reflection fires every five turns — the shipped cadence', async () => {
    const { engine, sessions } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });

    for (let i = 0; i < 12; i++) {
      orch.recordTurn(aTurn(i), 'conversation');
      // The pass holds the window until it has run; let it finish.
      await orch.runDueSessionEvolution();
    }

    expect(sessions).toEqual([5, 5]);         // reflected at turn 5 and 10 (window closes)
    expect(orch.sessionTurnIndex).toBe(2);    // turns 11 and 12 left 2 in the new window
  });

  // The review runs after the governor's scope is gone; the turn must carry it.
  test('the turn carries the mission scope active when it ended, and an unscoped turn carries none', async () => {
    const { engine, reviews } = fakeEngine();
    const { host } = fakeHost();
    const { sql, execRaw } = createTestSql();

    const budget = new MissionGovernor({
      storage: { sql, execRaw }, actor: createTestActors(sql, execRaw).main,
    });

    budget.declare('checkout-fixes', { tokens: 1_000_000 }, {});
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), budget });

    orch.beginTurn(Date.now(), { missionLabels: ['checkout-fixes'] });
    orch.recordTurn(aTurn(1, 'programmatic'), 'independent_task');
    orch.beginTurn(Date.now(), {});
    orch.recordTurn(aTurn(2, 'programmatic'), 'independent_task');
    await orch.settleEvolution();

    // Absent, not `[]`: an unscoped review must never get a label.
    expect(reviews.map((r) => [r.turn.turnId, r.turn.missionLabels]))
      .toEqual([['m1', ['checkout-fixes']], ['m2', undefined]]);
  });

  test('a partial window survives the session ending — it is not force-closed or graded', async () => {
    const { engine, reviews, sessions } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });

    for (let i = 0; i < 2; i++) orch.recordTurn(aTurn(i), 'conversation');   // below the interval
    expect(sessions).toEqual([]);
    await orch.settleEvolution();
    // The last turn's follow-up may still arrive.
    expect(sessions).toEqual([]);
    expect(reviews).toEqual([]);
    expect(orch.sessionTurnIndex).toBe(2);
  });

  test('settleEvolution waits for the evolution the run dispatched', async () => {
    const { engine, sessions } = fakeEngine();
    const { host } = fakeHost();
    let release = () => {};

    const gate = new Promise<void>((resolve) => { release = resolve; });
    engine.onSessionComplete = async (session) => {
      await gate;
      sessions.push(session.turns.length);
    };

    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });

    for (let i = 0; i < 4; i++) orch.recordTurn(aTurn(i), 'conversation');
    orch.recordTurn(aTurn(4), 'conversation');
    const pass = orch.runDueSessionEvolution();
    expect(sessions).toEqual([]);
    await orch.settleEvolution();
    expect(sessions).toEqual([]);
    release();
    await pass;
    expect(sessions).toEqual([5]);
  });

  test('a one-shot host never STARTS the cadence pass — the window carries to the daemon', async () => {
    const { engine, sessions } = fakeEngine();
    const { host } = fakeHost();
    const eventLog = newEventLog();
    const oneShot = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });

    for (let i = 0; i < 5; i++) oneShot.recordTurn(aTurn(i), 'independent_task');
    await oneShot.settleEvolution();
    expect(sessions).toEqual([]);
    expect(oneShot.sessionTurnIndex).toBe(5);

    const daemon = new AgentOrchestrator({ host, engine, eventLog });
    await daemon.runDueSessionEvolution();
    expect(sessions).toEqual([5]);
    expect(daemon.sessionTurnIndex).toBe(0);
  });

  test('a one-shot host DEFERS the turn review — settle waits on nothing, a durable row is owed', async () => {
    const { engine, reviews, store } = fakeEngine();
    const { host } = fakeHost();
    // The exec process must not start work it cannot afford.
    engine.reviewTurn = () => new Promise<void>(() => {});
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), oneShot: true });
    orch.recordTurn(aTurn(0), 'independent_task');

    await orch.settleEvolution();
    expect(reviews).toEqual([]);
    expect(store.countQueuedReviews()).toBe(1);
  });

  test('an interactive host JOINS the inline review until it settles — no elapsed bound', async () => {
    const { engine, store } = fakeEngine();
    const { host } = fakeHost();
    const gate = Promise.withResolvers<void>();
    let reviewed = false;
    engine.reviewTurn = async () => { await gate.promise; reviewed = true; };

    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.recordTurn(aTurn(0), 'independent_task');

    let settled = false;
    const settle = orch.settleEvolution().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await settle;
    expect(reviewed).toBe(true);
    expect(store.countQueuedReviews()).toBe(0);
  });

  test('the deferred review is re-driven at the next open, with the same inputs', async () => {
    const { engine, reviews, store } = fakeEngine();
    const { host } = fakeHost();
    const eventLog = newEventLog();
    const exec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    exec.recordTurn(aTurn(7), 'independent_task');
    await exec.settleEvolution();
    expect(reviews).toEqual([]);

    const next = new AgentOrchestrator({ host, engine, eventLog });
    expect(await next.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].turn.turnId).toBe('m7');
    expect(reviews[0].followup).toBeNull();
    expect(store.countQueuedReviews()).toBe(0);
  });

  test('a one-shot host does not re-drive either — that would only move the cost', async () => {
    const { engine, reviews, store } = fakeEngine();
    const { host } = fakeHost();
    const eventLog = newEventLog();
    new AgentOrchestrator({ host, engine, eventLog, oneShot: true })
      .recordTurn(aTurn(0), 'independent_task');
    const nextExec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    expect(await nextExec.runDeferredTurnReviews()).toEqual({ reviewed: 0, refused: [] });
    expect(reviews).toEqual([]);
    expect(store.countQueuedReviews()).toBe(1);
  });

  test('a deferred review carries the follow-up that grades it, not a re-guess', async () => {
    const { engine, reviews } = fakeEngine();
    const { host } = fakeHost();
    const eventLog = newEventLog();
    const chat = new AgentOrchestrator({ host, engine, eventLog });
    chat.recordTurn(aTurn(1), 'conversation');

    // A later one-shot process with a different task.
    const exec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    exec.observeUserTurn('unrelated next task', 'independent_task');
    await exec.settleEvolution();
    expect(reviews).toEqual([]);
    const next = new AgentOrchestrator({ host, engine, eventLog });
    await next.runDeferredTurnReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].followup).toBeNull();
  });

  test('settleEvolution JOINS the turn lane until it settles — background work is never abandoned by the clock', async () => {
    const { engine } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    // Evolution work is never abandoned on a clock.
    const gate = Promise.withResolvers<void>();
    let done = false;
    orch.track(gate.promise.then(() => { done = true; }), 'Turn review');

    let settled = false;
    const settle = orch.settleEvolution().then(() => { settled = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(settled).toBe(false);

    gate.resolve();
    await settle;
    expect(done).toBe(true);
  });

  test('with auto-evolution off, a turn leaves no evolution state at all', () => {
    const { engine, reviews, sessions } = fakeEngine({ enabled: false });
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });

    for (let i = 0; i < 5; i++) orch.recordTurn(aTurn(i), 'conversation');
    orch.observeUserTurn('anything', 'conversation');
    expect(sessions).toEqual([]);
    expect(reviews).toEqual([]);
    expect(orch.sessionTurnIndex).toBe(0);
  });
});

describe('AgentOrchestrator — the settle’s claimable parts', () => {
  // The lane verdict and the roster's completed-Build gate are one rule and must agree.
  test('the lane verdict and the roster’s own gate agree on every (status, mode)', () => {
    for (const workMode of ['build', 'plan'] as const) {
      for (const status of RUN_END_REASONS) {
        const { engine } = fakeEngine();
        const { host } = fakeHost();
        const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
        orch.beginTurn(Date.now(), { kinuMode: workMode });

        const predicate = orch.improvementLanesOpen(status);

        const owed = declareTerminalRoster({
          messageId: 'answer-1', status, workMode, continuity: 'conversation',
          completed: status === 'completed', userText: 'q', assistantText: 'a',
          scopedTurn: {}, recordedAt: 1, evolutionEnabled: true,
        }, { autoGepa: true });

        const rosterGate = owed.some((effect) => effect.name === 'auto_gepa');

        expect({ workMode, status, open: rosterGate })
          .toEqual({ workMode, status, open: predicate });
        // So an agreeing pair of wrong answers still fails.
        expect(predicate).toBe(status === 'completed' && workMode === 'build');
      }
    }
  });

  test('the roster decides the shadow trial and the title subject, the same for every backend', () => {
    const settled = (evolutionEnabled: boolean, mission: string | null) => declareTerminalRoster({
      messageId: 'answer-1', status: 'completed', workMode: 'build', continuity: 'conversation',
      completed: true, userText: 'rotate the staging keys', assistantText: 'a',
      scopedTurn: {}, recordedAt: 1, evolutionEnabled,
    }, { shadowTrial: { pendingVersion: 2, trialContext: [] }, autoTitle: { mission } });

    const titleInput = (evolutionEnabled: boolean, mission: string | null) =>
      settled(evolutionEnabled, mission).find((effect) => effect.name === 'auto_title')?.input;

    // A session with evolution off records no evolution state, so its candidate
    // is owed no trial either — whether or not its host thought to ask.
    expect(settled(false, null).map((effect) => effect.name)).not.toContain('shadow_trial');
    expect(settled(true, null).map((effect) => effect.name)).toContain('shadow_trial');
    // An unset mission leaves the owner's own words to title the workspace.
    expect(titleInput(true, null)).toEqual({ subject: 'rotate the staging keys' });
    expect(titleInput(true, 'Keep the staging keys rotated')).toEqual({ subject: 'Keep the staging keys rotated' });
  });

  test('the roster owes the extension end, then the recording, then the drain', () => {
    // The drain follows the recording so a woken turn is not graded first.
    const owed = declareTerminalRoster({
      messageId: 'answer-1', status: 'completed', workMode: 'build',
      continuity: 'conversation', completed: true, userText: 'q', assistantText: 'a',
      scopedTurn: {}, recordedAt: 1, evolutionEnabled: true,
    }, { turnEndExtensions: true });

    const at = (name: string): number => owed.findIndex((effect) => effect.name === name);

    expect(at('turn_end_extensions')).toBeGreaterThanOrEqual(0);
    expect(at('turn_record')).toBeGreaterThan(at('turn_end_extensions'));
    expect(at('event_drain')).toBeGreaterThan(at('turn_record'));
    expect(at('improvement_lanes')).toBeGreaterThan(at('event_drain'));
  });

  test('a turn cut before its first token owes no effect keyed on an answer row', () => {
    const owed = declareTerminalRoster({
      messageId: '', status: 'aborted', workMode: 'build',
      continuity: 'conversation', completed: false, userText: 'q', assistantText: '',
      scopedTurn: {}, recordedAt: 1, evolutionEnabled: true,
    }, { turnEndExtensions: true, eventReplies: { answered: new Set(['d1']), requestId: 'req-1' } });

    expect(owed.map((effect) => effect.name)).not.toContain('turn_end_extensions');
    expect(owed.map((effect) => effect.name)).not.toContain('event_reply');
    expect(creditedTurnId({ messageId: '', completed: true, workMode: 'build' })).toBeNull();
  });

  test('the drain the settled turn owes injects one turn for the pending backlog', async () => {
    const { engine } = fakeEngine();
    const { host, enqueued } = fakeHost();
    const eventLog = newEventLog();
    eventLog.publish({ descriptor: webhook('d1'), now: 1 });
    const orch = new AgentOrchestrator({ host, engine, eventLog });
    orch.beginTurn(Date.now(), {});

    await orch.drainPendingEvents();

    expect(enqueued).toHaveLength(1);
  });

  // Stop or pending work must not feed the outcome classifier a negative label.
  test('the recorded turn carries hadError only when the driver said error', () => {
    const recorded: Array<boolean> = [];
    const predicted: Array<boolean> = [];

    for (const status of RUN_END_REASONS) {
      const { engine, store } = fakeEngine();
      const { host } = fakeHost();
      const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
      orch.beginTurn(Date.now(), {});
      const stamped = orch.recordedTurn(status, aTurn(0));
      predicted.push(stamped.hadError);
      orch.recordTurn(stamped, 'conversation');
      recorded.push(present(store.claim(), 'the claimed window').turns[0].hadError);
    }

    expect(recorded).toEqual([false, false, true, false]);
    expect(predicted).toEqual(recorded);
  });

  // A replay must not advance the cadence twice.
  test('recordTurn under one id twice leaves one window row and one cadence tick', () => {
    const { engine, store } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.beginTurn(Date.now(), {});

    orch.recordTurn(aTurn(0), 'conversation', { id: 'settle:msg-1' });
    orch.recordTurn(aTurn(0), 'conversation', { id: 'settle:msg-1' });

    expect(orch.sessionTurnIndex).toBe(1);
    expect(present(store.claim(), 'the claimed window').turns).toEqual([aTurn(0)]);
  });

  test('recordTurn with no id keeps minting rows — the CLI path is unchanged', () => {
    const { engine } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.beginTurn(Date.now(), {});
    orch.recordTurn(aTurn(0), 'conversation');
    orch.recordTurn(aTurn(0), 'conversation');
    expect(orch.sessionTurnIndex).toBe(2);
  });

  test('draining twice delivers one turn — pending selects only unbound rows', async () => {
    const { engine } = fakeEngine();
    const { host, enqueued } = fakeHost();
    const eventLog = newEventLog();
    eventLog.publish({ descriptor: webhook('d1'), now: 1 });
    const orch = new AgentOrchestrator({ host, engine, eventLog });

    await orch.drainPendingEvents();
    await orch.drainPendingEvents();

    expect(enqueued).toHaveLength(1);
    expect(eventLog.pending()).toEqual([]);
  });
});

describe('AgentOrchestrator — the durable session window', () => {
  // One process per turn: state must live in the workspace database.
  test('the window accumulates across orchestrator instances and fires at the interval', async () => {
    const { engine, sessions } = fakeEngine();
    const eventLog = newEventLog();
    let last: AgentOrchestrator | null = null;

    for (let i = 0; i < 5; i++) {
      const { host } = fakeHost();
      last = new AgentOrchestrator({ host, engine, eventLog });
      last.recordTurn(aTurn(i), 'conversation');
    }

    if (!last) throw new Error('Expected the orchestrator loop to run');
    await last.runDueSessionEvolution();
    expect(sessions).toEqual([5]);
  });

  test('the pending review survives the process boundary — the next run grades it', () => {
    const { engine, reviews } = fakeEngine();
    const eventLog = newEventLog();
    const { host } = fakeHost();
    new AgentOrchestrator({ host, engine, eventLog }).recordTurn(aTurn(0), 'conversation');
    expect(reviews).toHaveLength(0);
    // Continuing the conversation: this user message is turn 0's follow-up.
    new AgentOrchestrator({ host, engine, eventLog }).observeUserTurn('that broke the build', 'conversation');
    expect(reviews).toEqual([{ turn: aTurn(0), followup: 'that broke the build' }]);
  });

  test('a one-shot turn is graded on execution signal — never parked for the next task', async () => {
    const { engine, reviews } = fakeEngine();
    const eventLog = newEventLog();
    const { host } = fakeHost();
    const exec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    exec.recordTurn(aTurn(0), 'independent_task');
    // Deferred rather than run: this process is about to exit.
    expect(reviews).toEqual([]);
    new AgentOrchestrator({ host, engine, eventLog, oneShot: true })
      .observeUserTurn('a completely different task', 'independent_task');
    await new AgentOrchestrator({ host, engine, eventLog }).runDeferredTurnReviews();
    expect(reviews).toEqual([{ turn: aTurn(0), followup: null }]);
  });

  test('a turn parked by a conversation is NOT graded from a one-shot prompt', async () => {
    const { engine, reviews } = fakeEngine();
    const eventLog = newEventLog();
    const { host } = fakeHost();
    new AgentOrchestrator({ host, engine, eventLog }).recordTurn(aTurn(0), 'conversation');
    new AgentOrchestrator({ host, engine, eventLog, oneShot: true })
      .observeUserTurn('unrelated task', 'independent_task');
    await new AgentOrchestrator({ host, engine, eventLog }).runDeferredTurnReviews();
    expect(reviews).toEqual([{ turn: aTurn(0), followup: null }]);
  });
});

describe('AgentOrchestrator — turn-outcome review dispatch', () => {
  test('the next user message grades the previous turn (Hermes-style forked review)', () => {
    const { engine, reviews } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });

    orch.observeUserTurn('first message', 'conversation');
    expect(reviews).toHaveLength(0);

    orch.recordTurn(aTurn(0), 'conversation');
    expect(reviews).toHaveLength(0);

    orch.observeUserTurn('actually, that was wrong', 'conversation');
    expect(reviews).toEqual([{ turn: aTurn(0), followup: 'actually, that was wrong' }]);

    orch.observeUserTurn('another message', 'conversation');
    expect(reviews).toHaveLength(1);
  });

  test('programmatic turns review immediately with no follow-up and do not displace the pending user turn', () => {
    const { engine, reviews } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });

    orch.recordTurn(aTurn(0), 'conversation');
    orch.recordTurn(aTurn(1, 'programmatic'), 'conversation'); // reactor/job-wake turn
    expect(reviews).toEqual([{ turn: aTurn(1, 'programmatic'), followup: null }]);

    orch.observeUserTurn('follow-up for the USER turn', 'conversation');
    expect(reviews[1]).toEqual({ turn: aTurn(0), followup: 'follow-up for the USER turn' });
  });
});

describe('AgentOrchestrator.drainPendingEvents — the reactor (drain-then-stop)', () => {
  test('injects ONE programmatic turn for pending external events, then stops', async () => {
    const log = newEventLog();
    log.publish({ descriptor: webhook('d1'), now: 1 });
    log.publish({ descriptor: webhook('d2'), now: 2 });
    const { engine } = fakeEngine();
    const { host, enqueued } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: log });

    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(1);
    const turn = enqueued[0];

    if (!turn) throw new Error('Expected one event-drain turn');
    expect(turn.text).toContain('arrived');
    expect(turn.text).toContain('[webhook]');
    // The synthetic turn id is the reply-dispatch key.
    expect(turn.metadata?.kinuEvent).toBe('event_drain');
    const drainTurnId = v.parse(v.string(), turn.metadata?.drainTurnId);
    // d1/d2 share a body, so dedupe admits one event.
    const bound = log.query({ turn_id: drainTurnId });
    expect(bound).toHaveLength(1);

    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(1);
  });

  test('no pending events → no turn injected (idle reactor)', async () => {
    const { engine } = fakeEngine();
    const { host, enqueued } = fakeHost();
    await new AgentOrchestrator({ host, engine, eventLog: newEventLog() }).drainPendingEvents();
    expect(enqueued).toHaveLength(0);
  });

  test('an ACTIVE turn absorbs the batch mid-turn — no new turn is enqueued', async () => {
    const log = newEventLog();
    log.publish({ descriptor: webhook('d1'), now: 1 });
    const { engine } = fakeEngine();
    const { host, enqueued, broadcasts } = fakeHost({ activeTurn: true });
    const orch = new AgentOrchestrator({ host, engine, eventLog: log });

    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(0);
    await orch.drainPendingEvents();
    const injected = await absorb(orch);
    expect(injected).toHaveLength(1);
    // Mid-turn: fold the events in, not stop.
    expect(injected[0].stepText).toContain('arrived while you were working');
    expect(injected[0].stepText).toContain('[webhook]');
    // For the re-delivery fallback.
    expect(injected[0].text).toContain('arrived while you were idle');
    const replyTurnId = present(injected[0].replyTurnId, 'the reply turn the signal carries');
    const bound = log.query({ turn_id: replyTurnId });
    expect(bound.map((event) => event.id)).toHaveLength(1);
    // The card exists from delivery; the step that takes the batch moves it to shown.
    const cardId = broadcasts[0]?.id;
    expect(broadcasts).toEqual([
      {
        type: 'signal_card', id: cardId, state: 'pending',
        metadata: {
          kinuEvent: 'event_drain', kinuAuthor: 'harness',
          drainTurnId: replyTurnId,
        },
        text: injected[0].stepText,
      },
      { type: 'signal_card', id: cardId, state: 'shown' },
    ]);
    expect(enqueued).toHaveLength(0);
  });

  test('a backend that takes no mid-turn wake gets the batch as its own turn', async () => {
    const log = newEventLog();
    log.publish({ descriptor: webhook('d1'), now: 1 });
    const { engine } = fakeEngine();
    const { host, enqueued, broadcasts } = fakeHost({ activeTurn: false });
    const orch = new AgentOrchestrator({ host, engine, eventLog: log });
    await orch.drainPendingEvents();
    expect(await absorb(orch)).toHaveLength(0);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].metadata?.kinuEvent).toBe('event_drain');
    // The queued path shows the same card.
    const signalId = v.parse(v.string(), enqueued[0]?.metadata?.signalId);
    expect(broadcasts).toEqual([{
      type: 'signal_card', id: signalId, state: 'pending',
      metadata: {
        kinuEvent: 'event_drain', kinuAuthor: 'harness',
        drainTurnId: expect.any(String),
      },
      text: enqueued[0].text,
    }]);
  });

  test('an enqueue rejection re-pends the batch so the next drain retries it', async () => {
    const log = newEventLog();
    const admitted = log.publish({ descriptor: webhook('retry-rejection'), now: 1 });
    const { engine } = fakeEngine();
    const { host, enqueued } = fakeHost();
    let attempts = 0;
    host.enqueueTurn = async (turn) => {
      enqueued.push(turn);
      attempts++;

      if (attempts === 1) throw new Error('queue unavailable');

      return { status: 'queued' };
    };

    const orch = new AgentOrchestrator({ host, engine, eventLog: log });

    await orch.drainPendingEvents();
    expect(log.pending().map((event) => event.id)).toEqual([admitted.id]);

    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(2);
    expect(log.pending()).toHaveLength(0);
    const retriedTurnId = v.parse(v.string(), enqueued[1]?.metadata?.drainTurnId);
    expect(log.query({ turn_id: retriedTurnId }).map((event) => event.id))
      .toEqual([admitted.id]);
  });

  test("a skipped enqueue re-pends the batch so the next drain retries it", async () => {
    const log = newEventLog();
    const admitted = log.publish({ descriptor: webhook('retry-skipped'), now: 1 });
    const { engine } = fakeEngine();
    const { host, enqueued } = fakeHost();
    let attempts = 0;
    host.enqueueTurn = async (turn) => {
      enqueued.push(turn);
      attempts++;

      return { status: attempts === 1 ? 'skipped' : 'queued' };
    };

    const orch = new AgentOrchestrator({ host, engine, eventLog: log });

    await orch.drainPendingEvents();
    expect(log.pending().map((event) => event.id)).toEqual([admitted.id]);

    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(2);
    expect(log.pending()).toHaveLength(0);
  });
});

describe('AgentOrchestrator.scheduleDrain — debounced ingress coalescing', () => {
  test('an event burst schedules ONE window that drains into ONE turn', async () => {
    const log = newEventLog();
    const { engine } = fakeEngine();
    const { host, enqueued, timers } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: log });

    for (let i = 0; i < 3; i++) {
      log.publish({ descriptor: webhook(`d${i}`, { seq: i }), now: i + 1 });
      orch.scheduleDrain();
    }

    expect(timers).toHaveLength(1);
    expect(enqueued).toHaveLength(0);

    await timers[0].fn();
    expect(enqueued).toHaveLength(1);
    const drainTurnId = v.parse(v.string(), enqueued[0]?.metadata?.drainTurnId);
    const bound = log.query({ turn_id: drainTurnId });
    expect(bound).toHaveLength(3);
  });

  test('a schedule after the window fired opens a second window → a second turn', async () => {
    const log = newEventLog();
    const { engine } = fakeEngine();
    const { host, enqueued, timers } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: log });

    log.publish({ descriptor: webhook('a', { seq: 'a' }), now: 1 });
    orch.scheduleDrain();
    await timers[0].fn();
    log.publish({ descriptor: webhook('b', { seq: 'b' }), now: 2 });
    orch.scheduleDrain();
    await timers[1].fn();
    expect(enqueued).toHaveLength(2);
  });

  test('a window firing with nothing pending injects no turn', async () => {
    const { engine } = fakeEngine();
    const { host, enqueued, timers } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.scheduleDrain();
    await timers[0].fn();
    expect(enqueued).toHaveLength(0);
  });
});

describe('AgentOrchestrator — the in-episode evolution clock', () => {
  async function runBlock(orch: AgentOrchestrator, code: string, failure?: string): Promise<void> {
    await orch.turnExtension.onToolResult?.({
      toolName: 'eval',
      args: { code },
      result: failure ?? 'ok',
      ...(failure === undefined ? { success: true } satisfies ToolOutcome : { success: false, reason: null } satisfies ToolOutcome),
    });
  }

  test('the turn extension is the seam — a crafted tool is scored mid-turn', async () => {
    const { engine, crafted, observed } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());

    await runBlock(orch, 'return await tools.summarize(1)');

    expect(observed).toHaveLength(1);
    expect(observed[0].names).toEqual(['summarize']);
    expect(orch.craft.snapshot()).toEqual({
      crafted: [], invoked: ['summarize'], reused: [], returned: 1, raised: 0, dropped: [],
    });
  });

  test('a stamped failure is scored against the tool through the same seam', async () => {
    const { engine, crafted, observed } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());

    await runBlock(orch, 'return await tools.summarize(1)', '[crafted:summarize] boom');
    expect(observed).toEqual([{ names: ['summarize'], quality: 0.1 }]);
    expect(present(orch.craft.snapshot(), 'the craft snapshot').raised).toBe(1);

    // …and a failure that names nothing scores nothing.
    await runBlock(orch, 'return await tools.summarize(1)', 'TypeError: x is not a function');
    expect(observed).toHaveLength(1);
  });

  test('a tool that appeared during the turn is crafted, not pre-existing', async () => {
    const { engine, crafted, observed } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.beginTurn(Date.now());

    crafted.push('summarize');
    await runBlock(orch, 'await workspace.createTool("summarize","d","async()=>1"); return tools.summarize(1)');
    // Created and called in one breath earns nothing…
    expect(observed).toEqual([]);
    expect(present(orch.craft.snapshot(), 'the craft snapshot').crafted).toEqual(['summarize']);

    // …and the next block that reaches for it closes the loop.
    await runBlock(orch, 'return await tools.summarize(2)');
    expect(observed).toHaveLength(1);
    expect(present(orch.craft.snapshot(), 'the craft snapshot').reused).toEqual(['summarize']);
  });

  test('with auto-evolution off the in-episode clock records nothing', async () => {
    const { engine, crafted, observed } = fakeEngine({ enabled: false });
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());

    await runBlock(orch, 'return await tools.summarize(1)');

    expect(observed).toEqual([]);
    expect(orch.craft.snapshot()).toBeNull();
  });

  test('beginTurn clears the previous turn\'s craft record', async () => {
    const { engine, crafted } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());
    await runBlock(orch, 'return await tools.summarize(1)');
    expect(orch.craft.snapshot()).toEqual({
      crafted: [], invoked: ['summarize'], reused: [], returned: 1, raised: 0, dropped: [],
    });

    orch.beginTurn(Date.now());
    expect(orch.craft.snapshot()).toBeNull();
  });

  test('turn steering still observes the same calls through the shared seam', async () => {
    const { engine } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.beginTurn(Date.now());

    for (let i = 0; i < 3; i++) {
      await orch.turnExtension.onToolCall?.({ toolName: 'shell', args: { command: `x${i}` } });
      await orch.turnExtension.onToolResult?.({
        toolName: 'shell', args: { command: 'x' + i }, result: 'Error: no ' + i, success: false, reason: null,
      });
    }

    const steered = orch.steering.steerFor({ stepNumber: 4, messages: [] });
    expect(steered).toMatchObject({ kind: 'turn_steering' });
    expect(steered?.text).toContain('`shell` has failed 3 times in a row');
  });
});
