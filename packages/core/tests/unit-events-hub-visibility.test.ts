// Payload visibility — redaction + LLM rendering.
import { describe, test, expect } from 'bun:test';
import { createMemoryVfs } from '@kinu/test-utils';
import * as v from 'valibot';
import {
  EVENT_BRIEF_MAX_CHARS, applyVisibilityForStorage, eventContentPath,
  renderForLLM, spillEventContent,
} from '../src/events/hub/index';
import type { BaseEvent } from '../src/events/hub/index';

const StoredHttpSchema = v.object({
  headers: v.record(v.string(), v.string()),
  body: v.object({ ok: v.boolean() }),
});
const StoredUserSchema = v.object({
  user: v.object({ api_key: v.string(), password: v.string() }),
  data: v.string(),
});
const StoredHashSchema = v.object({
  _visibility: v.string(),
  sha256: v.string(),
  size: v.number(),
});

const EVENT_BASE = {
  id: 'eid', trace_id: 'tid', caused_by: null,
  trust: 'authenticated', priority: 'normal', received_at: 0,
  schema_version: 1, reply_channel: null, dedupe_key: null,
} satisfies Omit<BaseEvent, 'ingress' | 'variant' | 'payload_visibility'>;

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
    const stored = v.parse(StoredHttpSchema, r.stored);
    expect(stored.headers.authorization).toBe('<redacted:authorization>');
    expect(stored.headers['content-type']).toBe('application/json');
    expect(stored.body).toEqual({ ok: true });
  });
  test('recursively redacts secret-shaped fields', () => {
    const r = applyVisibilityForStorage({
      user: { name: 'alice', api_key: 'k', password: 'p' },
      data: 'visible',
    }, 'redact');
    const stored = v.parse(StoredUserSchema, r.stored);
    expect(stored.user.api_key).toBe('<redacted:api_key>');
    expect(stored.user.password).toBe('<redacted:password>');
    expect(stored.data).toBe('visible');
  });
});

describe('applyVisibilityForStorage — hash', () => {
  test('replaces payload with sha256+size summary', () => {
    const r = applyVisibilityForStorage({ secret: 'value' }, 'hash');
    const stored = v.parse(StoredHashSchema, r.stored);
    expect(stored._visibility).toBe('hash');
    expect(stored.sha256).toHaveLength(64);
    expect(stored.size).toBeGreaterThan(0);
  });
});

describe('renderForLLM', () => {
  test('chat — brief truncates to ~200 chars', () => {
    const text = 'x'.repeat(500);
    const r = renderForLLM({
      ...EVENT_BASE, ingress: 'chat_ws', variant: 'chat', payload_visibility: 'full', payload: { text },
    });
    expect(r.brief.length).toBeLessThanOrEqual(200);
    expect(r.variant).toBe('chat');
  });
  test('webhook — brief shows method + body excerpt', () => {
    const r = renderForLLM({
      ...EVENT_BASE, ingress: 'webhook_hmac', variant: 'webhook', payload_visibility: 'full',
      payload: { http_method: 'POST', body: { ok: true }, webhook_id: 'w', http_headers: {}, delivery_id: 'd' },
    });
    expect(r.brief).toContain('POST');
  });
  test('hash-visibility events show redacted brief', () => {
    const r = renderForLLM({
      ...EVENT_BASE, ingress: 'webhook_hmac', variant: 'webhook', payload_visibility: 'hash',
      payload: { _visibility: 'hash', sha256: 'abc'.repeat(20), size: 42, content_type: 'object' },
    });
    expect(r.brief).toContain('redacted');
  });
  test('an internal note names its kind and never leaks its payload bytes', () => {
    // `data` is whatever the emitting layer put there; the brief is the model's
    // view of an event, not a dump of it. The kind is the actionable fact.
    const r = renderForLLM({
      ...EVENT_BASE, ingress: 'self_emit', variant: 'internal', payload_visibility: 'full',
      payload: {
        kind: 'email_inbound_rate_limited',
        data: 'window resets at 2026-08-11T09:00:00Z',
      },
    });
    expect(r.brief).toBe('email_inbound_rate_limited');
    expect(r.brief).not.toContain('2026-08-11');
  });

  test('opaque-handle brief states the withholding and invents no read-back API', () => {
    // Regression: this brief once instructed the model to call
    // `read_external_payload(event_id)` — a function that existed nowhere on
    // any backend. Text injected into the prompt is an API contract; it may
    // only cite what the runtime can actually serve.
    const r = renderForLLM({
      ...EVENT_BASE, ingress: 'webhook_hmac', variant: 'webhook', payload_visibility: 'opaque_handle',
      payload: { _visibility: 'opaque_handle', handle: 'opaque:abcd1234' },
    });
    expect(r.brief).toContain('opaque:abcd1234');
    expect(r.brief).toContain('withheld');
    expect(r.brief).not.toContain('read_external_payload');
  });
  test('is_self_caused is true for self_emit', () => {
    const r = renderForLLM({
      ...EVENT_BASE, ingress: 'self_emit', variant: 'internal', payload_visibility: 'full',
      payload: { kind: 'reflect', data: {} },
    });
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
      if (content_path === null) throw new Error('long subordinate report was not spilled');

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'subordinate', variant: 'subordinate_report', payload_visibility: 'full',
        payload: {
          from_subordinate: 'researcher', status: 'completed', content: longReport, content_path,
          proteus_mode: 'build',
        },
      });
      // Bounded, but it SAYS it is bounded and where the rest lives: head,
      // an in-band omitted count, tail, then the resolvable path.
      expect(r.brief.startsWith(`completed: ${longReport.slice(0, 100)}`)).toBe(true);
      expect(r.brief).toContain(
        `[... ${longReport.length - EVENT_BRIEF_MAX_CHARS} chars omitted from the middle ...]`,
      );
      expect(r.brief.endsWith(` — full report: ${content_path}`)).toBe(true);
      expect(await vfs.readFile(content_path!)).toBe(longReport);
    });

    test('a report within the brief budget spills nothing and renders unreferenced', async () => {
      const { vfs, files } = createMemoryVfs();
      expect(await spillEventContent(vfs, shortReport)).toBeNull();
      expect(files.size).toBe(0);

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'subordinate', variant: 'subordinate_report', payload_visibility: 'full',
        payload: {
          from_subordinate: 'researcher', status: 'completed', content: shortReport,
          task: 'Survey auth', proteus_mode: 'build',
        },
      });
      expect(r.brief).toBe('completed [re: Survey auth]: Survey done — three seams found; note written.');
    });

    test('an oversize peer body cites the spill holding its full serialization', async () => {
      const { vfs } = createMemoryVfs();
      const body = { question: 'x'.repeat(900) };
      const serialized = JSON.stringify(body);
      const body_path = await spillEventContent(vfs, serialized);
      if (body_path === null) throw new Error('long peer body was not spilled');

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'peer_async', variant: 'peer_agent', payload_visibility: 'full',
        payload: {
          from_agent_name: 'scout', from_user_id: 'u1', topic: 'research',
          body, sender_event_id: 'se1', body_path, proteus_mode: 'build',
        },
      });
      expect(r.brief.startsWith(`research: ${serialized.slice(0, 100)}`)).toBe(true);
      expect(r.brief).toContain(
        `[... ${serialized.length - EVENT_BRIEF_MAX_CHARS} chars omitted from the middle ...]`,
      );
      // The tail survives the window, so the serialization's closing brace is
      // visible rather than cut mid-value.
      expect(r.brief).toContain(`"} — full message: ${body_path}`);
      expect(await vfs.readFile(body_path!)).toBe(serialized);
    });

    test('a peer body within the brief budget spills nothing and renders unreferenced', async () => {
      const { vfs, files } = createMemoryVfs();
      expect(await spillEventContent(vfs, JSON.stringify('shipping today'))).toBeNull();
      expect(files.size).toBe(0);

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'peer_async', variant: 'peer_agent', payload_visibility: 'full',
        payload: {
          from_agent_name: 'scout', from_user_id: 'u1', topic: 'status',
          body: 'shipping today', sender_event_id: 'se1', proteus_mode: 'build',
        },
      });
      expect(r.brief).toBe('status: "shipping today"');
    });

    test('an oversize webhook body is windowed, counted, and addressable', async () => {
      // The old brief handed the model 200 characters of stringified JSON —
      // syntactically invalid, unmarked, and with nothing to read the rest
      // from — as the whole content of the delivery that woke it.
      const { vfs } = createMemoryVfs();
      const body = { event: 'deploy.failed', log: 'y'.repeat(900), action: 'rollback' };
      const serialized = JSON.stringify(body);
      const body_path = await spillEventContent(vfs, serialized);
      if (body_path === null) throw new Error('long webhook body was not spilled');

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'webhook_hmac', variant: 'webhook', payload_visibility: 'full',
        payload: {
          webhook_id: 'w', http_method: 'POST', http_headers: {}, delivery_id: 'd',
          body, body_path,
        },
      });
      expect(r.brief).toContain('deploy.failed');
      expect(r.brief).toContain(
        `[... ${serialized.length - EVENT_BRIEF_MAX_CHARS} chars omitted from the middle ...]`,
      );
      expect(r.brief).toContain('rollback');
      expect(r.brief.endsWith(` — full body: ${body_path}`)).toBe(true);
      expect(await vfs.readFile(body_path!)).toBe(serialized);
    });

    test('an oversize email body is windowed, counted, and addressable', async () => {
      const { vfs } = createMemoryVfs();
      const body_text = `Please review:\n${'context line\n'.repeat(90)}Ship it by Friday.`;
      const body_path = await spillEventContent(vfs, body_text);
      if (body_path === null) throw new Error('long email body was not spilled');

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'email_inbound', variant: 'email', payload_visibility: 'full',
        payload: {
          from: 'owner@example.com', to: 'agent@example.com', subject: 'Release',
          body_text, message_id: null, in_reply_to: null, references: null,
          attachments: [{ filename: 'a.csv', content_type: 'text/csv', size: 4 }],
          body_path,
        },
      });
      expect(r.brief.startsWith('"Release" [1 attachment]: Please review:')).toBe(true);
      expect(r.brief).toContain(
        `[... ${body_text.length - EVENT_BRIEF_MAX_CHARS} chars omitted from the middle ...]`,
      );
      expect(r.brief).toContain('Ship it by Friday.');
      expect(r.brief.endsWith(` — full body: ${body_path}`)).toBe(true);
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
      expect(first!.startsWith('.proteus/event-content/')).toBe(true);
    });
  });
});
