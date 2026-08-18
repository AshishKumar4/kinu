// EventLog — publish + pending + defer + dismiss + query.
// In-memory SQLite via bun:sqlite as the storage backend.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  buildDrainBatch, initEventsHubTables, EventLog, type IngressDescriptor,
} from '../src/events/hub/index';
import type { SqlExec } from '../src/index';
import type { JsonValue } from '../src/utils/json';
import { makeSqlExec } from './helpers';

function makeSql(): SqlExec {
  return makeSqlExec(new Database(':memory:'));
}

function chatDescriptor(text: string): IngressDescriptor {
  return {
    ingress: 'chat_ws', variant: 'chat',
    payload: { text }, operator_user_id: 'u', session_id: 's',
  };
}

function webhookDescriptor(deliveryId: string, body: JsonValue): IngressDescriptor {
  return {
    ingress: 'webhook_hmac', variant: 'webhook',
    payload: {
      webhook_id: 'w1', http_method: 'POST', http_headers: {}, body, delivery_id: deliveryId,
    },
    auth_outcome: 'verified', webhook_id: 'w1',
  };
}

describe('EventLog.publish + dedupe', () => {
  test('schema initialization adds the recovery lease column to legacy agent_log tables', () => {
    const sql = makeSql();
    sql.exec(`CREATE TABLE agent_log (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, turn_id TEXT, step_idx INTEGER,
      parent_id TEXT, trace_id TEXT NOT NULL, ingress TEXT, variant TEXT,
      trust TEXT, priority TEXT, payload_visibility TEXT, payload TEXT NOT NULL,
      received_at INTEGER NOT NULL, schema_version INTEGER NOT NULL, dedupe_key TEXT
    )`);
    initEventsHubTables(sql);
    const columns = v.parse(
      v.array(v.object({ name: v.string() })),
      sql.exec(`PRAGMA table_info(agent_log)`).toArray(),
    );
    expect(columns.some((column) => column.name === 'consumed_at')).toBe(true);
  });

  test('first publish admits; second publish with same dedupe key is idempotent', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const r1 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1000 });
    expect(r1.admitted).toBe(true);
    const r2 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1500 });
    expect(r2.admitted).toBe(false);
    expect(r2.id).toBe(r1.id);
  });

  test('different bodies → different keys → both admit', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const r1 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1000 });
    const r2 = log.publish({ descriptor: webhookDescriptor('d2', { x: 2 }), now: 1001 });
    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(true);
    expect(r1.id).not.toBe(r2.id);
  });

  test('chat events are NOT deduped (null dedupe_key)', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const r1 = log.publish({ descriptor: chatDescriptor('hi'), now: 1 });
    const r2 = log.publish({ descriptor: chatDescriptor('hi'), now: 2 });
    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(true);
    expect(r1.id).not.toBe(r2.id);
  });
});

describe('EventLog.pending', () => {
  test('returns events unbound to a turn, ordered by priority desc', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    log.publish({ descriptor: webhookDescriptor('w1', { x: 1 }), now: 1 });  // background (external? no — authenticated → normal)
    log.publish({ descriptor: chatDescriptor('urgent!'), now: 2 });          // owner chat → urgent
    const pending = log.pending();
    expect(pending.length).toBe(2);
    expect(pending[0].variant).toBe('chat');       // urgent first
    expect(pending[1].variant).toBe('webhook');
  });

  test('binding an event removes it from pending', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const { id } = log.publish({ descriptor: chatDescriptor('hi'), now: 1 });
    expect(log.pending()).toHaveLength(1);
    log.markConsumed(id, 'turn-1', 0);
    expect(log.pending()).toHaveLength(0);
  });

  test('startup reconciliation re-pends only stale unfinished drain leases', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const stale = log.publish({ descriptor: chatDescriptor('stale'), now: 1 }).id;
    const completed = log.publish({ descriptor: chatDescriptor('completed'), now: 2 }).id;
    const fresh = log.publish({ descriptor: chatDescriptor('fresh'), now: 3 }).id;

    log.markConsumed(stale, 'evt-stale', 0, 1_000);
    log.markConsumed(completed, 'evt-completed', 0, 1_000);
    log.markTurnCompleted('evt-completed');
    log.markConsumed(fresh, 'evt-fresh', 0, 1_900);

    expect(log.unbindStale(500, 2_000)).toEqual([stale]);
    expect(log.pending().map((event) => event.id)).toEqual([stale]);
    expect(log.query({ turn_id: 'evt-completed' }).map((event) => event.id)).toEqual([completed]);
    expect(log.query({ turn_id: 'evt-fresh' }).map((event) => event.id)).toEqual([fresh]);
  });

  test('startup reconciliation atomically re-pends every qualifying lease', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const first = log.publish({ descriptor: chatDescriptor('first'), now: 1 }).id;
    const second = log.publish({ descriptor: chatDescriptor('second'), now: 2 }).id;
    log.markConsumed(first, 'evt-first', 0, 1_000);
    log.markConsumed(second, 'evt-second', 0, 1_000);

    expect(new Set(log.unbindStale(500, 2_000))).toEqual(new Set([first, second]));
    expect(new Set(log.pending().map((event) => event.id))).toEqual(new Set([first, second]));
  });

  test('protected cross-owner peer payloads retain delegated Plan mode', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    log.publish({
      descriptor: {
        ingress: 'peer_async',
        variant: 'peer_agent',
        payload: {
          from_agent_name: 'planner',
          from_user_id: 'another-owner',
          topic: 'research',
          body: { task: 'inspect only' },
          sender_event_id: 'outbox-1',
          proteus_mode: 'plan',
        },
        same_owner: false,
        receiver_grant_present: true,
      },
      now: 2_000,
    });

    const pending = log.pending();
    expect(pending[0]?.payload_visibility).toBe('hash');
    expect(buildDrainBatch(pending)?.mode).toBe('plan');
  });
});

describe('EventLog.defer + dismiss', () => {
  test('defer puts event into deferred pool, surfaced when condition met', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const { id } = log.publish({ descriptor: chatDescriptor('later'), now: 1 });
    log.defer(id, { kind: 'after_phase', phase: 'idle' });
    expect(log.pending()).toHaveLength(0);  // not in normal pending
    const withDeferred = log.pending({ resolve_deferred: { now: 100, phase: 'idle' } });
    expect(withDeferred).toHaveLength(1);
    expect(withDeferred[0].id).toBe(id);
  });

  test('dismiss removes the event from pending permanently', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const { id } = log.publish({ descriptor: chatDescriptor('drop'), now: 1 });
    log.dismiss(id, 'no longer relevant', 'tool');
    expect(log.pending()).toHaveLength(0);
    expect(log.pending({ resolve_deferred: { now: 100, phase: 'idle' } })).toHaveLength(0);
  });
});

describe('EventLog audit + non-event rows', () => {
  test('appendNonEventRow writes step/tool_call/etc. rows', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const id = log.appendNonEventRow({
      kind: 'step',
      turn_id: 'turn-1', step_idx: 0, parent_id: null, trace_id: 'trace-1',
      payload: { finished: true, tool_call_count: 0 },
      now: 1,
    });
    expect(id.length).toBeGreaterThan(0);
    const steps = log.turnSteps('turn-1');
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('step');
  });

  test('currentPhase reads the latest phase row for a turn', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    log.appendNonEventRow({
      kind: 'phase', turn_id: 't1', step_idx: null, parent_id: null, trace_id: 't1',
      payload: { phase: 'linear' }, now: 100,
    });
    log.appendNonEventRow({
      kind: 'phase', turn_id: 't1', step_idx: null, parent_id: null, trace_id: 't1',
      payload: { phase: 'heads' }, now: 200,
    });
    expect(log.currentPhase('t1')?.phase).toBe('heads');
  });
});

describe('EventLog.traceEventCount', () => {
  test('counts events on a trace', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const r1 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1 });
    log.publish({ descriptor: webhookDescriptor('d2', { x: 2 }), now: 2, caused_by: r1.id });
    expect(log.traceEventCount(r1.id)).toBeGreaterThanOrEqual(1);
  });
});
