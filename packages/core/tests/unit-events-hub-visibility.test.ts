// Payload visibility — redaction + LLM rendering.
import { describe, test, expect } from 'bun:test';
import { createMemoryVfs } from '@proteus/test-utils';
import {
  EVENT_BRIEF_MAX_CHARS, applyVisibilityForStorage, eventContentPath,
  renderForLLM, spillEventContent,
} from '../src/events/hub/index.ts';
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
  test('opaque-handle brief states the withholding and invents no read-back API', () => {
    // Regression: this brief once instructed the model to call
    // `read_external_payload(event_id)` — a function that existed nowhere on
    // any backend. Text injected into the prompt is an API contract; it may
    // only cite what the runtime can actually serve.
    const r = renderForLLM(eventFor('webhook',
      { _visibility: 'opaque_handle', handle: 'opaque:abcd1234' },
      'opaque_handle' as never));
    expect(r.brief).toContain('opaque:abcd1234');
    expect(r.brief).toContain('withheld');
    expect(r.brief).not.toContain('read_external_payload');
  });
  test('is_self_caused is true for self_emit', () => {
    const e = eventFor('internal', { kind: 'reflect', data: {} });
    e.ingress = 'self_emit';
    const r = renderForLLM(e);
    expect(r.is_self_caused).toBe(true);
  });

  // Reference plus digest: a brief may truncate, but never without saying
  // where the rest lives. Small payloads keep their exact pre-reference
  // rendering — the prompt-cache prefix depends on those bytes.
  describe('bulk payloads carry a resolvable reference', () => {
    const longReport = 'seam found in the auth module; '.repeat(40);
    const shortReport = 'Survey done — three seams found; note written.';

    test('an oversize subordinate report cites the spill that holds it whole', async () => {
      const { vfs } = createMemoryVfs();
      const content_path = await spillEventContent(vfs, longReport);
      expect(content_path).toBe(eventContentPath(longReport));

      const r = renderForLLM(eventFor('subordinate_report', {
        from_subordinate: 'researcher', status: 'completed', content: longReport, content_path,
      }));
      expect(r.brief).toBe(
        `completed: ${longReport.slice(0, EVENT_BRIEF_MAX_CHARS)} — full report: ${content_path}`,
      );
      expect(await vfs.readFile(content_path!)).toBe(longReport);
    });

    test('a report within the brief budget spills nothing and renders unreferenced', async () => {
      const { vfs, files } = createMemoryVfs();
      expect(await spillEventContent(vfs, shortReport)).toBeNull();
      expect(files.size).toBe(0);

      const r = renderForLLM(eventFor('subordinate_report', {
        from_subordinate: 'researcher', status: 'completed', content: shortReport, task: 'Survey auth',
      }));
      expect(r.brief).toBe('completed [re: Survey auth]: Survey done — three seams found; note written.');
    });

    test('an oversize peer body cites the spill holding its full serialization', async () => {
      const { vfs } = createMemoryVfs();
      const body = { question: 'x'.repeat(900) };
      const serialized = JSON.stringify(body);
      const body_path = await spillEventContent(vfs, serialized);

      const r = renderForLLM(eventFor('peer_agent', {
        from_agent_name: 'scout', from_user_id: 'u1', topic: 'research',
        body, sender_event_id: 'se1', body_path,
      }));
      expect(r.brief).toBe(
        `research: ${serialized.slice(0, EVENT_BRIEF_MAX_CHARS)} — full message: ${body_path}`,
      );
      expect(await vfs.readFile(body_path!)).toBe(serialized);
    });

    test('a peer body within the brief budget spills nothing and renders unreferenced', async () => {
      const { vfs, files } = createMemoryVfs();
      expect(await spillEventContent(vfs, JSON.stringify('shipping today'))).toBeNull();
      expect(files.size).toBe(0);

      const r = renderForLLM(eventFor('peer_agent', {
        from_agent_name: 'scout', from_user_id: 'u1', topic: 'status',
        body: 'shipping today', sender_event_id: 'se1',
      }));
      expect(r.brief).toBe('status: "shipping today"');
    });

    test('the budget boundary is exact, and identical content re-addresses one path', async () => {
      const { vfs, files } = createMemoryVfs();
      const atBudget = 'a'.repeat(EVENT_BRIEF_MAX_CHARS);
      expect(await spillEventContent(vfs, atBudget)).toBeNull();

      const overBudget = `${atBudget}b`;
      const first = await spillEventContent(vfs, overBudget);
      const second = await spillEventContent(vfs, overBudget);
      expect(second).toBe(first!);
      expect([...files.keys()]).toEqual([first!]);
      expect(first!.startsWith('/local/.proteus/event-content/')).toBe(true);
    });
  });
});
