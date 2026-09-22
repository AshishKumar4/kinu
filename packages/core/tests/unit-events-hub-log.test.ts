import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  boundEventQuery, buildDrainBatch, initEventsHubTables, EventLog,
  type IngressDescriptor,
} from '../src/events/hub/index';
import type { SqlExec } from '../src/index';

/** Page policy is read from `boundEventQuery`, not restated, so the suite cannot drift from it. */
const DEFAULT_PAGE = boundEventQuery().limit;

const UNTRUSTED_CEILING = boundEventQuery({ limit: Number.MAX_SAFE_INTEGER }).limit;

import type { JsonValue } from '../src/utils/json';
import { createRecordingLogger, setDiagnosticsSink, KinuError } from '../src/obs/index';
import { makeSqlExec } from './helpers';
import { createTestActorsOver } from '@kinu.run/test-utils';
import type { ActorHandle } from '../src/identity/actor-handle';

/** `EventLog` is actor-scoped, so the fixture binds the one actor through the production directory. */
interface Hub {
  readonly sql: SqlExec;
  readonly actor: ActorHandle;
}

function makeSql(): Hub {
  const db = new Database(':memory:');

  return { sql: makeSqlExec(db), actor: createTestActorsOver(db).main };
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

  test('first publish admits; second publish with same dedupe key is idempotent', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const r1 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1000 });
    expect(r1.admitted).toBe(true);
    const r2 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1500 });
    expect(r2.admitted).toBe(false);
    expect(r2.id).toBe(r1.id);
  });

  test('different bodies → different keys → both admit', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const r1 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1000 });
    const r2 = log.publish({ descriptor: webhookDescriptor('d2', { x: 2 }), now: 1001 });
    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(true);
    expect(r1.id).not.toBe(r2.id);
  });

  test('chat events are NOT deduped (null dedupe_key)', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const r1 = log.publish({ descriptor: chatDescriptor('hi'), now: 1 });
    const r2 = log.publish({ descriptor: chatDescriptor('hi'), now: 2 });
    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(true);
    expect(r1.id).not.toBe(r2.id);
  });
});

describe('EventLog.pending', () => {
  test('returns events unbound to a turn, ordered by priority desc', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    log.publish({ descriptor: webhookDescriptor('w1', { x: 1 }), now: 1 });  // background (external? no — authenticated → normal)
    log.publish({ descriptor: chatDescriptor('urgent!'), now: 2 });          // owner chat → urgent
    const pending = log.pending();
    expect(pending.length).toBe(2);
    expect(pending[0].variant).toBe('chat');       // urgent first
    expect(pending[1].variant).toBe('webhook');
  });

  test('binding an event removes it from pending', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const { id } = log.publish({ descriptor: chatDescriptor('hi'), now: 1 });
    expect(log.pending()).toHaveLength(1);
    log.markConsumed(id, 'turn-1', 0);
    expect(log.pending()).toHaveLength(0);
  });

  test('startup reconciliation re-pends only stale unfinished drain leases', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
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
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const first = log.publish({ descriptor: chatDescriptor('first'), now: 1 }).id;
    const second = log.publish({ descriptor: chatDescriptor('second'), now: 2 }).id;
    log.markConsumed(first, 'evt-first', 0, 1_000);
    log.markConsumed(second, 'evt-second', 0, 1_000);

    expect(new Set(log.unbindStale(500, 2_000))).toEqual(new Set([first, second]));
    expect(new Set(log.pending().map((event) => event.id))).toEqual(new Set([first, second]));
  });

  test('protected cross-owner peer payloads retain delegated Plan mode', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
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
          kinu_mode: 'plan',
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
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const { id } = log.publish({ descriptor: chatDescriptor('later'), now: 1 });
    log.defer(id, { kind: 'after_phase', phase: 'idle' });
    expect(log.pending()).toHaveLength(0);  // not in normal pending
    const withDeferred = log.pending({ resolve_deferred: { now: 100, phase: 'idle' } });
    expect(withDeferred).toHaveLength(1);
    expect(withDeferred[0].id).toBe(id);
  });

  test('dismiss removes the event from pending permanently', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const { id } = log.publish({ descriptor: chatDescriptor('drop'), now: 1 });
    log.dismiss(id, 'no longer relevant', 'tool');
    expect(log.pending()).toHaveLength(0);
    expect(log.pending({ resolve_deferred: { now: 100, phase: 'idle' } })).toHaveLength(0);
  });
});

describe('EventLog audit + non-event rows', () => {
  test('appendNonEventRow writes step/tool_call/etc. rows', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

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
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
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
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const r1 = log.publish({ descriptor: webhookDescriptor('d1', { x: 1 }), now: 1 });
    log.publish({ descriptor: webhookDescriptor('d2', { x: 2 }), now: 2, caused_by: r1.id });
    expect(log.traceEventCount(r1.id)).toBeGreaterThanOrEqual(1);
  });
});

// KINU-N019: `query`/`pending` clamp every caller to a finite positive integer before SQL;
// `boundEventQuery` owns the ceiling for untrusted callers.
function seededLog(count: number): EventLog {
  const { sql, actor } = makeSql();
  initEventsHubTables(sql);
  const log = new EventLog(sql, actor);

  for (let i = 0; i < count; i++) {
    log.publish({ descriptor: chatDescriptor(`event ${i}`), now: 1000 + i });
  }

  return log;
}

describe('EventLog.query admits only a finite positive integer limit', () => {
  test('a negative limit reads one row, never the whole table', () => {
    const log = seededLog(DEFAULT_PAGE + 40);
    expect(log.query({ limit: -1 })).toHaveLength(1);
    expect(log.query({ limit: -999999 })).toHaveLength(1);
  });

  test('zero raises to one row rather than reading an empty page', () => {
    // `LIMIT 0` returns nothing, which reads as an empty log.
    expect(seededLog(40).query({ limit: 0 })).toHaveLength(1);
  });

  test('a non-finite limit means unstated and takes the default', () => {
    // `?limit=abc` parses to NaN, which SQLite rejects as a datatype mismatch.
    const log = seededLog(DEFAULT_PAGE + 40);
    expect(log.query({ limit: Number.NaN })).toHaveLength(DEFAULT_PAGE);
    expect(log.query({ limit: Number.POSITIVE_INFINITY }))
      .toHaveLength(DEFAULT_PAGE);
    expect(log.query({ limit: Number.NEGATIVE_INFINITY }))
      .toHaveLength(DEFAULT_PAGE);
  });

  test('an absent limit takes the default page', () => {
    expect(seededLog(DEFAULT_PAGE + 40).query({}))
      .toHaveLength(DEFAULT_PAGE);
  });

  test('a fractional limit truncates instead of failing the query', () => {
    const log = seededLog(40);
    expect(log.query({ limit: 2.7 })).toHaveLength(2);
    expect(log.query({ limit: 0.5 })).toHaveLength(1);
  });

  test('an in-object window wider than the untrusted ceiling is honoured', () => {
    // No ceiling here: `query` is also the in-object read, which gets the window it states.
    const log = seededLog(UNTRUSTED_CEILING + 60);
    expect(log.query({ limit: UNTRUSTED_CEILING + 60 }))
      .toHaveLength(UNTRUSTED_CEILING + 60);
  });

  test('a legitimate limit is still honoured exactly', () => {
    expect(seededLog(120).query({ limit: 37 })).toHaveLength(37);
  });

  test('a variant filter does not reopen the bound', () => {
    const log = seededLog(40);
    expect(log.query({ variant: 'chat', limit: -1 })).toHaveLength(1);
  });
});

describe('EventLog.pending admits only a finite positive integer limit', () => {

  test('a negative limit reads one row, never the whole table', () => {
    const log = seededLog(DEFAULT_PAGE + 40);
    expect(log.pending({ limit: -1 })).toHaveLength(1);
    expect(log.pending({ limit: -999999 })).toHaveLength(1);
  });

  test('zero, non-finite and absent limits behave like the query read', () => {
    // No public accessor for the pending default, so assert the property, not the number.
    const seeded = DEFAULT_PAGE + 40;
    const log = seededLog(seeded);
    expect(log.pending({ limit: 0 })).toHaveLength(1);
    const unstated = log.pending().length;
    expect(unstated).toBeGreaterThan(1);
    expect(unstated).toBeLessThan(seeded);
    expect(log.pending({ limit: Number.NaN })).toHaveLength(unstated);
    expect(log.pending({ limit: Number.POSITIVE_INFINITY })).toHaveLength(unstated);
  });

  test('an in-object window wider than the untrusted ceiling is honoured', () => {
    const log = seededLog(UNTRUSTED_CEILING + 60);
    expect(log.pending({ limit: UNTRUSTED_CEILING + 60 }))
      .toHaveLength(UNTRUSTED_CEILING + 60);
  });
});

describe('boundEventQuery is the one policy the boundary applies', () => {
  test('it closes the bounds and leaves the rest of the query alone', () => {
    expect(boundEventQuery({ limit: -1, since: -5, variant: 'chat' }))
      .toEqual({ limit: 1, since: 0, variant: 'chat' });
  });

  test('an empty query states nothing and takes both defaults', () => {
    expect(boundEventQuery()).toEqual({ since: 0, limit: DEFAULT_PAGE });
  });

  test('it caps what the log alone would honour', () => {
    // A window the in-object read is trusted with is refused to a stranger.
    expect(boundEventQuery({ limit: 1e9 }).limit).toBe(UNTRUSTED_CEILING);
    expect(boundEventQuery({ limit: UNTRUSTED_CEILING + 60 }).limit)
      .toBe(UNTRUSTED_CEILING);
    expect(boundEventQuery({ limit: Number.NaN }).limit).toBe(DEFAULT_PAGE);
    expect(boundEventQuery({ limit: 2.7 }).limit).toBe(2);
  });
});

describe('EventLog skips corrupt payload rows', () => {
  test('one unreadable payload is reported with its row id and the rest is returned', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const bad = log.publish({ descriptor: chatDescriptor('bad'), now: 1 }).id;
    const good = log.publish({ descriptor: chatDescriptor('good'), now: 2 }).id;
    sql.exec(`UPDATE agent_log SET payload = ? WHERE id = ?`, 'not-json{{{', bad);
    const rec = createRecordingLogger();
    const restore = setDiagnosticsSink(rec);

    try {
      // Both reads, because either one throwing takes the whole drain with it.
      expect(log.pending().map((event) => event.id)).toEqual([good]);
      expect(log.query({}).map((event) => event.id)).toEqual([good]);
    } finally {
      restore();
    }

    expect(rec.emitted.map((line) => [line.event, line.fields])).toEqual([
      ['event.row_unreadable', { id: bad }],
      ['event.row_unreadable', { id: bad }],
    ]);
  });

  test('an aborted decode propagates instead of reading as an empty drain', () => {
    const { sql, actor } = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    log.publish({ descriptor: chatDescriptor('good'), now: 1 });
    const realParse = JSON.parse;
    JSON.parse = function parseAbort(): never {
      throw new KinuError('cancelled', 'injected abort');
    };

    try {
      // A cancelled decode is the caller's abort: it throws with its class intact, never "no events".
      let pendingPropagated = false;

      try { log.pending(); } catch (error) {
        if (!(error instanceof KinuError)) throw error;
        expect(error.code).toBe('cancelled');
        pendingPropagated = true;
      }

      expect(pendingPropagated).toBe(true);
      let queryPropagated = false;

      try { log.query({}); } catch (error) {
        if (!(error instanceof KinuError)) throw error;
        expect(error.code).toBe('cancelled');
        queryPropagated = true;
      }

      expect(queryPropagated).toBe(true);
    } finally {
      JSON.parse = realParse;
    }
  });
});
