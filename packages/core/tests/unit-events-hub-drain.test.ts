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
      evt('a', { ingress: 'self_emit', variant: 'internal', payload: { kind: 'note', data: 'x' } }),
      evt('b', { variant: 'internal', ingress: 'sandbox_cb', payload: { kind: 'note', data: 'y' } }),
    ];
    expect(buildDrainBatch(events)).toBeNull();
  });

  test('batches external events with their ids and a turn-driving message', () => {
    const events = [
      evt('wh1', { variant: 'webhook', ingress: 'webhook_hmac' }),
      evt('tm1', { variant: 'timer', ingress: 'timer_alarm', payload: { trigger_id: 'trg-daily', scheduled_fire_at: 0, label: 'daily' } }),
    ];
    const batch = buildDrainBatch(events)!;
    expect(batch).not.toBeNull();
    expect(batch.ids).toEqual(['wh1', 'tm1']);
    expect(batch.text).toContain('2 events arrived');
    expect(batch.text).toContain('[webhook]');
    expect(batch.text).toContain('[timer]');
  });

  test('the same batch renders a mid-turn variant that folds in instead of stopping', () => {
    const batch = buildDrainBatch([evt('wh1', { variant: 'webhook', ingress: 'webhook_hmac' })])!;
    expect(batch.text).toContain('arrived while you were idle');
    expect(batch.text).toContain('then stop');
    expect(batch.midTurnText).toContain('arrived while you were working');
    expect(batch.midTurnText).toContain('Before finishing this response');
    expect(batch.midTurnText).toContain('[webhook]');
    expect(batch.midTurnText).not.toContain('then stop');
  });

  test('mixes external + self → only external drains', () => {
    const events = [
      evt('ext', { variant: 'webhook', ingress: 'webhook_hmac' }),
      evt('self', { ingress: 'self_emit', variant: 'internal', payload: { kind: 'note', data: 'z' } }),
    ];
    const batch = buildDrainBatch(events)!;
    expect(batch.ids).toEqual(['ext']);
    expect(batch.text).toContain('1 event arrived');
  });
});

describe('buildDrainBatch — peer messages', () => {
  const peer = (id: string, over: Record<string, unknown> = {}): ProteusEvent => evt(id, {
    ingress: 'peer_async', variant: 'peer_agent', trust: 'authenticated',
    payload: {
      from_agent_name: 'scout', from_user_id: 'u1', topic: 'research',
      body: 'What changed upstream?', sender_event_id: 'ox1', ...over,
    },
  } as Partial<ProteusEvent>);

  test('an ask renders the mechanical reply route (peers reply + event id)', () => {
    const batch = buildDrainBatch([peer('pe1', { reply_expected: true })])!;
    expect(batch.text).toContain('[peer_agent] from peer agent (scout)');
    expect(batch.text).toContain('What changed upstream?');
    expect(batch.text).toContain("peers({action:'reply', event_id:'pe1'");
  });

  test('a fire-and-forget message carries no reply instruction', () => {
    const batch = buildDrainBatch([peer('pe2')])!;
    expect(batch.text).toContain('[peer_agent]');
    expect(batch.text).not.toContain("action:'reply'");
  });
});
