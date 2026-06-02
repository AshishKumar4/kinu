// AgentOrchestrator — the backend-agnostic per-turn logic (re-arch P3). Verifies
// the session-evolution cadence + the event→turn reactor (drain-then-stop) that
// were extracted from the cf-backend OrchestratorAgent's onChatResponse.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentOrchestrator } from '../src/orchestrator/agent-orchestrator.js';
import { initEventsHubTables, EventLog, type IngressDescriptor } from '../src/events/hub/index.js';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host.js';
import type { EvolutionEngine } from '../src/evolution/engine.js';
import type { CompletedTurn } from '../src/evolution/types.js';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}
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
function webhook(deliveryId: string): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: { webhook_id: 'w1', http_method: 'POST', http_headers: {}, body: { x: 1 }, delivery_id: deliveryId },
    auth_outcome: 'verified', webhook_id: 'w1',
  } as IngressDescriptor;
}

function fakeEngine() {
  const turns: CompletedTurn[] = [];
  const sessions: number[] = [];
  const engine = {
    onTurnCompleteAsync: (t: CompletedTurn) => { turns.push(t); },
    onSessionComplete: async (s: { turns: CompletedTurn[] }) => { sessions.push(s.turns.length); },
  } as unknown as EvolutionEngine;
  return { engine, turns, sessions };
}
function fakeHost() {
  const enqueued: ProgrammaticTurn[] = [];
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (i) => { enqueued.push(i); return { status: 'queued' }; },
  };
  return { host, enqueued };
}
const aTurn = (i: number): CompletedTurn => ({
  task: `t${i}`, response: 'r', toolCalls: [], quality: 1, durationMs: 1, steps: 1, hadError: false, feedback: null,
} as unknown as CompletedTurn);

describe('AgentOrchestrator.recordTurn — session cadence', () => {
  test('fires turn evolution every turn; session reflection every N turns', () => {
    const { engine, turns, sessions } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), sessionReflectionInterval: 3 });
    for (let i = 0; i < 7; i++) orch.recordTurn(aTurn(i));
    expect(turns).toHaveLength(7);            // every turn
    expect(sessions).toEqual([3, 3]);         // reflected at turn 3 and 6 (count resets)
    expect(orch.sessionTurnIndex).toBe(1);    // 7th turn left 1 in the new window
  });

  test('flushSession reflects a partial window (CLI exit); no-op when empty', async () => {
    const { engine, sessions } = fakeEngine();
    const { host } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog(), sessionReflectionInterval: 5 });
    for (let i = 0; i < 2; i++) orch.recordTurn(aTurn(i));   // below the interval — no auto reflection
    expect(sessions).toEqual([]);
    await orch.flushSession();
    expect(sessions).toEqual([2]);                            // the 2 buffered turns reflected
    expect(orch.sessionTurnIndex).toBe(0);                    // window reset
    await orch.flushSession();                                // nothing buffered now
    expect(sessions).toEqual([2]);                            // still just the one
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

    // Events are now consumed → a second drain is a no-op (self-terminates).
    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(1);
  });

  test('no pending events → no turn injected (idle reactor)', async () => {
    const { engine } = fakeEngine();
    const { host, enqueued } = fakeHost();
    const orch = new AgentOrchestrator({ host, engine, eventLog: newEventLog() });
    await orch.drainPendingEvents();
    expect(enqueued).toHaveLength(0);
  });
});
