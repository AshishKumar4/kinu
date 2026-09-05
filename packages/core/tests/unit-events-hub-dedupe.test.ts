// Dedupe key derivation per variant — pure function.
import { describe, test, expect } from 'bun:test';
import { dedupeKeyFor } from '../src/events/hub/index';
import type { KinuEvent } from '../src/events/hub/index';

function base(): Extract<KinuEvent, { variant: 'webhook' }> {
  return {
    id: 'eid',
    trace_id: 'tid',
    caused_by: null,
    ingress: 'webhook_hmac',
    variant: 'webhook',
    trust: 'authenticated',
    priority: 'normal',
    payload_visibility: 'redact',
    received_at: 1700000000000,
    schema_version: 1,
    reply_channel: null,
    dedupe_key: null,
    payload: {
      webhook_id: 'github-pr',
      http_method: 'POST',
      http_headers: {},
      body: { action: 'opened', number: 42 },
      delivery_id: 'gh-abc-123',
    },
  };
}

describe('dedupeKeyFor — webhook', () => {
  test('same body within same 5-min bucket → same key', () => {
    const e1 = base();
    const e2 = { ...base(), received_at: 1700000000000 + 60_000 };
    // Hand-derived from the key format: webhook:<id>:<sha256 of the canonical
    // body, 24 hex>:<5-min bucket>. Both land in bucket 5666666.
    expect(dedupeKeyFor(e1)).toBe('webhook:github-pr:ac46861d15eacef1faadbdba:5666666');
    expect(dedupeKeyFor(e2)).toBe(dedupeKeyFor(e1));
  });
  test('different bodies → different keys', () => {
    const e1 = base();
    const e2 = { ...base() };
    e2.payload.body = { action: 'closed' };
    expect(dedupeKeyFor(e1)).not.toBe(dedupeKeyFor(e2));
  });
  test('different time buckets → different keys', () => {
    const e1 = base();
    const e2 = { ...base(), received_at: 1700000000000 + 10 * 60_000 };
    expect(dedupeKeyFor(e1)).not.toBe(dedupeKeyFor(e2));
  });
  test('different webhook_id → different keys even for same body', () => {
    const e1 = base();
    const e2 = { ...base() };
    e2.payload.webhook_id = 'gh-issues';
    expect(dedupeKeyFor(e1)).not.toBe(dedupeKeyFor(e2));
  });
});

describe('dedupeKeyFor — timer', () => {
  test('same trigger + scheduled_fire_at → same key', () => {
    const e: KinuEvent = {
      ...base(),
      ingress: 'timer_alarm',
      variant: 'timer',
      payload: { trigger_id: 't1', scheduled_fire_at: 1700000000000 },
    };
    expect(dedupeKeyFor(e)).toBe('timer:t1:1700000000000');
  });
});

describe('dedupeKeyFor — process_done', () => {
  test('keyed by process_id', () => {
    const e: KinuEvent = {
      ...base(),
      ingress: 'sandbox_cb',
      variant: 'process_done',
      payload: { process_id: 'pid-42', command: 'ls', exit_code: 0, stdout_excerpt: '', stderr_excerpt: '', duration_ms: 0 },
    };
    expect(dedupeKeyFor(e)).toBe('process_done:pid-42');
  });
});

describe('dedupeKeyFor — peer_agent', () => {
  const peer = (sender_event_id: string, topic: string): KinuEvent => ({
    ...base(),
    ingress: 'peer_async',
    variant: 'peer_agent',
    payload: { from_agent_name: 'scout', from_user_id: 'u1', topic, body: 'hi', sender_event_id, kinu_mode: 'build' },
  });
  test('keyed by (sender, sender_event_id) — a crash redelivery is a no-op', () => {
    expect(dedupeKeyFor(peer('ox1', 'status'))).toBe('peer:scout:ox1');
  });
  test('repeated topics from the same sender still admit (distinct outbox ids)', () => {
    expect(dedupeKeyFor(peer('ox1', 'status'))).not.toBe(dedupeKeyFor(peer('ox2', 'status')));
  });
});

describe('dedupeKeyFor — non-deduped variants', () => {
  test('chat returns null', () => {
    const e: KinuEvent = {
      ...base(),
      ingress: 'chat_ws',
      variant: 'chat',
      payload: { text: 'hello' },
    };
    expect(dedupeKeyFor(e)).toBeNull();
  });
  test('internal returns null', () => {
    const e: KinuEvent = {
      ...base(),
      ingress: 'self_emit',
      variant: 'internal',
      payload: { kind: 'reflect', data: {} },
    };
    expect(dedupeKeyFor(e)).toBeNull();
  });
});
