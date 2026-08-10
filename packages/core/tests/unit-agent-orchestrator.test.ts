// AgentOrchestrator — the backend-agnostic per-turn logic (re-arch P3). Verifies
// the session-evolution cadence + the event→turn reactor (drain-then-stop) that
// were extracted from the cf-backend OrchestratorAgent's onChatResponse.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestSql } from '@proteus/test-utils';
import { AgentOrchestrator } from '../src/orchestrator/agent-orchestrator.js';
import { initSessionWindowTable, createSessionWindowStore } from '../src/evolution/session-window.js';
import { initEventsHubTables, EventLog, type IngressDescriptor } from '../src/events/hub/index.js';
import type { BackendHost, BroadcastEvent, ProgrammaticTurn } from '../src/types/backend-host.js';
import type { AgentSignal } from '../src/types/signals.js';
import type { EvolutionEngine } from '../src/evolution/engine.js';
import type { CompletedTurn } from '../src/evolution/types.js';
import type { SqlExec } from '../src/index.js';

function makeSql(): SqlExec {
  const db = new Database(':memory:');
  return {
    exec(query, ...bindings) {
      const rows = db.query(query).all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
}
function newEventLog(): EventLog {
  const sql = makeSql();
  initEventsHubTables(sql as never);
  return new EventLog(sql as never);
}
function webhook(deliveryId: string, body: Record<string, unknown> = { x: 1 }): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body, delivery_id: deliveryId },
    auth_outcome: 'verified', webhook_id: 'w1',
  } as IngressDescriptor;
}

/** A stand-in engine over a REAL in-memory session window — the store the
 *  engine owns in production, so the cadence is exercised against the durable
 *  buffer rather than orchestrator-instance state. */
function fakeEngine() {
  const reviews: Array<{ turn: CompletedTurn; followup: string | null }> = [];
  const sessions: number[] = [];
  const { sql, execRaw } = createTestSql();
  initSessionWindowTable(execRaw);
  const engine = {
    enabled: true,
    sessionWindow: createSessionWindowStore(sql),
    reviewTurn: async (turn: CompletedTurn, followup: string | null) => { reviews.push({ turn, followup }); },
    onSessionComplete: async (s: { turns: CompletedTurn[] }) => { sessions.push(s.turns.length); },
  } as unknown as EvolutionEngine;
  return { engine, reviews, sessions };
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
  orch.turnExtension.prepareStep!({ stepNumber: 0, messages: [{ role: 'user', content: 'q' }] });
  return orch.signals.settle({ completed: true }).absorbed;
}
const aTurn = (i: number, origin: 'user' | 'programmatic' = 'user'): CompletedTurn => ({
  userMessage: `t${i}`, assistantResponse: 'r', toolCalls: [], durationMs: 1, steps: 1,
  hadError: false, feedback: null, turnId: `m${i}`, origin,
});

describe('AgentOrchestrator.recordTurn — session cadence', () => {
  test('session reflection fires every N turns', async () => {
    const { engine, sessions } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), sessionReflectionInterval: 3 });
    for (let i = 0; i < 7; i++) {
      orch.recordTurn(aTurn(i), 'conversation');
      // The pass claims the window and settles it only once it has run, so a
      // second pass cannot start while the first is live. Real turns are
      // minutes apart; the test just lets the pass finish.
      await orch.runDueSessionEvolution();
    }
    expect(sessions).toEqual([3, 3]);         // reflected at turn 3 and 6 (window closes)
    expect(orch.sessionTurnIndex).toBe(1);    // 7th turn left 1 in the new window
  });

  test('a partial window survives the session ending — it is not force-closed or graded', async () => {
    const { engine, reviews, sessions } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), sessionReflectionInterval: 5 });
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
    (engine as unknown as { onSessionComplete: (s: { turns: CompletedTurn[] }) => Promise<void> })
      .onSessionComplete = async (s) => { await gate; sessions.push(s.turns.length); };
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), sessionReflectionInterval: 2 });
    orch.recordTurn(aTurn(0), 'conversation');
    const pass = orch.runDueSessionEvolution();
    orch.recordTurn(aTurn(1), 'conversation');
    expect(sessions).toEqual([]);            // still in flight
    // The turn lane settles without waiting for the cadence lane — that is the
    // whole point: one exec invocation must not own a lifetime cycle's clock.
    await orch.settleEvolution();
    expect(sessions).toEqual([]);
    release();
    await pass;
    expect(sessions).toEqual([2]);
  });

  test('a one-shot host never STARTS the cadence pass — the window carries to the daemon', async () => {
    const { engine, sessions } = fakeEngine();
    const { host } = fakeHost();
    const eventLog = newEventLog();
    const oneShot = new AgentOrchestrator({ host, engine, eventLog, sessionReflectionInterval: 2, oneShot: true });
    oneShot.recordTurn(aTurn(0), 'independent_task');
    oneShot.recordTurn(aTurn(1), 'independent_task');
    await oneShot.settleEvolution();
    expect(sessions).toEqual([]);                    // nothing ran in the exec process
    expect(oneShot.sessionTurnIndex).toBe(2);        // and nothing was consumed

    // The daemon (a host that can afford the work) picks up the SAME turns.
    const daemon = new AgentOrchestrator({ host, engine, eventLog, sessionReflectionInterval: 2 });
    await daemon.runDueSessionEvolution();
    expect(sessions).toEqual([2]);
    expect(daemon.sessionTurnIndex).toBe(0);
  });

  test('settleEvolution abandons the turn lane at its bound rather than waiting forever', async () => {
    const { engine } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({
      host, engine, eventLog: newEventLog(), settleTimeoutMs: 10,
    });
    let release = () => {};
    const stuck = new Promise<void>((resolve) => { release = resolve; });
    orch.track(stuck, 'Shadow eval');
    const startedAt = Date.now();
    await orch.settleEvolution();                    // returns on the bound, not on `stuck`
    expect(Date.now() - startedAt).toBeLessThan(2000);
    release();
    await stuck;
  });

  test('with auto-evolution off, a turn leaves no evolution state at all', () => {
    const { engine, reviews, sessions } = fakeEngine();
    (engine as unknown as { enabled: boolean }).enabled = false;
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), sessionReflectionInterval: 2 });
    orch.recordTurn(aTurn(0), 'conversation');
    orch.recordTurn(aTurn(1), 'conversation');
    orch.observeUserTurn('anything', 'conversation');
    expect(sessions).toEqual([]);
    expect(reviews).toEqual([]);
    expect(orch.sessionTurnIndex).toBe(0);           // nothing for a later host to evolve
  });
});

describe('AgentOrchestrator — the durable session window', () => {
  // `proteus exec` is one process per turn: a fresh orchestrator every time,
  // against the same workspace database. The window and the pending review
  // have to live in that database or headless usage never evolves at all.
  test('the window accumulates across orchestrator instances and fires at the interval', () => {
    const { engine, sessions } = fakeEngine();
    const eventLog = newEventLog();
    for (let i = 0; i < 5; i++) {
      const { host } = fakeHost();
      new AgentOrchestrator({ host, engine, eventLog, sessionReflectionInterval: 5 })
        .recordTurn(aTurn(i), 'conversation');
    }
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

  test('a one-shot turn is graded NOW on execution signal — never parked for the next task', () => {
    const { engine, reviews } = fakeEngine();
    const eventLog = newEventLog();
    const { host } = fakeHost();
    const exec = new AgentOrchestrator({ host, engine, eventLog, oneShot: true });
    exec.recordTurn(aTurn(0), 'independent_task');
    // Reviewed immediately, with NO follow-up: the environment's verdict is the
    // only evidence, and it is all in already.
    expect(reviews).toEqual([{ turn: aTurn(0), followup: null }]);
    // Nothing is left waiting, so the next invocation's unrelated prompt has
    // nothing to be misread as a verdict on.
    new AgentOrchestrator({ host, engine, eventLog, oneShot: true })
      .observeUserTurn('a completely different task', 'independent_task');
    expect(reviews).toHaveLength(1);
  });

  test('a turn parked by a conversation is NOT graded from a one-shot prompt', () => {
    const { engine, reviews } = fakeEngine();
    const eventLog = newEventLog();
    const { host } = fakeHost();
    new AgentOrchestrator({ host, engine, eventLog }).recordTurn(aTurn(0), 'conversation');
    // `proteus exec` against the same workspace: its prompt is a fresh task
    // written by a caller who never saw turn 0's answer.
    new AgentOrchestrator({ host, engine, eventLog, oneShot: true })
      .observeUserTurn('unrelated task', 'independent_task');
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
    expect(enqueued[0].text).toContain('arrived');        // the turn-driving message
    expect(enqueued[0].text).toContain('[webhook]');
    // The injected turn is marked programmatic and carries the synthetic turn
    // id the consumed events were bound to — the backend's reply-dispatch key.
    expect(enqueued[0].metadata?.proteusEvent).toBe('event_drain');
    const drainTurnId = enqueued[0].metadata?.drainTurnId;
    expect(typeof drainTurnId).toBe('string');
    // d1/d2 share a body → webhook dedupe admits one event; it is bound here.
    const bound = log.query({ turn_id: drainTurnId as string });
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
    const cardId = (broadcasts[0] as { id: string }).id;
    expect(broadcasts).toEqual([
      {
        type: 'signal_card', id: cardId, state: 'pending',
        metadata: { proteusEvent: 'event_drain', drainTurnId: injected[0]!.replyTurnId! },
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
    expect(enqueued[0]!.metadata?.proteusEvent).toBe('event_drain');
    // Same card, same moment: the queued path is not a silent one. The turn
    // this signal starts flips it, and it names that card on its own metadata.
    expect(broadcasts).toEqual([{
      type: 'signal_card', id: enqueued[0]!.metadata!.signalId, state: 'pending',
      metadata: { proteusEvent: 'event_drain', drainTurnId: expect.any(String) },
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
    expect(log.query({ turn_id: enqueued[1]!.metadata?.drainTurnId as string }).map((event) => event.id))
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
    const bound = log.query({ turn_id: enqueued[0]!.metadata?.drainTurnId as string });
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
