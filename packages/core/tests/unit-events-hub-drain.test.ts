// buildDrainBatch — pick externally-triggered pending events for one autonomous
// turn, excluding the agent's own self-emitted/internal events (anti-self-wake).
import { describe, test, expect } from 'bun:test';
import { buildDrainBatch } from '../src/events/hub/index.ts';
import type { BaseEvent, IngressKind, PeerAgentPayload, ProteusEvent } from '../src/events/hub/index.ts';

const EVENT_BASE = {
  trace_id: 'tid', caused_by: null, trust: 'authenticated', priority: 'normal',
  received_at: 0, schema_version: 1, reply_channel: null, dedupe_key: null,
} satisfies Omit<BaseEvent, 'id' | 'ingress' | 'variant' | 'payload_visibility'>;

function webhook(id: string): ProteusEvent {
  return {
    ...EVENT_BASE, id, ingress: 'webhook_hmac', variant: 'webhook', payload_visibility: 'full',
    payload: { http_method: 'POST', body: {}, webhook_id: 'w', http_headers: {}, delivery_id: 'd' },
  };
}

function internal(id: string, ingress: Extract<IngressKind, 'self_emit' | 'sandbox_cb'>, data: string): ProteusEvent {
  return {
    ...EVENT_BASE, id, ingress, variant: 'internal', payload_visibility: 'full',
    payload: { kind: 'note', data },
  };
}

function timer(id: string): ProteusEvent {
  return {
    ...EVENT_BASE, id, ingress: 'timer_alarm', variant: 'timer', payload_visibility: 'full',
    payload: { trigger_id: 'trg-daily', scheduled_fire_at: 0, label: 'daily' },
  };
}

function peer(id: string, replyExpected = false): ProteusEvent {
  const payload = {
    from_agent_name: 'scout', from_user_id: 'u1', topic: 'research',
    body: 'What changed upstream?', sender_event_id: 'ox1', proteus_mode: 'build',
  } satisfies PeerAgentPayload;
  return replyExpected
    ? {
        ...EVENT_BASE, id, ingress: 'peer_async', variant: 'peer_agent', payload_visibility: 'full',
        payload: { ...payload, reply_expected: true },
      }
    : {
        ...EVENT_BASE, id, ingress: 'peer_async', variant: 'peer_agent', payload_visibility: 'full',
        payload,
      };
}

describe('buildDrainBatch', () => {
  test('returns null when nothing is pending', () => {
    expect(buildDrainBatch([])).toBeNull();
  });

  test('excludes self_emit and internal events (anti-self-wake loop)', () => {
    const events = [
      internal('a', 'self_emit', 'x'),
      internal('b', 'sandbox_cb', 'y'),
    ];
    expect(buildDrainBatch(events)).toBeNull();
  });

  test('batches external events with their ids and a turn-driving message', () => {
    const events = [
      webhook('wh1'),
      timer('tm1'),
    ];
    const batch = buildDrainBatch(events)!;
    expect(batch).not.toBeNull();
    expect(batch.ids).toEqual(['wh1', 'tm1']);
    expect(batch.text).toContain('2 events arrived');
    expect(batch.text).toContain('[webhook]');
    expect(batch.text).toContain('[timer]');
  });

  test('the same batch renders a mid-turn variant that folds in instead of stopping', () => {
    const batch = buildDrainBatch([webhook('wh1')])!;
    expect(batch.text).toContain('arrived while you were idle');
    expect(batch.text).toContain('then stop');
    expect(batch.midTurnText).toContain('arrived while you were working');
    expect(batch.midTurnText).toContain('Before finishing this response');
    expect(batch.midTurnText).toContain('[webhook]');
    expect(batch.midTurnText).not.toContain('then stop');
  });

  test('mixes external + self → only external drains', () => {
    const events = [
      webhook('ext'),
      internal('self', 'self_emit', 'z'),
    ];
    const batch = buildDrainBatch(events)!;
    expect(batch.ids).toEqual(['ext']);
    expect(batch.text).toContain('1 event arrived');
  });
});

describe('buildDrainBatch — peer messages', () => {
  test('an ask renders the mechanical reply route (peers reply + event id)', () => {
    const batch = buildDrainBatch([peer('pe1', true)])!;
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
