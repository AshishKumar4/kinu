// Subagent admission: trust `authenticated`; assignments pend at `normal`, reports at
// `background`, and only reports may be taken by a reactor.
import { describe, test, expect } from 'bun:test';
import { buildDrainBatch } from '../src/events/hub/drain';
import { EventLog } from '../src/events/hub/log';
import { initEventsHubTables } from '../src/events/hub/schema';
import { deriveEventTrust, derivePriority, deriveFields } from '../src/events/hub/trust';
import type { IngressDescriptor, SubagentTaskPayload, SubagentReportPayload } from '../src/events/hub/types';
import { memoryHub } from './helpers';
import { present } from '@kinu.run/test-utils';

/** `EventLog` is actor-scoped, so the fixture binds the one actor through the production directory. */

const taskPayload: SubagentTaskPayload = {
  from_workspace: 'jarvis',
  kind: 'task',
  body: 'Survey the auth module and report the seams.',
  deliverable: 'a findings note in /workspace/notes/auth.md',
  kinu_mode: 'build',
};

const reportPayload: SubagentReportPayload = {
  from_subagent: 'researcher',
  status: 'completed',
  content: 'Survey done — three seams found; note written.',
  sequence_id: 'settle:msg-77',
  task: 'Survey the auth module',
  kinu_mode: 'build',
};

const taskDescriptor: IngressDescriptor = {
  ingress: 'subagent', variant: 'subagent_task', payload: taskPayload,
};

const reportDescriptor: IngressDescriptor = {
  ingress: 'subagent', variant: 'subagent_report', payload: reportPayload,
};

describe('subagent event derivation', () => {
  test('subagent ingress → authenticated (the same-owner peer class)', () => {
    expect(deriveEventTrust(taskDescriptor)).toBe('authenticated');
    expect(deriveEventTrust(reportDescriptor)).toBe('authenticated');
  });

  test('tasks wake promptly, reports roll to the next turn', () => {
    expect(derivePriority('authenticated', 'subagent_task')).toBe('normal');
    expect(derivePriority('authenticated', 'subagent_report')).toBe('background');
  });

  test('deriveFields stamps the full admission triple', () => {
    expect(deriveFields(taskDescriptor)).toEqual({
      trust: 'authenticated', priority: 'normal', payload_visibility: 'redact',
    });
    expect(deriveFields(reportDescriptor)).toEqual({
      trust: 'authenticated', priority: 'background', payload_visibility: 'redact',
    });
  });
});

describe('one report per sequence on the parent rail', () => {
  test('a replayed report lands on the row the first delivery wrote', () => {
    const { sql, actor } = memoryHub();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    const first = log.publish({ descriptor: reportDescriptor, now: 1000 });
    const replay = log.publish({ descriptor: reportDescriptor, now: 5000 });

    expect(first.admitted).toBe(true);
    expect(replay).toEqual({ id: first.id, admitted: false });
    expect(log.pending({ variant: 'subagent_report' })).toHaveLength(1);
    expect(log.idForDedupeKey('subagent_report:settle:msg-77')).toBe(first.id);
  });

  test('two sequences are two reports', () => {
    const { sql, actor } = memoryHub();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    log.publish({ descriptor: reportDescriptor, now: 1000 });
    log.publish({
      descriptor: {
        ingress: 'subagent', variant: 'subagent_report',
        payload: { ...reportPayload, sequence_id: 'settle:msg-78' },
      },
      now: 1001,
    });

    expect(log.pending({ variant: 'subagent_report' })).toHaveLength(2);
  });
});

describe('subagent event admission (EventLog round-trip)', () => {
  test('a published task admits and pends, and no drain may take it', () => {
    const { sql, actor } = memoryHub();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    const { id, admitted } = log.publish({ descriptor: taskDescriptor, now: 1000 });
    expect(admitted).toBe(true);

    const pending = log.pending();
    expect(pending).toHaveLength(1);
    const event = pending[0];
    expect(event.id).toBe(id);
    expect(event.variant).toBe('subagent_task');
    expect(event.trust).toBe('authenticated');
    expect(event.priority).toBe('normal');

    // The reactor refuses an assignment: a drain would reduce the brief to one summary line.
    expect(buildDrainBatch(pending)).toBeNull();
  });

  test('a published report admits and drains with the subagent source line', () => {
    const { sql, actor } = memoryHub();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);

    const { admitted } = log.publish({ descriptor: reportDescriptor, now: 1000 });
    expect(admitted).toBe(true);

    const batch = present(buildDrainBatch(log.pending()), 'the drain batch');

    expect(batch.text).toContain('subagent (researcher)');
    expect(batch.text).toContain('completed');
    expect(batch.text).toContain('[re: Survey the auth module]');
    // Reports are not peer asks — no mechanical reply hint.
    expect(batch.text).not.toContain('event_id');
  });

  test('binding a task to a turn removes it from pending (drain contract)', () => {
    const { sql, actor } = memoryHub();
    initEventsHubTables(sql);
    const log = new EventLog(sql, actor);
    const { id } = log.publish({ descriptor: taskDescriptor, now: 1000 });
    log.markConsumed(id, 'evt-turn-1', 0);
    expect(log.pending()).toHaveLength(0);
    expect(log.query({ turn_id: 'evt-turn-1' })).toHaveLength(1);
  });
});
