import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createMemoryVfs, createTestActorsOver, present } from '@kinu.run/test-utils';
import * as v from 'valibot';
import {
  EVENT_BRIEF_MAX_CHARS, EventLog, applyVisibilityForStorage, eventContentPath, initEventsHubTables,
  redactPayload, redactSecrets, renderForLLM, spillEventContent,
} from '../src/events/hub/index';
import type { BaseEvent } from '../src/events/hub/index';
import { receivePeerMessage } from '../src/events/ingress/peer';
import { acceptContainerEvent } from '../src/events/ingress/container';
import { makeSqlExec } from './helpers';

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
  test('redacts nested camelCase credentials while keeping ordinary fields', () => {
    const StoredCamelSchema = v.object({
      session: v.object({
        authToken: v.string(),
        accessToken: v.string(),
        clientSecret: v.string(),
        oldPassword: v.string(),
        displayName: v.string(),
        monkey: v.string(),
        turkey: v.string(),
      }),
      data: v.string(),
    });

    const r = applyVisibilityForStorage({
      session: {
        authToken: 't1',
        accessToken: 't2',
        clientSecret: 's',
        oldPassword: 'p',
        displayName: 'alice',
        monkey: 'not-a-secret',
        turkey: 'also-visible',
      },
      data: 'visible',
    }, 'redact');

    const stored = v.parse(StoredCamelSchema, r.stored);
    expect(stored.session.authToken).toBe('<redacted:authToken>');
    expect(stored.session.accessToken).toBe('<redacted:accessToken>');
    expect(stored.session.clientSecret).toBe('<redacted:clientSecret>');
    expect(stored.session.oldPassword).toBe('<redacted:oldPassword>');
    expect(stored.session.displayName).toBe('alice');
    expect(stored.session.monkey).toBe('not-a-secret');
    expect(stored.session.turkey).toBe('also-visible');
    expect(stored.data).toBe('visible');
  });
});

describe('redactSecrets — secret-shaped VALUES in free text', () => {
  // KINU-011: tokens inside free-form strings must be redacted, not just by field name. Literals
  // are assembled so this file stays clean under the commit-tier scan.
  const TOKEN = `cfut_${'a'.repeat(48)}`;

  test('a token inside a free-form string is masked, and only the token', () => {
    expect(redactSecrets(`deploy --token=${TOKEN} now`)).toBe('deploy --token=<redacted> now');
  });

  test('redactPayload reaches secret values inside named fields, not just the names', () => {
    const stored = redactPayload({ result: `token ${TOKEN} accepted`, keep: 'visible' });

    expect(stored).toEqual({ result: 'token <redacted> accepted', keep: 'visible' });
  });

  test('a device token is masked whatever its first body character', () => {
    // `pdt_` bodies are base64url, so a hex-only pattern let most of them through.
    const device = ['pdt', '_', 'Zq', 'x'.repeat(40)].join('');

    expect(redactSecrets(`X-Device: ${device}`)).toBe('X-Device: <redacted>');
  });

  test('a secret-named JSON pair written as text keeps its name and loses its value', () => {
    expect(redactSecrets('{"api_key": "verysecretvalue1234"}')).toBe('{"api_key": "<redacted>"}');
  });

  test('a bare string payload is free text too', () => {
    expect(redactPayload(`API key: ${TOKEN}`)).toBe('API key: <redacted>');
  });

  test('a benign word elsewhere on the line does not spare a real key', () => {
    // The scan adjudicates whole source lines; a transcript's prose around a live key is not a placeholder.
    const key = ['sk-ant-', 'api03-', 'k'.repeat(24)].join('');

    expect(redactSecrets(`for example key ${key}`)).toBe('for example key <redacted>');
    expect(redactSecrets(`placeholder replaced by ${key}`)).toBe('placeholder replaced by <redacted>');
  });

  test('a match that is itself a placeholder stays, as the scan reads it', () => {
    const line = `set STRIPE_KEY=sk_live_example${'x'.repeat(16)} first`;

    expect(redactSecrets(line)).toBe(line);
  });

  test('a masked value stays masked on a second pass', () => {
    const once = redactSecrets(`token ${TOKEN}`);

    expect(redactSecrets(once)).toBe(once);
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
    // The brief is the model's view of an event, not a dump of `data`.
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
    // Prompt text is an API contract: it may only cite what the runtime serves.
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

  // A truncated brief says where the rest lives; small payloads keep exact bytes for the prompt cache.
  describe('bulk payloads carry a resolvable reference', () => {
    const longReport = 'seam found in the auth module; '.repeat(40);
    const shortReport = 'Survey done — three seams found; note written.';

    test('an oversize subordinate report cites the spill that holds it whole', async () => {
      const { vfs } = createMemoryVfs();
      const spilled = await spillEventContent(vfs, longReport);
      expect(spilled).toEqual({ path: eventContentPath(longReport) });
      const content_path = present(spilled?.path, 'the spilled report path');

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'subordinate', variant: 'subordinate_report', payload_visibility: 'full',
        payload: {
          from_subordinate: 'researcher', status: 'completed', content: longReport, content_path,
          sequence_id: 'seq-1', kinu_mode: 'build',
        },
      });

      // Head, in-band omitted count, tail, then the resolvable path.
      expect(r.brief.startsWith(`completed: ${longReport.slice(0, 100)}`)).toBe(true);
      expect(r.brief).toContain(
        `[... ${longReport.length - EVENT_BRIEF_MAX_CHARS} chars omitted from the middle ...]`,
      );
      expect(r.brief.endsWith(` — full report: ${content_path}`)).toBe(true);
      expect(await vfs.readFile(content_path)).toBe(longReport);
    });

    test('a report within the brief budget spills nothing and renders unreferenced', async () => {
      const { vfs, files } = createMemoryVfs();
      expect(await spillEventContent(vfs, shortReport)).toBeNull();
      expect(files.size).toBe(0);

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'subordinate', variant: 'subordinate_report', payload_visibility: 'full',
        payload: {
          from_subordinate: 'researcher', status: 'completed', content: shortReport,
          sequence_id: 'seq-2', task: 'Survey auth', kinu_mode: 'build',
        },
      });

      expect(r.brief).toBe('completed [re: Survey auth]: Survey done — three seams found; note written.');
    });

    test('an oversize peer body cites the spill holding its full serialization', async () => {
      const { vfs } = createMemoryVfs();
      const body = { question: 'x'.repeat(900) };
      const serialized = JSON.stringify(body);
      const body_path = present((await spillEventContent(vfs, serialized))?.path, 'the spilled peer body path');

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'peer_async', variant: 'peer_agent', payload_visibility: 'full',
        payload: {
          from_agent_name: 'scout', from_user_id: 'u1', topic: 'research',
          body, sender_event_id: 'se1', body_path, kinu_mode: 'build',
        },
      });

      expect(r.brief.startsWith(`research: ${serialized.slice(0, 100)}`)).toBe(true);
      expect(r.brief).toContain(
        `[... ${serialized.length - EVENT_BRIEF_MAX_CHARS} chars omitted from the middle ...]`,
      );
      expect(r.brief).toContain(`"} — full message: ${body_path}`);
      expect(await vfs.readFile(body_path)).toBe(serialized);
    });

    test('a peer body within the brief budget spills nothing and renders unreferenced', async () => {
      const { vfs, files } = createMemoryVfs();
      expect(await spillEventContent(vfs, JSON.stringify('shipping today'))).toBeNull();
      expect(files.size).toBe(0);

      const r = renderForLLM({
        ...EVENT_BASE, ingress: 'peer_async', variant: 'peer_agent', payload_visibility: 'full',
        payload: {
          from_agent_name: 'scout', from_user_id: 'u1', topic: 'status',
          body: 'shipping today', sender_event_id: 'se1', kinu_mode: 'build',
        },
      });

      expect(r.brief).toBe('status: "shipping today"');
    });

    test('an oversize webhook body is windowed, counted, and addressable', async () => {
      const { vfs } = createMemoryVfs();
      const body = { event: 'deploy.failed', log: 'y'.repeat(900), action: 'rollback' };
      const serialized = JSON.stringify(body);
      const body_path = present((await spillEventContent(vfs, serialized))?.path, 'the spilled webhook body path');

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
      expect(await vfs.readFile(body_path)).toBe(serialized);
    });

    test('an oversize email body is windowed, counted, and addressable', async () => {
      const { vfs } = createMemoryVfs();
      const body_text = `Please review:\n${'context line\n'.repeat(90)}Ship it by Friday.`;
      const body_path = present((await spillEventContent(vfs, body_text))?.path, 'the spilled email body path');

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
      const spilled = present(first?.path, 'the spilled content path');

      expect(second).toEqual(first);
      expect([...files.keys()]).toEqual([spilled]);
      expect(spilled.startsWith('.kinu/event-content/')).toBe(true);
    });

    test('an oversize peer body whose spill fails is still delivered, and its brief says why the rest is missing', async () => {
      const db = new Database(':memory:');
      const sql = makeSqlExec(db);
      initEventsHubTables(sql);
      const log = new EventLog(sql, createTestActorsOver(db).main);
      const { vfs } = createMemoryVfs();
      const body = { question: 'x'.repeat(900) };

      const received = await receivePeerMessage({
        log,
        vfs: { ...vfs, async writeFile() { throw new Error('the disk is full'); } },
        isSameOwner: async () => true,
        hasGrant: async () => true,
      }, {
        sender_event_id: 'ox-spill', sender_agent_name: 'scout', sender_user_id: 'u1',
        topic: 'research', body, mode: 'build',
      }, 1_000);

      expect(received.admitted).toBe(true);
      const [event] = log.pending({ variant: 'peer_agent' });
      const brief = renderForLLM(present(event, 'the delivered peer event')).brief;

      expect(brief).toContain(`[... ${JSON.stringify(body).length - EVENT_BRIEF_MAX_CHARS} chars omitted from the middle ...]`);
      expect(brief).toContain(' — full message could not be saved: ');
      expect(brief).toContain('the disk is full');
    });

    test('oversize process output cites where each stream went, or why it went nowhere', async () => {
      const db = new Database(':memory:');
      const sql = makeSqlExec(db);
      initEventsHubTables(sql);
      const log = new EventLog(sql, createTestActorsOver(db).main);
      const { vfs } = createMemoryVfs();
      const stdout = 'o'.repeat(900);
      const stderr = 'e'.repeat(900);

      const accepted = await acceptContainerEvent({
        log,
        vfs: {
          ...vfs,
          async writeFile(path, data) {
            if (data === stderr) throw new Error('the disk is full');
            await vfs.writeFile(path, data);
          },
        },
        launchingHeadTrust: 'owner',
        onAdmitted: () => {},
      }, { kind: 'process_done', process_id: 'p-1', command: 'make', exit_code: 2, stdout, stderr }, 1_000);

      expect(accepted).toMatchObject({ status: 'admitted', admitted: true });
      const [event] = log.pending({ variant: 'process_done' });
      const brief = renderForLLM(present(event, 'the process event')).brief;

      expect(brief).toContain(` — full stdout: ${eventContentPath(stdout)}`);
      expect(brief).toContain(' — full stderr could not be saved: ');
      expect(brief).toContain('the disk is full');
    });
  });
});
