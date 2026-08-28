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
  type IngressDescriptor, type KinuEvent,
  type SubordinateTaskPayload, type SubordinateReportPayload,
} from '../src/events/hub/index';
import type { SqlExec } from '../src/index';
import { makeSqlExec } from './helpers';

function makeSql(): SqlExec {
  return makeSqlExec(new Database(':memory:'));
}

const taskPayload: SubordinateTaskPayload = {
  from_workspace: 'jarvis',
  kind: 'task',
  body: 'Survey the auth module and report the seams.',
  deliverable: 'a findings note in /workspace/notes/auth.md',
  kinu_mode: 'build',
};

const reportPayload: SubordinateReportPayload = {
  from_subordinate: 'researcher',
  status: 'completed',
  content: 'Survey done — three seams found; note written.',
  sequence_id: 'settle:msg-77',
  task: 'Survey the auth module',
  kinu_mode: 'build',
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

  test('a report is keyed by the sending sequence; an assignment down is not keyed', () => {
    const base = {
      id: 'e', trace_id: 'e', caused_by: null, ingress: 'subordinate',
      trust: 'authenticated', priority: 'normal', payload_visibility: 'redact',
      received_at: 0, schema_version: 1, reply_channel: null, dedupe_key: null,
    } satisfies Pick<KinuEvent,
      'id' | 'trace_id' | 'caused_by' | 'ingress' | 'trust' | 'priority'
      | 'payload_visibility' | 'received_at' | 'schema_version' | 'reply_channel' | 'dedupe_key'>;
    const taskEvent: KinuEvent = { ...base, variant: 'subordinate_task', payload: taskPayload };
    const reportEvent: KinuEvent = { ...base, variant: 'subordinate_report', payload: reportPayload };
    // An assignment DOWN is a one-shot facet RPC with no redelivery loop.
    expect(dedupeKeyFor(taskEvent)).toBeNull();
    // A report UP is replayable durable work on the sending side, so its
    // sequence is the key that recognises the replay.
    expect(dedupeKeyFor(reportEvent)).toBe('subordinate_report:settle:msg-77');
    expect(dedupeKeyFor({
      ...reportEvent,
      payload: { ...reportPayload, content: 'a later retry re-worded it' },
    })).toBe(dedupeKeyFor(reportEvent));
    expect(dedupeKeyFor({
      ...reportEvent,
      payload: { ...reportPayload, sequence_id: 'settle:msg-78' },
    })).not.toBe(dedupeKeyFor(reportEvent));
  });
});

describe('one report per sequence on the parent rail', () => {
  test('a replayed report lands on the row the first delivery wrote', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);

    const first = log.publish({ descriptor: reportDescriptor, now: 1000 });
    const replay = log.publish({ descriptor: reportDescriptor, now: 5000 });

    expect(first.admitted).toBe(true);
    expect(replay).toEqual({ id: first.id, admitted: false });
    expect(log.pending({ variant: 'subordinate_report' })).toHaveLength(1);
    expect(log.idForDedupeKey('subordinate_report:settle:msg-77')).toBe(first.id);
  });

  test('two sequences are two reports', () => {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);

    log.publish({ descriptor: reportDescriptor, now: 1000 });
    log.publish({
      descriptor: {
        ingress: 'subordinate', variant: 'subordinate_report',
        payload: { ...reportPayload, sequence_id: 'settle:msg-78' },
      },
      now: 1001,
    });

    expect(log.pending({ variant: 'subordinate_report' })).toHaveLength(2);
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
