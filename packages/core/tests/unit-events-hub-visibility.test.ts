// Payload visibility — redaction + LLM rendering.
import { describe, test, expect } from 'bun:test';
import { applyVisibilityForStorage, renderForLLM } from '../src/events/hub/index.ts';
import type { ProteusEvent } from '../src/events/hub/index.ts';

describe('applyVisibilityForStorage — full', () => {
  test('returns payload unchanged', () => {
    const r = applyVisibilityForStorage({ a: 1, b: 'x' }, 'full');
    expect(r.stored).toEqual({ a: 1, b: 'x' });
  });
});

describe('applyVisibilityForStorage — redact', () => {
  test('masks Authorization header in HTTP body shape', () => {
    const r = applyVisibilityForStorage({
      method: 'POST',
      headers: { authorization: 'Bearer sk-abc123', 'content-type': 'application/json' },
      body: { ok: true },
    }, 'redact');
    const stored = r.stored as { headers: Record<string, string>; body: unknown };
    expect(stored.headers.authorization).toBe('<redacted:authorization>');
    expect(stored.headers['content-type']).toBe('application/json');
    expect(stored.body).toEqual({ ok: true });
  });
  test('recursively redacts secret-shaped fields', () => {
    const r = applyVisibilityForStorage({
      user: { name: 'alice', api_key: 'k', password: 'p' },
      data: 'visible',
    }, 'redact');
    const stored = r.stored as { user: { api_key: string; password: string }; data: string };
    expect(stored.user.api_key).toBe('<redacted:api_key>');
    expect(stored.user.password).toBe('<redacted:password>');
    expect(stored.data).toBe('visible');
  });
});

describe('applyVisibilityForStorage — hash', () => {
  test('replaces payload with sha256+size summary', () => {
    const r = applyVisibilityForStorage({ secret: 'value' }, 'hash');
    const stored = r.stored as { _visibility: string; sha256: string; size: number };
    expect(stored._visibility).toBe('hash');
    expect(stored.sha256).toHaveLength(64);
    expect(stored.size).toBeGreaterThan(0);
  });
});

describe('renderForLLM', () => {
  function eventFor(variant: ProteusEvent['variant'], payload: unknown, vis: 'full' | 'hash' = 'full'): ProteusEvent {
    return {
      id: 'eid', trace_id: 'tid', caused_by: null,
      ingress: 'webhook_hmac', variant, trust: 'authenticated',
      priority: 'normal', payload_visibility: vis,
      received_at: 0, schema_version: 1, reply_channel: null, dedupe_key: null,
      payload,
    } as ProteusEvent;
  }
  test('chat — brief truncates to ~200 chars', () => {
    const text = 'x'.repeat(500);
    const r = renderForLLM({ ...eventFor('chat', { text }), ingress: 'chat_ws' });
    expect(r.brief.length).toBeLessThanOrEqual(200);
    expect(r.variant).toBe('chat');
  });
  test('webhook — brief shows method + body excerpt', () => {
    const r = renderForLLM(eventFor('webhook', { http_method: 'POST', body: { ok: true }, webhook_id: 'w', http_headers: {}, delivery_id: 'd' }));
    expect(r.brief).toContain('POST');
  });
  test('hash-visibility events show redacted brief', () => {
    const r = renderForLLM(eventFor('webhook',
      { _visibility: 'hash', sha256: 'abc'.repeat(20), size: 42, content_type: 'object' },
      'hash'));
    expect(r.brief).toContain('redacted');
  });
  test('is_self_caused is true for self_emit', () => {
    const e = eventFor('internal', { kind: 'reflect', data: {} });
    e.ingress = 'self_emit';
    const r = renderForLLM(e);
    expect(r.is_self_caused).toBe(true);
  });
});
