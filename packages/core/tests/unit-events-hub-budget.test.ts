// ReactorBudget — per-turn / per-trace / per-source / per-hour caps.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initEventsHubTables, ReactorBudget,
} from '../src/events/hub/index.ts';

function makeSql() {
  const db = new Database(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.query(query);
      const rows = stmt.all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
}

describe('ReactorBudget', () => {
  test('within all caps → check.ok=true', async () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const b = new ReactorBudget(sql, {
      per_turn_invocations: 3,
      per_trace_invocations: 5,
      per_hour_agent_invocations: 60,
      per_hour_user_tokens: 100_000,
      per_source_invocations: 10,
    });
    const r = await b.check({ turn_id: 't1', trace_id: 'tr1', source_key: 'sk', now: 1000 });
    expect(r.ok).toBe(true);
  });

  test('per_turn cap enforces', async () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const b = new ReactorBudget(sql, {
      per_turn_invocations: 2,
      per_trace_invocations: 100,
      per_hour_agent_invocations: 100,
      per_hour_user_tokens: 100_000,
      per_source_invocations: 100,
    });
    b.record({ turn_id: 't1', trace_id: 'tr', source_key: 's', outcome: 'decided', now: 1 });
    b.record({ turn_id: 't1', trace_id: 'tr', source_key: 's', outcome: 'decided', now: 2 });
    const r = await b.check({ turn_id: 't1', trace_id: 'tr', source_key: 's', now: 3 });
    expect(r.ok).toBe(false);
    expect(r.exhausted_axis).toBe('per_turn_invocations');
  });

  test('per_source cap enforces', async () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const b = new ReactorBudget(sql, {
      per_turn_invocations: 100,
      per_trace_invocations: 100,
      per_hour_agent_invocations: 100,
      per_hour_user_tokens: 100_000,
      per_source_invocations: 1,
    });
    b.record({ turn_id: 't1', trace_id: 'tr', source_key: 'flood', outcome: 'decided', now: 1 });
    const r = await b.check({ turn_id: 't1', trace_id: 'tr', source_key: 'flood', now: 2 });
    expect(r.ok).toBe(false);
    expect(r.exhausted_axis).toBe('per_source_invocations');
    // But a different source still fits.
    const r2 = await b.check({ turn_id: 't1', trace_id: 'tr', source_key: 'other', now: 3 });
    expect(r2.ok).toBe(true);
  });

  test('snapshot returns remaining counts', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const b = new ReactorBudget(sql, {
      per_turn_invocations: 3,
      per_trace_invocations: 5,
      per_hour_agent_invocations: 60,
      per_hour_user_tokens: 100_000,
      per_source_invocations: 10,
    });
    b.record({ turn_id: 't1', trace_id: 'tr', source_key: 's', outcome: 'decided', now: 1 });
    const snap = b.snapshot('t1', 'tr', 100);
    expect(snap.per_turn).toBe(2);
    expect(snap.per_trace).toBe(4);
    expect(snap.per_hour).toBe(59);
  });
});
