// Webhook ingress — the gate, end to end over a real hub (EventLog +
// ReplyChannelStore + TriggerRegistry + rate windows on in-memory SQLite).
//
// Every rejection asserts its exact HTTP status AND its exact reason string,
// because this is the surface an operator debugs a failing integration
// against: "signature mismatch" and "timestamp out of window" are different
// answers to the same 401 and must stay different. The matrix below is the
// full set of refusals the gate can produce.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  EventLog, ReplyChannelStore, TriggerRegistry,
  acceptWebhookDelivery, createWebhookSecretStore, hmacSha256Hex,
  initEventsHubTables, initWebhookRateLimitTables, registerDurableWebhook, cancelTrigger,
  type SqlExec, type WebhookDelivery,
} from '../src/index';
import type { WebhookTriggerSpec } from '../src/events/ingress/webhook';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { makeSqlExec } from './helpers';

function makeSql(db: Database): SqlExec {
  return makeSqlExec(db);
}

const NOW = 1_700_000_000_000;

function hub() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initEventsHubTables(sql);
  initWebhookRateLimitTables(sql);
  const log = new EventLog(sql);
  const triggers = new TriggerRegistry(sql, { scheduleAt: async () => {}, currentAlarm: () => null });
  const secrets = createWebhookSecretStore(sql);
  const { vfs, files } = createMemoryVfs();
  let drains = 0;
  const deps = {
    triggers, log, secrets, sql, vfs,
    replies: new ReplyChannelStore(sql),
    onAdmitted: () => { drains += 1; },
  };

  /** Register a webhook exactly as a backend's create route does. */
  const register = async (
    opts: Parameters<typeof registerDurableWebhook>[1] & { secret?: string },
  ): Promise<string> => {
    const webhook = await registerDurableWebhook(triggers, opts, NOW);
    if (opts.secret) secrets.put(webhook.secret_id, webhook.trigger_id, opts.secret, NOW);
    return webhook.trigger_id;
  };

  const deliver = (over: Partial<WebhookDelivery> & { trigger_id: string }) =>
    acceptWebhookDelivery(deps, {
      method: 'POST',
      headers: {},
      body_text: '{"ok":true}',
      cf_mtls_verified: false,
      delivery_id: null,
      hmac_signature: null,
      hmac_timestamp: null,
      bearer_header: null,
      content_type: 'application/json',
      now: NOW,
      ...over,
    });

  return { deps, triggers, log, secrets, files, register, deliver, drains: () => drains };
}

describe('webhook ingress admits a verified delivery', () => {
  test('bearer: the delivery becomes a pending event that wakes the agent', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'bearer', secret: 'shhh' });

    const result = await h.deliver({ trigger_id, bearer_header: 'Bearer shhh' });

    expect(result).toMatchObject({ status: 'admitted', admitted: true });
    const [event] = h.log.pending({ variant: 'webhook' });
    expect(event.ingress).toBe('webhook_bearer');
    expect(event.payload).toMatchObject({
      webhook_id: trigger_id, http_method: 'POST', body: { ok: true },
    });
    expect(h.drains()).toBe(1);
  });

  test('hmac: the signature covers `<timestamp>.<body>`, and the body is parsed once', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'hmac', secret: 'k' });
    const body_text = '{"n":41}';

    const result = await h.deliver({
      trigger_id, body_text,
      hmac_timestamp: String(NOW),
      hmac_signature: await hmacSha256Hex('k', `${NOW}.${body_text}`),
    });

    expect(result.status).toBe('admitted');
    const [event] = h.log.pending({ variant: 'webhook' });
    expect(event.ingress).toBe('webhook_hmac');
    expect(event.payload).toMatchObject({ body: { n: 41 } });
  });

  test('mtls: the edge’s verdict is the whole check, and no secret is read', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'partner', auth_mode: 'mtls' });

    expect(await h.deliver({ trigger_id, cf_mtls_verified: true })).toMatchObject({ status: 'admitted' });
    expect(h.log.pending({ variant: 'webhook' })[0].ingress).toBe('webhook_mtls');
  });

  test('a non-JSON body is carried verbatim, and a malformed JSON body is not lost', async () => {
    const h = hub();
    const text = await h.register({ label: 'text', auth_mode: 'mtls', accepted_content_type: 'text/plain' });
    await h.deliver({ trigger_id: text, cf_mtls_verified: true, content_type: 'text/plain', body_text: 'ping' });
    expect(h.log.pending({ variant: 'webhook' })[0].payload).toMatchObject({ body: 'ping' });

    const json = await h.register({ label: 'json', auth_mode: 'mtls' });
    await h.deliver({ trigger_id: json, cf_mtls_verified: true, body_text: '{oops' });
    expect(h.log.pending({ variant: 'webhook' })[1].payload).toMatchObject({ body: '{oops' });
  });

  test('a redelivery of the same delivery_id dedupes instead of waking a second turn', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'mtls' });
    const first = await h.deliver({ trigger_id, cf_mtls_verified: true, delivery_id: 'd-1' });
    const second = await h.deliver({ trigger_id, cf_mtls_verified: true, delivery_id: 'd-1' });

    expect(first).toMatchObject({ admitted: true });
    expect(second).toMatchObject({ status: 'admitted', event_id: first.event_id, admitted: false });
    expect(h.drains()).toBe(1);
  });

  test('a body past the brief budget is spilled to the agent’s own file plane', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'big', auth_mode: 'mtls' });
    await h.deliver({
      trigger_id, cf_mtls_verified: true, body_text: JSON.stringify({ blob: 'x'.repeat(4000) }),
    });

    const [event] = h.log.pending({ variant: 'webhook' });
    if (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') {
      throw new Error(`expected readable webhook payload, received ${event.payload_visibility}`);
    }
    if (event.variant !== 'webhook') throw new Error(`expected webhook event, received ${event.variant}`);
    const path = event.payload.body_path;
    expect(path).toBeString();
    if (!path) throw new Error('large webhook body was not spilled');
    expect(await h.files.get(path)).toContain('x'.repeat(4000));
  });
});

describe('webhook ingress refuses everything else', () => {
  test('the trigger itself: unknown, revoked, or not a webhook', async () => {
    const h = hub();
    expect(await h.deliver({ trigger_id: 'nope' }))
      .toEqual({ status: 'rejected', http_status: 404, reason: 'trigger not found' });

    const revoked = await h.register({ label: 'ci', auth_mode: 'mtls' });
    h.triggers.revoke(revoked, NOW);
    expect(await h.deliver({ trigger_id: revoked, cf_mtls_verified: true }))
      .toEqual({ status: 'rejected', http_status: 503, reason: 'trigger revoked' });

    const timer = await h.triggers.register({ kind: 'timer_cron', spec: {}, creator_trust: 'owner' }, NOW);
    expect(await h.deliver({ trigger_id: timer }))
      .toEqual({ status: 'rejected', http_status: 400, reason: 'not a webhook trigger' });
  });

  test('the content-type pin is exact, and parameters after `;` do not defeat it', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'mtls' });

    expect(await h.deliver({ trigger_id, cf_mtls_verified: true, content_type: 'text/plain' }))
      .toEqual({ status: 'rejected', http_status: 415, reason: 'expected application/json' });
    expect(await h.deliver({
      trigger_id, cf_mtls_verified: true, content_type: 'application/json; charset=utf-8',
    })).toMatchObject({ status: 'admitted' });
  });

  test('bearer: absent, malformed, wrong, and unstored secrets are all 401', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'bearer', secret: 'shhh' });
    const rejected = (reason: string) => ({ status: 'rejected' as const, http_status: 401, reason });

    expect(await h.deliver({ trigger_id })).toEqual(rejected('missing bearer'));
    expect(await h.deliver({ trigger_id, bearer_header: 'shhh' })).toEqual(rejected('missing bearer'));
    expect(await h.deliver({ trigger_id, bearer_header: 'Bearer nope' })).toEqual(rejected('bearer mismatch'));
    // Constant-time compare is length-first: a prefix of the real secret is a
    // mismatch, not a partial match.
    expect(await h.deliver({ trigger_id, bearer_header: 'Bearer shh' })).toEqual(rejected('bearer mismatch'));

    const unstored = await h.register({ label: 'no-secret', auth_mode: 'bearer' });
    expect(await h.deliver({ trigger_id: unstored, bearer_header: 'Bearer shhh' }))
      .toEqual(rejected('secret revoked'));

    expect(h.log.pending({ variant: 'webhook' })).toEqual([]);
  });

  test('hmac: missing headers, a stale timestamp, and a wrong signature are all 401', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'hmac', secret: 'k' });
    const body_text = '{"n":41}';
    const sign = (ts: number) => hmacSha256Hex('k', `${ts}.${body_text}`);
    const rejected = (reason: string) => ({ status: 'rejected' as const, http_status: 401, reason });

    expect(await h.deliver({ trigger_id, body_text, hmac_timestamp: String(NOW) }))
      .toEqual(rejected('missing hmac headers'));
    expect(await h.deliver({ trigger_id, body_text, hmac_signature: await sign(NOW) }))
      .toEqual(rejected('missing hmac headers'));
    expect(await h.deliver({
      trigger_id, body_text, hmac_timestamp: 'soon', hmac_signature: await sign(NOW),
    })).toEqual(rejected('timestamp out of window'));

    // The replay window is ±5 minutes, inclusive at the boundary and in both
    // directions (a clock ahead of the receiver is as valid as one behind).
    const window = 5 * 60 * 1000;
    for (const ts of [NOW - window, NOW + window]) {
      expect(await h.deliver({
        trigger_id, body_text, hmac_timestamp: String(ts), hmac_signature: await sign(ts),
      })).toMatchObject({ status: 'admitted' });
    }
    for (const ts of [NOW - window - 1, NOW + window + 1]) {
      expect(await h.deliver({
        trigger_id, body_text, hmac_timestamp: String(ts), hmac_signature: await sign(ts),
      })).toEqual(rejected('timestamp out of window'));
    }

    // A signature over a DIFFERENT body, or under a different timestamp, is a
    // mismatch — which is what makes the timestamp part of the signed material
    // rather than a hint.
    expect(await h.deliver({
      trigger_id, body_text, hmac_timestamp: String(NOW), hmac_signature: await hmacSha256Hex('k', `${NOW}.{}`),
    })).toEqual(rejected('signature mismatch'));
    expect(await h.deliver({
      trigger_id, body_text, hmac_timestamp: String(NOW), hmac_signature: await sign(NOW - 1000),
    })).toEqual(rejected('signature mismatch'));
    expect(await h.deliver({
      trigger_id, body_text, hmac_timestamp: String(NOW), hmac_signature: await hmacSha256Hex('other', `${NOW}.${body_text}`),
    })).toEqual(rejected('signature mismatch'));

    const unstored = await h.register({ label: 'no-secret', auth_mode: 'hmac' });
    expect(await h.deliver({
      trigger_id: unstored, body_text, hmac_timestamp: String(NOW), hmac_signature: await sign(NOW),
    })).toEqual(rejected('secret revoked'));
  });

  test('mtls: an unverified client certificate is 401', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'partner', auth_mode: 'mtls' });
    expect(await h.deliver({ trigger_id, cf_mtls_verified: false }))
      .toEqual({ status: 'rejected', http_status: 401, reason: 'client cert not verified' });
  });

  test('the rate limit is per trigger per minute, and refuses with the configured limit', async () => {
    const h = hub();
    const a = await h.register({ label: 'a', auth_mode: 'mtls', rate_limit_per_min: 2 });
    const b = await h.register({ label: 'b', auth_mode: 'mtls', rate_limit_per_min: 2 });
    const send = (trigger_id: string, now: number) =>
      h.deliver({ trigger_id, cf_mtls_verified: true, now, delivery_id: `d-${trigger_id}-${now}` });

    expect(await send(a, NOW)).toMatchObject({ status: 'admitted' });
    expect(await send(a, NOW + 1)).toMatchObject({ status: 'admitted' });
    expect(await send(a, NOW + 2))
      .toEqual({ status: 'rejected', http_status: 429, reason: 'rate limit exceeded (2/min)' });
    // …the other trigger's budget is its own, and the next window is fresh.
    expect(await send(b, NOW + 2)).toMatchObject({ status: 'admitted' });
    expect(await send(a, NOW + 60_000)).toMatchObject({ status: 'admitted' });
  });

  test('a refused delivery writes nothing at all — no event, no file, no wake', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'bearer', secret: 'shhh' });
    const big = JSON.stringify({ blob: 'x'.repeat(4000) });

    expect(await h.deliver({ trigger_id, bearer_header: 'Bearer nope', body_text: big }))
      .toMatchObject({ status: 'rejected' });

    expect(h.log.pending({})).toEqual([]);
    expect(h.files.size).toBe(0);
    expect(h.drains()).toBe(0);
  });
});

describe('webhook registration', () => {
  test('the secret never reaches the trigger row, only its opaque handle', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initEventsHubTables(sql);
    const triggers = new TriggerRegistry(sql, { scheduleAt: async () => {}, currentAlarm: () => null });
    const secrets = createWebhookSecretStore(sql);

    const webhook = await registerDurableWebhook(triggers, { label: 'ci', auth_mode: 'bearer' }, NOW);
    secrets.put(webhook.secret_id, webhook.trigger_id, 'shhh', NOW);

    const row = triggers.get(webhook.trigger_id)!;
    expect(JSON.stringify(row.spec)).not.toContain('shhh');
    expect(row.spec).toEqual({
      label: 'ci', auth_mode: 'bearer', secret_id: webhook.secret_id,
      accepted_content_type: 'application/json',
    });
    expect(row.rate_limit_per_min).toBe(60);
    expect(row.creator_trust).toBe('owner');
  });

  test('an out-of-range rate limit is refused before a trigger row exists', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initEventsHubTables(sql);
    const triggers = new TriggerRegistry(sql, { scheduleAt: async () => {}, currentAlarm: () => null });

    await expect(registerDurableWebhook(
      triggers, { label: 'ci', auth_mode: 'bearer', rate_limit_per_min: 0 }, NOW,
    )).rejects.toThrow(/rate_limit_per_min/);
    expect(triggers.list()).toEqual([]);
  });

  test('a secret store with no table yet answers null rather than throwing', async () => {
    const db = new Database(':memory:');
    expect(await createWebhookSecretStore(makeSql(db)).get('webhook_secret_absent')).toBeNull();
  });
});

describe('revocation closes the trigger and deletes its secret together', () => {
  test('revoking deletes the secret material and retains the byte-free audit row', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'bearer', secret: 'shhh' });
    const spec: Partial<WebhookTriggerSpec> = h.triggers.get(trigger_id)!.spec;

    expect(cancelTrigger(h.triggers, trigger_id, NOW, h.secrets)).toEqual({ ok: true, changed: true });

    // The plaintext is gone from storage the moment the trigger closed — one
    // host call, one transaction on the single-threaded SQLite both backends run.
    expect(await h.secrets.get(spec.secret_id!)).toBeNull();
    // The audit half survives, and it never carried the secret.
    const row = h.triggers.get(trigger_id)!;
    expect(row.state).toBe('revoked');
    expect(row.revoked_at).toBe(NOW);
    expect(JSON.stringify(row.spec)).not.toContain('shhh');
    // A delivery against the revoked trigger reports why, and reads no secret.
    expect(await h.deliver({ trigger_id, bearer_header: 'Bearer shhh' }))
      .toEqual({ status: 'rejected', http_status: 503, reason: 'trigger revoked' });
  });

  test('repeat revocation is idempotent', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'bearer', secret: 'k' });
    expect(cancelTrigger(h.triggers, trigger_id, NOW, h.secrets).changed).toBe(true);
    expect(cancelTrigger(h.triggers, trigger_id, NOW + 1, h.secrets)).toEqual({ ok: true, changed: false });
  });

  test('secrets whose trigger is gone or terminal are purged; a live one survives', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initEventsHubTables(sql);
    const triggers = new TriggerRegistry(sql, { scheduleAt: async () => {}, currentAlarm: () => null });

    const live = await registerDurableWebhook(triggers, { label: 'live', auth_mode: 'bearer' }, NOW);
    const dying = await registerDurableWebhook(triggers, { label: 'old', auth_mode: 'bearer' }, NOW);
    triggers.revoke(dying.trigger_id, NOW);

    const secrets = createWebhookSecretStore(sql);
    secrets.put(live.secret_id, live.trigger_id, 'keep-me', NOW);
    secrets.put(dying.secret_id, dying.trigger_id, 'orphan-by-revocation', NOW);
    secrets.put('webhook_secret_ghost', 'trg-never-existed', 'orphan-by-absence', NOW);

    // A fresh activation rebuilds the store; the sweep runs with it.
    createWebhookSecretStore(sql);
    expect(await secrets.get(live.secret_id)).toBe('keep-me');
    expect(await secrets.get(dying.secret_id)).toBeNull();
    expect(await secrets.get('webhook_secret_ghost')).toBeNull();
  });
});
