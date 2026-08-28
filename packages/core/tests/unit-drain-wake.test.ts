/**
 * The durable half of the reactor's wake.
 *
 * A pending event is a promise the workspace made to itself. Until this
 * existed, the only thing keeping that promise was an in-memory debounce
 * timer — so an event admitted seconds before an eviction, or handed back by a
 * compensating signal, sat in `agent_log` with nothing scheduled to look at it
 * again, and waited for the next unrelated ingress.
 *
 * Two invariants, and both are about ORDER rather than end state, so both cases
 * hold the transition open and observe it mid-flight:
 *
 *   1. A fresh unbound reaction yields a wake time. Derived from the same rows
 *      the drain selects, so the wake and the work cannot disagree.
 *   2. Compensation re-establishes it. A host that refuses the signal turn
 *      returns the events to pending, and the re-arm is what makes them
 *      reachable again.
 *
 * The negative control is the self-emitted event: it must yield NO wake, or
 * "there is always a wake" would satisfy every assertion here and the agent
 * would alarm itself in a loop over its own output.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentOrchestrator, type AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import {
  EventLog, initEventsHubTables, type IngressDescriptor,
} from '../src/events/hub/index';
import { initCompletedTurnTable, createCompletedTurnStore } from '../src/evolution/session-window';
import { createTestSql } from '@kinu.run/test-utils';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import { makeSqlExec } from './helpers';

function newEventLog(): EventLog {
  const sql = makeSqlExec(new Database(':memory:'));
  initEventsHubTables(sql);
  return new EventLog(sql);
}

/** An external delivery — the kind that must wake a turn. */
function webhook(deliveryId: string): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body: { x: 1 }, delivery_id: deliveryId },
    auth_outcome: 'verified', webhook_id: 'w1',
  };
}

/** The agent's own emission — the anti-self-wake-loop case. */
function selfEmitted(): IngressDescriptor {
  return {
    ingress: 'self_emit', variant: 'internal', emitting_head_trust: 'self',
    payload: { kind: 'note', data: 'wrote the parser' },
  };
}

/**
 * A host that records both halves of the wake and can refuse the turn.
 *
 * `setTimer` NEVER runs the callback: the debounce is exactly the in-memory
 * mechanism under test, so a harness that fired it would drain the events and
 * hide whether anything durable had been armed.
 */
function watchedHost(opts: { refuse?: boolean } = {}) {
  const enqueued: ProgrammaticTurn[] = [];
  const debounces: number[] = [];
  let durableArms = 0;
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (input) => {
      enqueued.push(input);
      return { status: opts.refuse === true ? 'skipped' : 'queued' };
    },
    turnInFlight: () => false,
    setTimer: (_fn, ms) => { debounces.push(ms); },
    reconcileDurableWake: () => { durableArms++; },
  };
  return { host, enqueued, debounces, durableArms: () => durableArms };
}

function inertEngine(): AgentOrchestratorDeps['engine'] {
  const { sql, execRaw } = createTestSql();
  initCompletedTurnTable(execRaw, sql);
  const store = createCompletedTurnStore(sql);
  return {
    enabled: false,
    sessionWindow: store,
    craftLedger: { names: () => [], observe: () => [] },
    reviewTurn: async () => {},
    onSessionComplete: async () => {},
    runDueShadowTrials: async () => {},
    recordRecovery: () => {},
    deferTurnReview: (turn, followup, opts) => store.enqueueReview(turn, followup, opts),
    runDeferredTurnReviews: async () => ({ reviewed: 0, refused: [] }),
    runStoredTurnReview: async () => {},
  };
}

describe('a pending reaction always has a durable successor wake', () => {
  test('a fresh unbound reaction is due now — nothing has looked at it yet', () => {
    const log = newEventLog();
    const now = 1_700_000_000_000;

    expect(log.nextPendingDrainAt(now)).toBeNull();
    log.publish({ descriptor: webhook('d1'), now });

    expect(log.nextPendingDrainAt(now)).toBe(now);
  });

  /** The negative control. Without it, "a wake exists" is vacuously true. */
  test("the agent's own emission wakes nothing", () => {
    const log = newEventLog();
    const now = 1_700_000_000_000;
    log.publish({ descriptor: selfEmitted(), now });

    expect(log.pending()).toHaveLength(1);
    expect(log.nextPendingDrainAt(now)).toBeNull();
  });

  test('a bound reaction has no wake of its own — a turn already owes it', () => {
    const log = newEventLog();
    const now = 1_700_000_000_000;
    const { id } = log.publish({ descriptor: webhook('d1'), now });
    log.markConsumed(id, 'evt-1', 0, now);

    expect(log.nextPendingDrainAt(now)).toBeNull();
  });

  test('a deferred reaction names its own moment, and the wake is that moment', () => {
    const log = newEventLog();
    const now = 1_700_000_000_000;
    const { id } = log.publish({ descriptor: webhook('d1'), now });
    log.defer(id, { kind: 'at', ts: now + 60_000 });

    expect(log.nextPendingDrainAt(now)).toBe(now + 60_000);
    // …and once its moment has passed it is ordinary pending work.
    expect(log.nextPendingDrainAt(now + 60_000)).toBe(now + 60_000);
  });

  test('the soonest of several deferred moments wins', () => {
    const log = newEventLog();
    const now = 1_700_000_000_000;
    const late = log.publish({ descriptor: webhook('late'), now });
    const soon = log.publish({ descriptor: webhook('soon'), now });
    log.defer(late.id, { kind: 'at', ts: now + 600_000 });
    log.defer(soon.id, { kind: 'at', ts: now + 30_000 });

    expect(log.nextPendingDrainAt(now)).toBe(now + 30_000);
  });
});

describe('every drain path re-establishes the wake', () => {
  test('admitting work arms the durable wake, not only the in-memory debounce', () => {
    const log = newEventLog();
    const { host, durableArms, debounces } = watchedHost();
    const orch = new AgentOrchestrator({ host, engine: inertEngine(), eventLog: log });

    orch.scheduleDrain();

    // Both halves, from one call: the debounce coalesces this burst, the arm is
    // what survives the activation.
    expect(debounces).toHaveLength(1);
    expect(durableArms()).toBe(1);
  });

  /**
   * The compensation case, held at the exact boundary the defect lived on.
   *
   * The refusal arrives AFTER the events were bound to the synthetic turn, so
   * at the moment compensation runs the rows are consumed and unreachable. The
   * unbind returns them; the re-arm is what makes returning them mean
   * anything. Asserted against the arm count taken just before the refusal, so
   * the admission arm above cannot be mistaken for this one.
   */
  test('a refused signal turn returns its events to pending AND re-arms the wake', async () => {
    const log = newEventLog();
    const now = Date.now();
    log.publish({ descriptor: webhook('d1'), now });
    const { host, enqueued, durableArms } = watchedHost({ refuse: true });
    const orch = new AgentOrchestrator({ host, engine: inertEngine(), eventLog: log });
    const armsBefore = durableArms();

    await orch.drainPendingEvents();

    // The host was asked, and refused.
    expect(enqueued).toHaveLength(1);
    // The row is pending again…
    expect(log.pending()).toHaveLength(1);
    expect(log.nextPendingDrainAt(now)).not.toBeNull();
    // …and something is now scheduled to come back for it.
    expect(durableArms()).toBeGreaterThan(armsBefore);
  });

  test('an accepted signal turn leaves its events bound and owes no second wake', async () => {
    const log = newEventLog();
    const now = Date.now();
    log.publish({ descriptor: webhook('d1'), now });
    const orch = new AgentOrchestrator({
      host: watchedHost().host, engine: inertEngine(), eventLog: log,
    });

    await orch.drainPendingEvents();

    expect(log.pending()).toEqual([]);
    expect(log.nextPendingDrainAt(now)).toBeNull();
  });
});
