// AgentOrchestrator — the backend-agnostic per-turn logic (re-arch P3). Verifies
// the session-evolution cadence + the event→turn reactor (drain-then-stop) that
// were extracted from the cf-backend OrchestratorAgent's onChatResponse.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestSql } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { AgentOrchestrator, type AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import { MissionGovernor } from '../src/mission-budget';
import { initCompletedTurnTable, createCompletedTurnStore } from '../src/evolution/session-window';
import { initEventsHubTables, EventLog, type IngressDescriptor } from '../src/events/hub/index';
import type { BackendHost, BroadcastEvent, ProgrammaticTurn } from '../src/types/backend-host';
import type { AgentSignal } from '../src/types/signals';
import type { CompletedTurn } from '../src/evolution/types';
import type { JsonObject, SqlExec } from '../src/index';
import { makeSqlExec } from './helpers';

function makeSql(): SqlExec {
  return makeSqlExec(new Database(':memory:'));
}
function newEventLog(): EventLog {
  const sql = makeSql();
  initEventsHubTables(sql);
  return new EventLog(sql);
}
function webhook(deliveryId: string, body: JsonObject = { x: 1 }): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body, delivery_id: deliveryId },
    auth_outcome: 'verified', webhook_id: 'w1',
  };
}

/** A stand-in engine over a REAL in-memory session window — the store the
 *  engine owns in production, so the cadence is exercised against the durable
 *  buffer rather than orchestrator-instance state. */
function fakeEngine(opts?: { enabled?: boolean }) {
  const reviews: Array<{ turn: CompletedTurn; followup: string | null }> = [];
  const sessions: number[] = [];
  /** One entry per cadence pass that ran the promotion gate's queued trials. */
  const trials: number[] = [];
  const { sql, execRaw } = createTestSql();
  initCompletedTurnTable(execRaw, sql);
  const store = createCompletedTurnStore(sql);
  // The crafted-tool ledger the engine owns in production, over a real store,
  // so the in-episode clock is exercised through the same seam.
  const crafted: string[] = [];
  const observed: Array<{ names: string[]; quality: number }> = [];
  const reviewTurn = async (turn: CompletedTurn, followup: string | null): Promise<void> => {
    reviews.push({ turn, followup });
  };
  const engine: AgentOrchestratorDeps['engine'] = {
    enabled: opts?.enabled ?? true,
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
    // The real store, so a deferral is exercised against the durable row and
    // the drain replays through the SAME reviewTurn above — exactly the
    // production wiring, settle included.
    deferTurnReview: (turn, followup, opts) => store.enqueueReview(turn, followup, opts),
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
    enqueueTurn: async (i) => { enqueued.push(i); return { status: 'queued' }; },
    turnInFlight: () => opts?.activeTurn === true,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); },
  };
  return { host, enqueued, broadcasts, timers };
}

/** What a live turn actually absorbed, read back through the seam the backend
 *  reads: one step boundary, then settle. */
function absorb(orch: AgentOrchestrator): readonly AgentSignal[] {
  const prepareStep = orch.turnExtension.prepareStep;
  if (!prepareStep) throw new Error('Expected orchestrator prepareStep extension');
  prepareStep({ stepNumber: 0, messages: [{ role: 'user', content: 'q' }] });
  return orch.signals.settle({ completed: true }).absorbed;
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
      // The pass claims the window and settles it only once it has run, so a
      // second pass cannot start while the first is live. Real turns are
      // minutes apart; the test just lets the pass finish.
      await orch.runDueSessionEvolution();
    }
    expect(sessions).toEqual([5, 5]);         // reflected at turn 5 and 10 (window closes)
    expect(orch.sessionTurnIndex).toBe(2);    // turns 11 and 12 left 2 in the new window
  });

  // The turn's review runs later, and often elsewhere: at the next user message,
  // or drained from a durable row by a different process. The governor's active
  // scope is gone by then, so the answer has to be carried by the turn.
  test('the turn carries the mission scope active when it ended, and an unscoped turn carries none', () => {
    const { engine, reviews } = fakeEngine();
    const { host } = fakeHost();
    const { sql, execRaw } = createTestSql();
    const budget = new MissionGovernor({ storage: { sql, execRaw } });
    budget.declare('checkout-fixes', { tokens: 1_000_000 }, {});
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), budget });

    orch.beginTurn(Date.now(), { missionLabels: ['checkout-fixes'] });
    orch.recordTurn(aTurn(1, 'programmatic'), 'independent_task');
    orch.beginTurn(Date.now(), {});
    orch.recordTurn(aTurn(2, 'programmatic'), 'independent_task');

    // Absent, not `[]`, on the unscoped turn: a review must never be handed a
    // label, and an empty one is a label-shaped thing to reason about.
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
    // No session is manufactured out of a 2-turn window, and the last turn's
    // follow-up may still arrive — so nothing is graded on no evidence.
    expect(sessions).toEqual([]);
    expect(reviews).toEqual([]);
    expect(orch.sessionTurnIndex).toBe(2);                    // the window carries over
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
    orch.recordTurn(aTurn(4), 'conversation');   // reaches the interval → dispatches the pass
    // The pass recordTurn just started, not a second one.
    const pass = orch.runDueSessionEvolution();
    expect(sessions).toEqual([]);            // still in flight
    // The turn lane settles without waiting for the cadence lane — that is the
    // whole point: one exec invocation must not own a lifetime cycle's clock.
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
    expect(sessions).toEqual([]);                    // nothing ran in the exec process
    expect(oneShot.sessionTurnIndex).toBe(5);        // and nothing was consumed

    // The daemon (a host that can afford the work) picks up the SAME turns.
    const daemon = new AgentOrchestrator({ host, engine, eventLog });
    await daemon.runDueSessionEvolution();
    expect(sessions).toEqual([5]);
    expect(daemon.sessionTurnIndex).toBe(0);
  });

  test('a one-shot host DEFERS the turn review — settle waits on nothing, a durable row is owed', async () => {
    const { engine, reviews, store } = fakeEngine();
    const { host } = fakeHost();
    // A review that never finishes: on a host that joins the lane this is the
    // whole join, which is exactly why the exec process must not START the
    // work it cannot afford.
    engine.reviewTurn = () => new Promise<void>(() => {});
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), oneShot: true });
    orch.recordTurn(aTurn(0), 'independent_task');

    await orch.settleEvolution();
    expect(reviews).toEqual([]);                        // nothing ran in the exec process
    expect(store.countQueuedReviews()).toBe(1);        // and the review is owed, durably
  });

  test('an interactive host JOINS the inline review until it settles — no elapsed bound', async () => {
    const { engine, store } = fakeEngine();
    const { host } = fakeHost();
    // The review resolves only when the test releases it; settleEvolution
    // must still be pending while it runs, then return only once it has run.
    const gate = Promise.withResolvers<void>();
    let reviewed = false;
    engine.reviewTurn = async () => { await gate.promise; reviewed = true; };
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.recordTurn(aTurn(0), 'independent_task');

    let settled = false;
    const settle = orch.settleEvolution().then(() => { settled = true; });
    await Promise.resolve();
    expect(reviewed).toBe(false);
    expect(settled).toBe(false);          // joined, not abandoned at some bound

    gate.resolve();
    await settle;
    expect(reviewed).toBe(true);
    expect(store.countQueuedReviews()).toBe(0);   // nothing was deferred
  });

  test('the deferred review is re-driven at the next open, with the same inputs', async () => {
    const { engine, reviews, store } = fakeEngine();
    const { host } = fakeHost();
    const eventLog = newEventLog();
    const exec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    exec.recordTurn(aTurn(7), 'independent_task');
    await exec.settleEvolution();
    expect(reviews).toEqual([]);

    // The next host that can afford the work — the daemon or an interactive
    // session — drains it through the SAME reviewTurn path.
    const next = new AgentOrchestrator({ host, engine, eventLog });
    expect(await next.runDeferredTurnReviews()).toEqual({ reviewed: 1, refused: [] });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].turn.turnId).toBe('m7');
    expect(reviews[0].followup).toBeNull();
    expect(store.countQueuedReviews()).toBe(0);       // retired once it ran
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
    expect(store.countQueuedReviews()).toBe(1);       // still owed, for a host that can pay
  });

  test('a deferred review carries the follow-up that grades it, not a re-guess', async () => {
    const { engine, reviews } = fakeEngine();
    const { host } = fakeHost();
    const eventLog = newEventLog();
    const chat = new AgentOrchestrator({ host, engine, eventLog });
    chat.recordTurn(aTurn(1), 'conversation');          // parked awaiting a follow-up

    // A LATER one-shot process picks up that parked turn. Its own prompt is a
    // different task, so the review is deferred with no follow-up …
    const exec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    exec.observeUserTurn('unrelated next task', 'independent_task');
    await exec.settleEvolution();
    expect(reviews).toEqual([]);
    const next = new AgentOrchestrator({ host, engine, eventLog });
    await next.runDeferredTurnReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].followup).toBeNull();             // … and it stays absent
  });

  test('settleEvolution JOINS the turn lane until it settles — background work is never abandoned by the clock', async () => {
    const { engine } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    // Work that finishes only when released: settleEvolution stays pending
    // for as long as the work runs, then completes. The old bound ABANDONED
    // this lane and logged `evolution.settle_timed_out` — honest evolution
    // work killed by a clock.
    const gate = Promise.withResolvers<void>();
    let done = false;
    orch.track(gate.promise.then(() => { done = true; }), 'Turn review');

    let settled = false;
    const settle = orch.settleEvolution().then(() => { settled = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(settled).toBe(false);   // still joined while the work runs

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
    expect(orch.sessionTurnIndex).toBe(0);           // nothing for a later host to evolve
  });
});

describe('AgentOrchestrator — the durable session window', () => {
  // `kinu exec` is one process per turn: a fresh orchestrator every time,
  // against the same workspace database. The window and the pending review
  // have to live in that database or headless usage never evolves at all.
  test('the window accumulates across orchestrator instances and fires at the interval', async () => {
    const { engine, sessions } = fakeEngine();
    const eventLog = newEventLog();
    let last: AgentOrchestrator | null = null;
    for (let i = 0; i < 5; i++) {
      const { host } = fakeHost();
      last = new AgentOrchestrator({ host, engine, eventLog });
      last.recordTurn(aTurn(i), 'conversation');
    }
    // recordTurn detaches the cadence pass; join the one it started.
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
    // A new process against the same workspace, continuing the SAME
    // conversation: its user message IS turn 0's follow-up, so the turn is
    // graded by real signal instead of a constant.
    new AgentOrchestrator({ host, engine, eventLog }).observeUserTurn('that broke the build', 'conversation');
    expect(reviews).toEqual([{ turn: aTurn(0), followup: 'that broke the build' }]);
  });

  test('a one-shot turn is graded on execution signal — never parked for the next task', async () => {
    const { engine, reviews } = fakeEngine();
    const eventLog = newEventLog();
    const { host } = fakeHost();
    const exec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    exec.recordTurn(aTurn(0), 'independent_task');
    // Reviewed with NO follow-up — the environment's verdict is the only
    // evidence, and it is all in already — but DEFERRED rather than run here:
    // this process is about to exit (see the exit contract).
    expect(reviews).toEqual([]);
    // Nothing is left waiting, so the next invocation's unrelated prompt has
    // nothing to be misread as a verdict on.
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
    // `kinu exec` against the same workspace: its prompt is a fresh task
    // written by a caller who never saw turn 0's answer.
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

    orch.observeUserTurn('first message', 'conversation');   // nothing pending yet
    expect(reviews).toHaveLength(0);

    orch.recordTurn(aTurn(0), 'conversation');        // turn 0 completes → pending
    expect(reviews).toHaveLength(0);                  // not reviewed at completion

    orch.observeUserTurn('actually, that was wrong', 'conversation');
    expect(reviews).toEqual([{ turn: aTurn(0), followup: 'actually, that was wrong' }]);

    orch.observeUserTurn('another message', 'conversation'); // pending consumed
    expect(reviews).toHaveLength(1);
  });

  test('programmatic turns review immediately with no follow-up and do not displace the pending user turn', () => {
    const { engine, reviews } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });

    orch.recordTurn(aTurn(0), 'conversation');        // user turn pending
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
    expect(enqueued).toHaveLength(1);                    // one batched turn
    const turn = enqueued[0];
    if (!turn) throw new Error('Expected one event-drain turn');
    expect(turn.text).toContain('arrived');        // the turn-driving message
    expect(turn.text).toContain('[webhook]');
    // The injected turn is marked programmatic and carries the synthetic turn
    // id the consumed events were bound to — the backend's reply-dispatch key.
    expect(turn.metadata?.kinuEvent).toBe('event_drain');
    const drainTurnId = v.parse(v.string(), turn.metadata?.drainTurnId);
    // d1/d2 share a body → webhook dedupe admits one event; it is bound here.
    const bound = log.query({ turn_id: drainTurnId });
    expect(bound).toHaveLength(1);

    // Events are now consumed → a second drain is a no-op (self-terminates).
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
    // A second drain finds nothing: consumed events never double-deliver.
    await orch.drainPendingEvents();
    const injected = absorb(orch);
    expect(injected).toHaveLength(1);
    // Mid-turn rendering: the live turn is told to fold the events in, not stop.
    expect(injected[0]!.stepText).toContain('arrived while you were working');
    expect(injected[0]!.stepText).toContain('[webhook]');
    // The standalone rendering rides along for the re-delivery fallback.
    expect(injected[0]!.text).toContain('arrived while you were idle');
    // Reply-channel binding: the consumed event is bound to the SAME turn id
    // the signal carries — the backend dispatches the live turn's answer by it.
    const bound = log.query({ turn_id: injected[0]!.replyTurnId! });
    expect(bound.map((event) => event.id)).toHaveLength(1);
    // The delivery is observable (clients get a typed fan-out, not silence):
    // the user's card exists from the moment the batch was DELIVERED, saying
    // the agent has not read it yet and carrying the mid-turn rendering — then
    // the step that took the batch in moves that same card to shown.
    const cardId = broadcasts[0]?.id;
    expect(broadcasts).toEqual([
      {
        type: 'signal_card', id: cardId, state: 'pending',
        metadata: {
          kinuEvent: 'event_drain', kinuAuthor: 'harness',
          drainTurnId: injected[0]!.replyTurnId!,
        },
        text: injected[0]!.stepText,
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
    expect(absorb(orch)).toHaveLength(0);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.metadata?.kinuEvent).toBe('event_drain');
    // Same card, same moment: the queued path is not a silent one. The turn
    // this signal starts flips it, and it names that card on its own metadata.
    const signalId = v.parse(v.string(), enqueued[0]?.metadata?.signalId);
    expect(broadcasts).toEqual([{
      type: 'signal_card', id: signalId, state: 'pending',
      metadata: {
        kinuEvent: 'event_drain', kinuAuthor: 'harness',
        drainTurnId: expect.any(String),
      },
      text: enqueued[0]!.text,
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

    // The ingress pattern: publish, then scheduleDrain — a burst of three.
    for (let i = 0; i < 3; i++) {
      log.publish({ descriptor: webhook(`d${i}`, { seq: i }), now: i + 1 });
      orch.scheduleDrain();
    }
    expect(timers).toHaveLength(1);                  // calls 2..3 absorbed
    expect(enqueued).toHaveLength(0);                // nothing drains inside the window

    await timers[0]!.fn();                           // the window fires
    expect(enqueued).toHaveLength(1);                // ONE coalesced turn…
    const drainTurnId = v.parse(v.string(), enqueued[0]?.metadata?.drainTurnId);
    const bound = log.query({ turn_id: drainTurnId });
    expect(bound).toHaveLength(3);                   // …binding all three events
  });

  test('a schedule after the window fired opens a second window → a second turn', async () => {
    const log = newEventLog();
    const { engine } = fakeEngine();
    const { host, enqueued, timers } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: log });

    log.publish({ descriptor: webhook('a', { seq: 'a' }), now: 1 });
    orch.scheduleDrain();
    await timers[0]!.fn();
    log.publish({ descriptor: webhook('b', { seq: 'b' }), now: 2 });
    orch.scheduleDrain();
    await timers[1]!.fn();
    expect(enqueued).toHaveLength(2);
  });

  test('a window firing with nothing pending injects no turn', async () => {
    const { engine } = fakeEngine();
    const { host, enqueued, timers } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.scheduleDrain();
    await timers[0]!.fn();
    expect(enqueued).toHaveLength(0);                // buildDrainBatch null → no enqueueTurn
  });
});

describe('AgentOrchestrator — the in-episode evolution clock', () => {
  /** Drive one settled `execute_tools` call through the orchestrator's own
   *  per-turn extension, which is the seam both backends register. */
  function runBlock(orch: AgentOrchestrator, code: string, failure?: string): void {
    orch.turnExtension.onToolResult?.({
      toolName: 'execute_tools',
      args: { code },
      result: failure ?? 'ok',
      success: failure === undefined,
    });
  }

  test('the turn extension is the seam — a crafted tool is scored mid-turn', () => {
    const { engine, crafted, observed } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());

    runBlock(orch, 'return await tools.summarize(1)');

    expect(observed).toHaveLength(1);
    expect(observed[0]!.names).toEqual(['summarize']);
    // No turn boundary, no user message, no cadence — the score is already in.
    expect(orch.craft.snapshot()).toEqual({
      crafted: [], invoked: ['summarize'], reused: [], returned: 1, raised: 0, dropped: [],
    });
  });

  test('a stamped failure is scored against the tool through the same seam', () => {
    const { engine, crafted, observed } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());

    runBlock(orch, 'return await tools.summarize(1)', '[crafted:summarize] boom');
    expect(observed).toEqual([{ names: ['summarize'], quality: 0.1 }]);
    expect(orch.craft.snapshot()!.raised).toBe(1);

    // …and a failure that names nothing scores nothing.
    runBlock(orch, 'return await tools.summarize(1)', 'TypeError: x is not a function');
    expect(observed).toHaveLength(1);
  });

  test('a tool that appeared during the turn is crafted, not pre-existing', () => {
    const { engine, crafted, observed } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.beginTurn(Date.now());

    crafted.push('summarize');
    runBlock(orch, 'await workspace.createTool("summarize","d","async()=>1"); return tools.summarize(1)');
    // Created and called in one breath earns nothing…
    expect(observed).toEqual([]);
    expect(orch.craft.snapshot()!.crafted).toEqual(['summarize']);

    // …and the next block that reaches for it closes the loop.
    runBlock(orch, 'return await tools.summarize(2)');
    expect(observed).toHaveLength(1);
    expect(orch.craft.snapshot()!.reused).toEqual(['summarize']);
  });

  test('with auto-evolution off the in-episode clock records nothing', () => {
    const { engine, crafted, observed } = fakeEngine({ enabled: false });
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());

    runBlock(orch, 'return await tools.summarize(1)');

    expect(observed).toEqual([]);
    expect(orch.craft.snapshot()).toBeNull();
  });

  test('beginTurn clears the previous turn\'s craft record', () => {
    const { engine, crafted } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    crafted.push('summarize');
    orch.beginTurn(Date.now());
    runBlock(orch, 'return await tools.summarize(1)');
    expect(orch.craft.snapshot()).not.toBeNull();

    orch.beginTurn(Date.now());
    expect(orch.craft.snapshot()).toBeNull();
  });

  test('turn steering still observes the same calls through the shared seam', () => {
    const { engine } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    orch.beginTurn(Date.now());
    for (let i = 0; i < 3; i++) {
      orch.turnExtension.onToolCall?.({ toolName: 'run', args: { command: `x${i}` } });
      orch.turnExtension.onToolResult?.({
        toolName: 'run', args: { command: `x${i}` }, result: `Error: no ${i}`, success: false,
      });
    }
    expect(orch.steering.steerFor({ stepNumber: 4, messages: [] })).not.toBeNull();
  });
});
