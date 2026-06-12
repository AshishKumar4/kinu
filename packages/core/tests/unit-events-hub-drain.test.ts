// buildDrainBatch — pick externally-triggered pending events for one autonomous
// turn, excluding the agent's own self-emitted/internal events (anti-self-wake).
import { describe, test, expect } from 'bun:test';
import { buildDrainBatch } from '../src/events/hub/index.ts';
import type { ProteusEvent } from '../src/events/hub/index.ts';

function evt(id: string, over: Partial<ProteusEvent>): ProteusEvent {
  return {
    id, trace_id: 'tid', caused_by: null,
    ingress: 'webhook_hmac', variant: 'webhook', trust: 'authenticated',
    priority: 'normal', payload_visibility: 'full',
    received_at: 0, schema_version: 1, reply_channel: null, dedupe_key: null,
    payload: { http_method: 'POST', body: {}, webhook_id: 'w', http_headers: {}, delivery_id: 'd' },
    ...over,
  } as ProteusEvent;
}

describe('buildDrainBatch', () => {
  test('returns null when nothing is pending', () => {
    expect(buildDrainBatch([])).toBeNull();
  });

  test('excludes self_emit and internal events (anti-self-wake loop)', () => {
    const events = [
      evt('a', { ingress: 'self_emit', variant: 'internal', payload: { note: 'x' } }),
      evt('b', { variant: 'internal', ingress: 'sandbox_cb', payload: { note: 'y' } }),
    ];
    expect(buildDrainBatch(events)).toBeNull();
  });

  test('batches external events with their ids and a turn-driving message', () => {
    const events = [
      evt('wh1', { variant: 'webhook', ingress: 'webhook_hmac' }),
      evt('tm1', { variant: 'timer', ingress: 'timer_alarm', payload: { label: 'daily' } }),
    ];
    const batch = buildDrainBatch(events)!;
    expect(batch).not.toBeNull();
    expect(batch.ids).toEqual(['wh1', 'tm1']);
    expect(batch.text).toContain('2 events arrived');
    expect(batch.text).toContain('[webhook]');
    expect(batch.text).toContain('[timer]');
  });

  test('mixes external + self → only external drains', () => {
    const events = [
      evt('ext', { variant: 'webhook', ingress: 'webhook_hmac' }),
      evt('self', { ingress: 'self_emit', variant: 'internal', payload: { note: 'z' } }),
    ];
    const batch = buildDrainBatch(events)!;
    expect(batch.ids).toEqual(['ext']);
    expect(batch.text).toContain('1 event arrived');
  });
});
