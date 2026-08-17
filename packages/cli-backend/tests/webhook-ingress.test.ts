// Webhook ingress on the local backend — the same gate the cloud backend runs,
// reached through a real LocalAgentSession over a real workspace database.
//
// A local workspace has no inbound HTTP transport and mints no URL: what this
// proves is that the capability is REACHABLE here — register a webhook, hand a
// delivery to the session, and a verified one becomes a pending event while an
// unverified one leaves nothing behind. The gate's own matrix (every rejection
// status and reason, the replay window, the rate window) is proven once, in
// core/tests/unit-webhook-ingress.test.ts.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model.js';
import { hmacSha256Hex, type LLMProviderConfig, type WebhookDelivery } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession } from '../src/local-session.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** Never asked for inference: no turn runs here, only ingress. */
const idleModel: LanguageModel = new TestLanguageModelV2({ provider: 'fake', modelId: 'fake-model' });

const sessions: LocalAgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.end();
});

function localSession(): LocalAgentSession {
  const db = new Database(':memory:');
  const rt = createCLIRuntime(db, {
    dbPath: `/tmp/proteus-webhook-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM,
  });
  const session = new LocalAgentSession({
    rt, db, model: idleModel, noAutoEvolve: true, onEvent: () => {},
  });
  sessions.push(session);
  return session;
}

function delivery(over: Partial<WebhookDelivery> & { trigger_id: string }): WebhookDelivery {
  return {
    method: 'POST',
    headers: { 'user-agent': 'ci' },
    body_text: '{"build":"green"}',
    cf_mtls_verified: false,
    delivery_id: null,
    hmac_signature: null,
    hmac_timestamp: null,
    bearer_header: null,
    content_type: 'application/json',
    now: Date.now(),
    ...over,
  };
}

describe('local webhook ingress', () => {
  test('a bearer-authed delivery publishes an event the next turn drains', async () => {
    const session = localSession();
    const webhook = await session.createDurableWebhook({
      label: 'ci', auth_mode: 'bearer', secret: 'deploy-key',
    });
    // No URL is promised: this backend has nothing listening.
    expect(webhook).toMatchObject({ auth_mode: 'bearer', secret: 'deploy-key' });
    expect(session.listTriggers().triggers.map((t) => t.kind)).toEqual(['webhook_durable']);
    // …and the secret is not in what the operator surface can read back.
    expect(JSON.stringify(session.listTriggers())).not.toContain('deploy-key');

    const result = await session.acceptWebhookDelivery(delivery({
      trigger_id: webhook.trigger_id, bearer_header: 'Bearer deploy-key',
    }));

    expect(result).toMatchObject({ status: 'admitted', admitted: true });
    const [event] = session.pendingEvents();
    expect(event.ingress).toBe('webhook_bearer');
    expect(event.payload).toMatchObject({
      webhook_id: webhook.trigger_id, http_method: 'POST', body: { build: 'green' },
    });
  });

  test('an hmac-signed delivery is admitted on the same signed material', async () => {
    const session = localSession();
    const webhook = await session.createDurableWebhook({ label: 'ci', auth_mode: 'hmac', secret: 'k' });
    const now = Date.now();
    const body_text = '{"build":"green"}';

    const result = await session.acceptWebhookDelivery(delivery({
      trigger_id: webhook.trigger_id, now, body_text,
      hmac_timestamp: String(now),
      hmac_signature: await hmacSha256Hex('k', `${now}.${body_text}`),
    }));

    expect(result.status).toBe('admitted');
    expect(session.pendingEvents()[0].ingress).toBe('webhook_hmac');
  });

  test('a wrong bearer is refused, and refusal leaves no event behind', async () => {
    const session = localSession();
    const webhook = await session.createDurableWebhook({
      label: 'ci', auth_mode: 'bearer', secret: 'deploy-key',
    });

    expect(await session.acceptWebhookDelivery(delivery({
      trigger_id: webhook.trigger_id, bearer_header: 'Bearer guessed',
    }))).toEqual({ status: 'rejected', http_status: 401, reason: 'bearer mismatch' });

    expect(session.pendingEvents()).toEqual([]);
  });

  test('the local rate window refuses past the configured budget', async () => {
    const session = localSession();
    const webhook = await session.createDurableWebhook({
      label: 'ci', auth_mode: 'bearer', secret: 'k', rate_limit_per_min: 1,
    });
    const send = (n: number) => session.acceptWebhookDelivery(delivery({
      trigger_id: webhook.trigger_id, bearer_header: 'Bearer k', delivery_id: `d-${n}`,
    }));

    expect(await send(1)).toMatchObject({ status: 'admitted' });
    expect(await send(2))
      .toEqual({ status: 'rejected', http_status: 429, reason: 'rate limit exceeded (1/min)' });
  });

  test('a cancelled webhook stops accepting deliveries', async () => {
    const session = localSession();
    const webhook = await session.createDurableWebhook({
      label: 'ci', auth_mode: 'bearer', secret: 'k',
    });

    expect(session.cancelTrigger(webhook.trigger_id)).toEqual({ ok: true, changed: true });
    expect(await session.acceptWebhookDelivery(delivery({
      trigger_id: webhook.trigger_id, bearer_header: 'Bearer k',
    }))).toEqual({ status: 'rejected', http_status: 503, reason: 'trigger revoked' });
  });
});
