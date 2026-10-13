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

describe('dedupeKeyFor — process_done', () => {
  test('keyed by process_id', () => {
    const e: KinuEvent = {
      ...base(),
      ingress: 'sandbox_cb',
      variant: 'process_done',
      payload: { process_id: 'pid-42', command: 'ls', exit_code: 0, stdout_excerpt: '', stderr_excerpt: '', duration_ms: 0 },
    };

    expect(dedupeKeyFor(e)).not.toBeNull();
    expect(dedupeKeyFor({ ...e, payload: { ...e.payload, command: 'pwd' } })).toBe(dedupeKeyFor(e));
    expect(dedupeKeyFor({ ...e, payload: { ...e.payload, process_id: 'pid-43' } })).not.toBe(dedupeKeyFor(e));
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
