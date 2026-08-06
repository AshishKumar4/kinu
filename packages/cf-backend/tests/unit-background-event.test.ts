// A turn the reactor enqueued is not the operator speaking. The classifier
// decides which messages lose the user bubble, and the parser recovers the
// events from the prompt the drain wrapped around them.
import { describe, test, expect } from 'bun:test';
import { buildDrainBatch } from '@proteus/core';
import type { ProteusEvent } from '@proteus/core';
import {
  classifyProgrammaticTurn, eventVariantLabel, parseDrainedEvents,
} from '../src/components/background-event.ts';

describe('programmatic turn provenance', () => {
  test('reactor drains and background-job wakes are not the user talking', () => {
    expect(classifyProgrammaticTurn({ proteusEvent: 'event_drain', drainTurnId: 't1' }))
      .toEqual({ kind: 'event_drain' });
    expect(classifyProgrammaticTurn({ proteusEvent: 'background_job', kind: 'research', status: 'failed' }))
      .toEqual({ kind: 'background_job', jobKind: 'research', status: 'failed' });
  });

  test('a background-job wake without its kind/status still classifies', () => {
    expect(classifyProgrammaticTurn({ proteusEvent: 'background_job' }))
      .toEqual({ kind: 'background_job', jobKind: 'task', status: 'completed' });
  });

  test('the operator\'s own words keep the user bubble', () => {
    // `mcp` is the operator through an MCP client; `take_pick` and
    // `overflow_retry` are mechanical re-sends of what they already said.
    expect(classifyProgrammaticTurn({ proteusEvent: 'mcp' })).toBeNull();
    expect(classifyProgrammaticTurn({ proteusEvent: 'take_pick' })).toBeNull();
    expect(classifyProgrammaticTurn({ proteusEvent: 'overflow_retry' })).toBeNull();
    expect(classifyProgrammaticTurn(undefined)).toBeNull();
    expect(classifyProgrammaticTurn({})).toBeNull();
    expect(classifyProgrammaticTurn('event_drain')).toBeNull();
  });
});

/* The drain text the UI parses is composed by core's buildDrainBatch — these
   cases feed real events through it so the parser cannot drift from it. */
function event(over: Partial<ProteusEvent>): ProteusEvent {
  return {
    id: over.id ?? 'ev-1',
    ts: 0,
    ingress: 'webhook_hmac',
    variant: 'webhook',
    payload: { http_method: 'POST', body: { ok: true } },
    payload_visibility: 'full',
    trust: 'untrusted',
    consumed_by_turn: null,
    ...over,
  } as ProteusEvent;
}

describe('drained event parsing', () => {
  test('a subordinate report is recovered as variant / source / brief', () => {
    const batch = buildDrainBatch([event({
      ingress: 'subordinate',
      variant: 'subordinate_report',
      payload: { from_subordinate: 'surface-auditor', status: 'progress', task: 'Audit the CLI', content: 'Found 3 gaps' },
    })])!;
    expect(parseDrainedEvents(batch.text)).toEqual([{
      variant: 'subordinate_report',
      source: 'subordinate (surface-auditor)',
      brief: 'progress [re: Audit the CLI]: Found 3 gaps',
      replyExpected: false,
    }]);
  });

  test('the instruction line is dropped, and every event in a batch is kept', () => {
    const batch = buildDrainBatch([
      event({ id: 'a' }),
      event({
        id: 'b', ingress: 'email_inbound', variant: 'email',
        payload: { from: 'ops@example.com', subject: 'Deploy failed', body_text: 'exit 1' },
      }),
    ])!;
    const parsed = parseDrainedEvents(batch.text);
    expect(batch.text.startsWith('2 events arrived while you were idle')).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.variant)).toEqual(['webhook', 'email']);
    expect(parsed[1]!.source).toBe('email (ops@example.com)');
    expect(parsed[1]!.brief).toBe('"Deploy failed": exit 1');
  });

  test('a peer ask is flagged as awaiting a reply, and the hint stays out of the brief', () => {
    const batch = buildDrainBatch([event({
      id: 'p1', ingress: 'peer_async', variant: 'peer_agent',
      payload: { from_agent_name: 'atlas', topic: 'schema', body: 'which shape?', reply_expected: true },
    })])!;
    const [parsed] = parseDrainedEvents(batch.text);
    expect(parsed!.replyExpected).toBe(true);
    expect(parsed!.source).toBe('peer agent (atlas)');
    expect(parsed!.brief).toBe('schema: "which shape?"');
    expect(parsed!.brief).not.toContain('peers(');
  });

  test('a colon inside the source label does not swallow the brief', () => {
    const batch = buildDrainBatch([event({
      id: 't1', ingress: 'timer_alarm', variant: 'timer',
      payload: { label: 'background-job-wake:job-7', trigger_id: 'x', scheduled_fire_at: 0 },
    })])!;
    expect(parseDrainedEvents(batch.text)).toEqual([{
      variant: 'timer',
      source: 'schedule (background-job-wake:job-7)',
      brief: 'background-job-wake:job-7',
      replyExpected: false,
    }]);
  });

  test('a multi-line brief keeps its continuation lines', () => {
    const batch = buildDrainBatch([event({
      id: 's1', ingress: 'subordinate', variant: 'subordinate_task',
      payload: { kind: 'audit', body: 'check the CLI', inherited_context: 'Context line one.\nContext line two.' },
    })])!;
    const [parsed] = parseDrainedEvents(batch.text);
    expect(parsed!.brief).toBe('Context line one.\nContext line two.\n\naudit: check the CLI');
  });

  test('text that is not a drain listing yields nothing to fabricate a card from', () => {
    expect(parseDrainedEvents('')).toEqual([]);
    expect(parseDrainedEvents('just a sentence')).toEqual([]);
    expect(parseDrainedEvents('- a plain bullet')).toEqual([]);
  });
});

describe('event variant labels', () => {
  test('known variants read as prose, unknown ones are de-snaked not relabelled', () => {
    expect(eventVariantLabel('subordinate_report')).toBe('Subordinate report');
    expect(eventVariantLabel('timer')).toBe('Scheduled trigger');
    expect(eventVariantLabel('some_future_variant')).toBe('some future variant');
  });
});
