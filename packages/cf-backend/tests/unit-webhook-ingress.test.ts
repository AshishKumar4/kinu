/**
 * The public webhook rail after route-capability verification and before the trigger's own auth: the caller
 * is unknown, so this governs cost (body size, knock rate). Unminted URLs: `unit-webhook-route.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initWebhookRateLimitTables,
  normalizeWebhookRateLimitPerMin,
  tryConsumeWebhookRateLimit,
  type SqlExec,
} from '@kinu.run/core';
import { sqlExec } from './helpers/user-do';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { makeKv } from './helpers/kv';
import { jsrpcStub } from './helpers/jsrpc-stub';
import type {
  WebhookDeliveryEnv, WebhookDeliveryResolver, WebhookDeliveryTarget,
} from '../src/events/routes';

// The route's module graph reaches `cloudflare:email` through `agents`, so the stub is installed before the dynamic import.
mockAgentsSdk();

const { handleWebhookDeliveryRequest } = await import('../src/events/routes');

const { webhookRoutePath } = await import('@kinu.run/core');

const ROUTE_SECRET = 'test-webhook-route-secret-0123456789';

function sqlFor(db: Database): SqlExec {
  return sqlExec(db);
}

const WORKSPACE = 'kinu-main';

/** A real ULID, the shape `TriggerRegistry.register` mints. */
const TRIGGER = '01HZY6QK9N4T7M2P8V3XABCDEF';

interface DeliveryProbe {
  /** Empty for every refusal: waking a workspace object to say no is the cost this rail bounds. */
  readonly woken: string[];
  bodyText: string | undefined;
}

interface Harness {
  readonly env: WebhookDeliveryEnv;
  readonly resolveAgent: WebhookDeliveryResolver;
  readonly probe: DeliveryProbe;
}

function harness(): Harness {
  const probe: DeliveryProbe = { woken: [], bodyText: undefined };

  const agent = jsrpcStub<WebhookDeliveryTarget>({
    acceptWebhookDelivery: async (opts) => {
      probe.bodyText = opts.body_text;

      return { status: 'admitted', event_id: 'evt_1', admitted: true };
    },
  });

  return {
    env: { AUTH_KV: makeKv(), WEBHOOK_ROUTE_SECRET: ROUTE_SECRET },
    resolveAgent: (name) => {
      probe.woken.push(name);

      return Promise.resolve(agent);
    },
    probe,
  };
}

async function delivery(
  body: BodyInit,
  init: { headers?: HeadersInit } = {},
): Promise<Request> {
  const path = await webhookRoutePath(ROUTE_SECRET, {
    workspaceName: WORKSPACE, triggerId: TRIGGER,
  });

  return new Request(`https://app.example${path}`, {
    method: 'POST', body, headers: init.headers,
  });
}

describe('what a signed webhook delivery may cost', () => {
  test('a body within the ceiling reaches the ingress byte for byte', async () => {
    const { env, probe, resolveAgent } = harness();
    const body = JSON.stringify({ note: 'x'.repeat(4096) });
    const response = await handleWebhookDeliveryRequest(await delivery(body), env, resolveAgent);

    expect(response?.status).toBe(202);
    expect(probe.bodyText).toBe(body);
  });

  test('a body over the ceiling is refused, and no workspace object is woken', async () => {
    const { env, probe, resolveAgent } = harness();
    const request = await delivery('x'.repeat(1024 * 1024 + 17));
    const response = await handleWebhookDeliveryRequest(request, env, resolveAgent);

    expect(response?.status).toBe(413);
    expect(probe.woken).toEqual([]);
    expect(probe.bodyText).toBeUndefined();
  });

  test('an announced length over the ceiling is refused before the body is read', async () => {
    const { env, probe, resolveAgent } = harness();

    const request = await delivery('{}', {
      headers: { 'content-length': String(8 * 1024 * 1024) },
    });

    const response = await handleWebhookDeliveryRequest(request, env, resolveAgent);

    expect(response?.status).toBe(413);
    expect(probe.woken).toEqual([]);
  });

  test('one source cannot knock without bound', async () => {
    const { env, probe, resolveAgent } = harness();
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    let refused: Response | null = null;

    for (let attempt = 0; attempt < 61 && !refused; attempt += 1) {
      const response = await handleWebhookDeliveryRequest(
        await delivery('{}', { headers }), env, resolveAgent,
      );

      if (response?.status === 429) refused = response;
    }

    expect(refused?.status).toBe(429);
    expect(probe.woken.length).toBe(60);
  });
});

describe('webhook rate limits', () => {
  test('normalizes configured limits', () => {
    expect(normalizeWebhookRateLimitPerMin(undefined)).toBe(60);
    expect(normalizeWebhookRateLimitPerMin(1)).toBe(1);
    expect(normalizeWebhookRateLimitPerMin('42')).toBe(42);
    expect(() => normalizeWebhookRateLimitPerMin(0)).toThrow(/rate_limit_per_min/);
    expect(() => normalizeWebhookRateLimitPerMin(1.5)).toThrow(/rate_limit_per_min/);
    expect(() => normalizeWebhookRateLimitPerMin(10_001)).toThrow(/rate_limit_per_min/);
  });

  test('admits only the configured number of verified deliveries per trigger per minute', () => {
    const db = new Database(':memory:');
    const sql = sqlFor(db);
    initWebhookRateLimitTables(sql);

    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 10_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 20_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 30_000)).toMatchObject({ allowed: false, remaining: 0 });

    expect(tryConsumeWebhookRateLimit(sql, 'trg-b', 2, 30_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(tryConsumeWebhookRateLimit(sql, 'trg-a', 2, 61_000)).toMatchObject({ allowed: true, remaining: 1 });
  });
});
