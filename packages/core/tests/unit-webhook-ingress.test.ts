// Webhook ingress over a real hub. Every rejection asserts exact status and reason: operators
// debug integrations against the reason, and one 401 has several.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  EventLog, ReplyChannelStore, TriggerRegistry,
  acceptWebhookDelivery, createWebhookSecretStore, hmacSha256Hex,
  initEventsHubTables, initWebhookIngressTables, registerDurableWebhook, cancelTrigger,
  type SqlExec, type WebhookDelivery,
} from '../src/index';
import type { WebhookTriggerSpec } from '../src/events/ingress/webhook';
import { createMemoryVfs, createTestActors, present } from '@kinu.run/test-utils';
import { makeSqlExec, makeSql as taggedSql, makeExecRaw } from './helpers';
import type { ActorHandle } from '../src/identity/actor-handle';

function makeSql(db: Database): SqlExec {
  return makeSqlExec(db);
}

/** Hub tables are actor-keyed; one handle is threaded through registry, log and reply store. */
function actorOver(db: Database): ActorHandle {
  return createTestActors(taggedSql(db), makeExecRaw(db)).main;
}

const NOW = 1_700_000_000_000;

function hub() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initEventsHubTables(sql);
  initWebhookIngressTables(sql);
  const actor = actorOver(db);
  const log = new EventLog(sql, actor);
  const triggers = new TriggerRegistry(sql, actor, { scheduleAt: async () => {} });
  const secrets = createWebhookSecretStore(sql);
  const { vfs, files } = createMemoryVfs();
  let drains = 0;

  const deps = {
    triggers, log, secrets, sql, vfs,
    replies: new ReplyChannelStore(sql, actor),
    onAdmitted: () => { drains += 1; },
  };

  const register = async (
    opts: Parameters<typeof registerDurableWebhook>[2],
  ): Promise<string> => (await registerDurableWebhook(triggers, secrets, opts, NOW)).trigger_id;

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

  /** The durable one-time claims, as rows — the state a replay is refused by. */
  const claims = () =>
    db.query<{ claim: string; event_id: string | null; expires_at: number }, []>(
      'SELECT claim, event_id, expires_at FROM webhook_replay_claims ORDER BY expires_at',
    ).all();

  return { deps, triggers, log, secrets, files, register, deliver, claims, drains: () => drains };
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

  test('the same signed request is admitted ONCE, across a dedupe-bucket boundary', async () => {
    // Freshness is not single-use: a capture replayed across a dedupe-bucket boundary inside the
    // ±5 minute window must not publish a second event.
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'hmac', secret: 'k' });
    const body_text = '{"deploy":"prod"}';

    const signed = {
      trigger_id, body_text,
      hmac_timestamp: String(NOW),
      hmac_signature: await hmacSha256Hex('k', `${NOW}.${body_text}`),
    };

    // Just before an aligned bucket boundary, and just after it: two different
    // dedupe buckets, one signature.
    const beforeBoundary = Math.floor((NOW + 5 * 60 * 1000) / (5 * 60 * 1000)) * (5 * 60 * 1000) - 1_000;
    const afterBoundary = beforeBoundary + 2_000;

    const first = await h.deliver({ ...signed, now: beforeBoundary });
    const replay = await h.deliver({ ...signed, now: afterBoundary });

    expect(first).toMatchObject({ status: 'admitted', admitted: true });
    expect(replay).toMatchObject({ status: 'admitted', event_id: first.event_id, admitted: false });
    expect(h.log.pending({ variant: 'webhook' })).toHaveLength(1);
    expect(h.drains()).toBe(1);
  });

  test('a re-signed retry of the same event still dedupes on its body', async () => {
    // Additive: a re-signed retry is a different artifact; body-hash dedupe still collapses it.
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'hmac', secret: 'k' });
    const body_text = '{"deploy":"prod"}';

    const first = await h.deliver({
      trigger_id, body_text, now: NOW,
      hmac_timestamp: String(NOW),
      hmac_signature: await hmacSha256Hex('k', `${NOW}.${body_text}`),
    });

    const resigned = await h.deliver({
      trigger_id, body_text, now: NOW + 1_000,
      hmac_timestamp: String(NOW + 1_000),
      hmac_signature: await hmacSha256Hex('k', `${NOW + 1_000}.${body_text}`),
    });

    expect(first).toMatchObject({ admitted: true });
    expect(resigned).toMatchObject({ event_id: first.event_id, admitted: false });
    expect(h.drains()).toBe(1);
  });

  test('a claim expires with the window it covered, so the table does not grow', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'hmac', secret: 'k' });
    const body_text = '{"n":1}';
    await h.deliver({
      trigger_id, body_text, now: NOW,
      hmac_timestamp: String(NOW),
      hmac_signature: await hmacSha256Hex('k', `${NOW}.${body_text}`),
    });
    expect(h.claims()).toHaveLength(1);

    // Past the first signature's window, the spent claim is swept.
    const later = NOW + 6 * 60 * 1000;
    await h.deliver({
      trigger_id, body_text: '{"n":2}', now: later,
      hmac_timestamp: String(later),
      hmac_signature: await hmacSha256Hex('k', `${later}.{"n":2}`),
    });
    expect(h.claims().map((row) => row.expires_at)).toEqual([later + 5 * 60 * 1000]);
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

  test('bearer: absent, malformed, wrong, and revoked secrets are all 401', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'bearer', secret: 'shhh' });
    const rejected = (reason: string) => ({ status: 'rejected' as const, http_status: 401, reason });

    expect(await h.deliver({ trigger_id })).toEqual(rejected('missing bearer'));
    expect(await h.deliver({ trigger_id, bearer_header: 'shhh' })).toEqual(rejected('missing bearer'));
    expect(await h.deliver({ trigger_id, bearer_header: 'Bearer nope' })).toEqual(rejected('bearer mismatch'));
    // Constant-time compare is length-first: a prefix is a mismatch.
    expect(await h.deliver({ trigger_id, bearer_header: 'Bearer shh' })).toEqual(rejected('bearer mismatch'));

    // Registration mints a secret for every bearer webhook, so an empty store means revoked.
    const revoked = await h.register({ label: 'revoked-secret', auth_mode: 'bearer', secret: 'shhh' });
    h.secrets.deleteByTrigger(revoked);
    expect(await h.deliver({ trigger_id: revoked, bearer_header: 'Bearer shhh' }))
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

    // ±5 minutes, inclusive, in both directions.
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

    // A different body or timestamp is a mismatch: the timestamp is signed material.
    expect(await h.deliver({
      trigger_id, body_text, hmac_timestamp: String(NOW), hmac_signature: await hmacSha256Hex('k', `${NOW}.{}`),
    })).toEqual(rejected('signature mismatch'));
    expect(await h.deliver({
      trigger_id, body_text, hmac_timestamp: String(NOW), hmac_signature: await sign(NOW - 1000),
    })).toEqual(rejected('signature mismatch'));
    expect(await h.deliver({
      trigger_id, body_text, hmac_timestamp: String(NOW), hmac_signature: await hmacSha256Hex('other', `${NOW}.${body_text}`),
    })).toEqual(rejected('signature mismatch'));

    const revoked = await h.register({ label: 'revoked-secret', auth_mode: 'hmac', secret: 'k' });
    h.secrets.deleteByTrigger(revoked);
    expect(await h.deliver({
      trigger_id: revoked, body_text, hmac_timestamp: String(NOW), hmac_signature: await sign(NOW),
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
    const triggers = new TriggerRegistry(sql, actorOver(db), { scheduleAt: async () => {} });
    const secrets = createWebhookSecretStore(sql);

    const webhook = await registerDurableWebhook(triggers, secrets, { label: 'ci', auth_mode: 'bearer', secret: 'shhh' }, NOW);

    const row = present(triggers.get(webhook.trigger_id), 'the registered trigger');
    expect(JSON.stringify(row.spec)).not.toContain('shhh');
    expect(row.spec).toEqual({
      label: 'ci', auth_mode: 'bearer', secret_id: webhook.secret_id,
      accepted_content_type: 'application/json',
    });
    expect(row.rate_limit_per_min).toBe(60);
    expect(row.creator_trust).toBe('owner');
    // Stored where only the ingress reads it, and handed back exactly once.
    expect(await secrets.get(webhook.secret_id)).toBe('shhh');
    expect(webhook.secret).toBe('shhh');
  });

  test('an hmac webhook created with no secret gets a minted one, not an unusable trigger', async () => {
    // `secret` is minted when omitted, since `auth_mode` defaults to hmac and no route can set one later.
    const h = hub();

    const created = await registerDurableWebhook(
      h.triggers, h.secrets, { label: 'ci', auth_mode: 'hmac' }, NOW,
    );

    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.secrets.get(created.secret_id)).toBe(created.secret);

    // And the minted secret is the one deliveries are verified against.
    const body_text = '{"ok":true}';
    expect(await h.deliver({
      trigger_id: created.trigger_id, body_text,
      hmac_timestamp: String(NOW),
      hmac_signature: await hmacSha256Hex(present(created.secret, 'the minted webhook secret'), `${NOW}.${body_text}`),
    })).toMatchObject({ status: 'admitted', admitted: true });
  });

  test('a blank secret is a missing one, and mTLS is minted none', async () => {
    const h = hub();

    const blank = await registerDurableWebhook(
      h.triggers, h.secrets, { label: 'blank', auth_mode: 'bearer', secret: '   ' }, NOW,
    );

    expect(blank.secret).toMatch(/^[0-9a-f]{64}$/);

    const mtls = await registerDurableWebhook(
      h.triggers, h.secrets, { label: 'partner', auth_mode: 'mtls' }, NOW,
    );

    expect(mtls.secret).toBeNull();
    expect(await h.secrets.get(mtls.secret_id)).toBeNull();
  });

  test('a secret that cannot be stored leaves no active trigger behind', async () => {
    const h = hub();

    const refusing = {
      put: () => { throw new Error('disk is unwell'); },
      deleteByTrigger: (trigger_id: string) => h.secrets.deleteByTrigger(trigger_id),
    };

    await expect(registerDurableWebhook(
      h.triggers, refusing, { label: 'ci', auth_mode: 'hmac' }, NOW,
    )).rejects.toThrow(/secret could not be stored/);

    // Fail-closed: a revoked row survives, not an unauthenticatable ingress.
    expect(h.triggers.list().map((row) => row.state)).toEqual(['revoked']);
  });

  test('an out-of-range rate limit is refused before a trigger row exists', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initEventsHubTables(sql);
    const triggers = new TriggerRegistry(sql, actorOver(db), { scheduleAt: async () => {} });
    const secrets = createWebhookSecretStore(sql);

    await expect(registerDurableWebhook(
      triggers, secrets, { label: 'ci', auth_mode: 'bearer', rate_limit_per_min: 0 }, NOW,
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
    const spec: Partial<WebhookTriggerSpec> = present(h.triggers.get(trigger_id), 'the registered trigger').spec;

    expect(cancelTrigger({ registry: h.triggers, trigger_id, now: NOW, caller: 'owner', secrets: h.secrets })).toEqual({ ok: true, changed: true });

    // Plaintext is gone from storage in the same transaction that closes the trigger.
    expect(await h.secrets.get(present(spec.secret_id, 'the stored secret id'))).toBeNull();
    // The audit half survives, and it never carried the secret.
    const row = present(h.triggers.get(trigger_id), 'the registered trigger');
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
    expect(cancelTrigger({ registry: h.triggers, trigger_id, now: NOW, caller: 'owner', secrets: h.secrets }).changed).toBe(true);
    expect(cancelTrigger({ registry: h.triggers, trigger_id, now: NOW + 1, caller: 'owner', secrets: h.secrets })).toEqual({ ok: true, changed: false });
  });

  test('a model turn cannot close the owner-created ingress whose id it can read', async () => {
    const h = hub();
    const trigger_id = await h.register({ label: 'ci', auth_mode: 'bearer', secret: 'shhh' });
    const spec: Partial<WebhookTriggerSpec> = present(h.triggers.get(trigger_id), 'the registered trigger').spec;

    // `agent.cancelSchedule` reaches the same host call as the operator's route.
    expect(cancelTrigger({ registry: h.triggers, trigger_id, now: NOW, caller: 'self', secrets: h.secrets })).toEqual({
      ok: false,
      changed: false,
      error: 'this trigger was created by the owner; only the owner can revoke it',
    });

    expect(present(h.triggers.get(trigger_id), 'the registered trigger').state).toBe('active');
    expect(await h.secrets.get(present(spec.secret_id, 'the stored secret id'))).toBe('shhh');

    // The owner's own surface is unchanged.
    expect(cancelTrigger({ registry: h.triggers, trigger_id, now: NOW, caller: 'owner', secrets: h.secrets }).changed).toBe(true);
  });

  test('a model turn may still close a schedule of its own making', async () => {
    const h = hub();

    // `agent.schedule` leaves the model's own timer, not the owner's ingress.
    const own = await h.triggers.register({
      kind: 'timer_oneshot',
      spec: { atMs: NOW + 60_000 },
      creator_trust: 'authenticated',
    }, NOW);

    expect(cancelTrigger({ registry: h.triggers, trigger_id: own, now: NOW, caller: 'self', secrets: h.secrets })).toEqual({ ok: true, changed: true });
  });

  test('secrets whose trigger is gone or terminal are purged; a live one survives', async () => {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    initEventsHubTables(sql);
    const triggers = new TriggerRegistry(sql, actorOver(db), { scheduleAt: async () => {} });
    const secrets = createWebhookSecretStore(sql);

    const live = await registerDurableWebhook(triggers, secrets, { label: 'live', auth_mode: 'bearer' }, NOW);
    const dying = await registerDurableWebhook(triggers, secrets, { label: 'old', auth_mode: 'bearer' }, NOW);
    triggers.revoke(dying.trigger_id, NOW);
    secrets.put('webhook_secret_ghost', 'trg-never-existed', 'orphan-by-absence', NOW);

    // A fresh activation rebuilds the store; the sweep runs with it.
    createWebhookSecretStore(sql);
    expect(await secrets.get(live.secret_id)).toBe(live.secret);
    expect(await secrets.get(dying.secret_id)).toBeNull();
    expect(await secrets.get('webhook_secret_ghost')).toBeNull();
  });
});
