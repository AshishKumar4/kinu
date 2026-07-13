// The subordinate event spine — parent↔facet task/report admission.
// Mirrors the same-owner peer class: trust `authenticated`; assignments wake
// the subordinate promptly (`normal`), reports roll into the orchestrator's
// next turn (`background`). Round-trips a real EventLog publish → pending →
// drain to pin the whole admission shape, not just the derivation table.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  deriveEventTrust, derivePriority, deriveFields,
  EventLog, initEventsHubTables, buildDrainBatch, dedupeKeyFor,
  type IngressDescriptor, type ProteusEvent,
  type SubordinateTaskPayload, type SubordinateReportPayload,
} from '../src/events/hub/index.ts';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

function makeSql(): SqlExec {
  const db = new Database(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        const rows = stmt.all(...bindings as never[]) as Array<Record<string, unknown>>;
        return { toArray: () => rows };
      }
      stmt.run(...bindings as never[]);
      return { toArray: () => [] };
    },
  };
}

const taskPayload: SubordinateTaskPayload = {
  from_workspace: 'jarvis',
  kind: 'task',
  body: 'Survey the auth module and report the seams.',
  deliverable: 'a findings note in /workspace/notes/auth.md',
};

const reportPayload: SubordinateReportPayload = {
  from_subordinate: 'researcher',
  status: 'completed',
  content: 'Survey done — three seams found; note written.',
  task: 'Survey the auth module',
};

const taskDescriptor: IngressDescriptor = {
  ingress: 'subordinate', variant: 'subordinate_task', payload: taskPayload,
};
const reportDescriptor: IngressDescriptor = {
  ingress: 'subordinate', variant: 'subordinate_report', payload: reportPayload,
};

describe('subordinate event derivation', () => {
  test('subordinate ingress → authenticated (the same-owner peer class)', () => {
    expect(deriveEventTrust(taskDescriptor)).toBe('authenticated');
    expect(deriveEventTrust(reportDescriptor)).toBe('authenticated');
  });

  test('tasks wake promptly, reports roll to the next turn', () => {
    expect(derivePriority('authenticated', 'subordinate_task')).toBe('normal');
    expect(derivePriority('authenticated', 'subordinate_report')).toBe('background');
  });

  test('deriveFields stamps the full admission triple', () => {
    expect(deriveFields(taskDescriptor)).toEqual({
      trust: 'authenticated', priority: 'normal', payload_visibility: 'redact',
    });
    expect(deriveFields(reportDescriptor)).toEqual({
      trust: 'authenticated', priority: 'background', payload_visibility: 'redact',
    });
  });

  test('no dedupe key — one-shot same-machine facet RPC', () => {
    const asEvent = (variant: 'subordinate_task' | 'subordinate_report', payload: unknown) => ({
      id: 'e', trace_id: 'e', caused_by: null, ingress: 'subordinate', variant,
      trust: 'authenticated', priority: 'normal', payload_visibility: 'redact',
      received_at: 0, schema_version: 1, reply_channel: null, dedupe_key: null, payload,
    } as ProteusEvent);
    expect(dedupeKeyFor(asEvent('subordinate_task', taskPayload))).toBeNull();
    expect(dedupeKeyFor(asEvent('subordinate_report', reportPayload))).toBeNull();
  });
});

describe('subordinate event admission (EventLog round-trip)', () => {
  test('a published task admits, pends, and drains with the workspace source line', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);

    const { id, admitted } = log.publish({ descriptor: taskDescriptor, now: 1000 });
    expect(admitted).toBe(true);

    const pending = log.pending();
    expect(pending).toHaveLength(1);
    const event = pending[0];
    expect(event.id).toBe(id);
    expect(event.variant).toBe('subordinate_task');
    expect(event.trust).toBe('authenticated');
    expect(event.priority).toBe('normal');

    const batch = buildDrainBatch(pending);
    expect(batch).not.toBeNull();
    expect(batch!.ids).toEqual([id]);
    expect(batch!.text).toContain('workspace orchestrator (jarvis)');
    expect(batch!.text).toContain('task: Survey the auth module');
    expect(batch!.text).toContain('deliverable:');
  });

  test('a published report admits and drains with the subordinate source line', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);

    const { admitted } = log.publish({ descriptor: reportDescriptor, now: 1000 });
    expect(admitted).toBe(true);

    const batch = buildDrainBatch(log.pending());
    expect(batch).not.toBeNull();
    expect(batch!.text).toContain('subordinate (researcher)');
    expect(batch!.text).toContain('completed');
    expect(batch!.text).toContain('[re: Survey the auth module]');
    // Reports are not peer asks — no mechanical reply hint.
    expect(batch!.text).not.toContain('event_id');
  });

  test('binding a task to a turn removes it from pending (drain contract)', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const { id } = log.publish({ descriptor: taskDescriptor, now: 1000 });
    log.markConsumed(id, 'evt-turn-1', 0);
    expect(log.pending()).toHaveLength(0);
    expect(log.query({ turn_id: 'evt-turn-1' })).toHaveLength(1);
  });
});
