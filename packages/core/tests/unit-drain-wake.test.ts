/**
 * Durable half of the reactor's wake: a fresh unbound reaction arms a wake and compensation re-arms
 * it; self-emitted events must not, or the agent alarms itself in a loop.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentOrchestrator, type AgentOrchestratorDeps } from '../src/orchestrator/agent-orchestrator';
import {
  EventLog, initEventsHubTables, type IngressDescriptor,
} from '../src/events/hub/index';
import { initCompletedTurnTable, createCompletedTurnStore } from '../src/evolution/session-window';
import { createTestActors, createTestActorsOver, createTestSql } from '@kinu.run/test-utils';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import { makeSqlExec } from './helpers';

function newEventLog(): EventLog {
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);
  initEventsHubTables(sql);

  // The inbox is one actor's: a subordinate's delivery is never the root's.
  return new EventLog(sql, createTestActorsOver(db).main);
}

function webhook(deliveryId: string): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body: { x: 1 }, delivery_id: deliveryId },
    auth_outcome: 'verified', webhook_id: 'w1',
  };
}

function selfEmitted(): IngressDescriptor {
  return {
    ingress: 'self_emit', variant: 'internal', emitting_head_trust: 'self',
    payload: { kind: 'note', data: 'wrote the parser' },
  };
}

/** `setTimer` never fires: firing would hide whether anything durable was armed. */
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
  initCompletedTurnTable(execRaw);
  const store = createCompletedTurnStore(sql, createTestActors(sql, execRaw).main);

  return {
    enabled: false,
    recordsTurns: false,
    recoverInterruptedWork: () => {},
    recentAdvisorNotes: () => [],
    recordAdvisorNote: () => { throw new Error('This fixture runs no advisor'); },
    hasAdvisorNoteForTurn: () => false,
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

  /** Without this, "a wake exists" is vacuously true. */
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
  test('a host that derives its next wake leaves durable work readable without claiming a platform alarm', async () => {
    const log = newEventLog();
    const { host, durableArms, debounces, enqueued } = watchedHost();
    host.reconcileDurableWake = null;
    const orch = new AgentOrchestrator({ host, engine: inertEngine(), eventLog: log });
    log.publish({ descriptor: webhook('derived-wake'), now: Date.now() });
    orch.scheduleDrain();
    expect(debounces).toHaveLength(1);
    expect(durableArms()).toBe(0);
    expect(log.nextPendingDrainAt(Date.now())).not.toBeNull();
    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(1);
    expect(log.nextPendingDrainAt(Date.now())).toBeNull();
  });

  test('admitting work arms the durable wake, not only the in-memory debounce', () => {
    const log = newEventLog();
    const { host, durableArms, debounces } = watchedHost();
    const orch = new AgentOrchestrator({ host, engine: inertEngine(), eventLog: log });

    orch.scheduleDrain();

    expect(debounces).toHaveLength(1);
    expect(durableArms()).toBe(1);
  });

  /** Counted from just before the refusal, to exclude the admission arm. */
  test('a refused signal turn returns its events to pending AND re-arms the wake', async () => {
    const log = newEventLog();
    const now = Date.now();
    log.publish({ descriptor: webhook('d1'), now });
    const { host, enqueued, durableArms } = watchedHost({ refuse: true });
    const orch = new AgentOrchestrator({ host, engine: inertEngine(), eventLog: log });
    const armsBefore = durableArms();

    await orch.drainPendingEvents();

    expect(enqueued).toHaveLength(1);
    expect(log.pending()).toHaveLength(1);
    expect(log.nextPendingDrainAt(now)).not.toBeNull();
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
