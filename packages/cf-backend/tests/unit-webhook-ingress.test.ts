/**
 * The public webhook rail, at the gates it spends once the URL's route
 * capability has been verified and before the trigger's own HMAC/Bearer/mTLS
 * check has been. Reaching this far proves only that this deployment minted the
 * URL, not who is holding it, so what this file governs is cost: a body a
 * caller chose the size of, and a knock rate a caller chose.
 *
 * Whether an unminted URL can get here at all is
 * `unit-webhook-route.test.ts`'s subject.
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

// The route's module graph reaches `cloudflare:email` through `agents`, so the
// stub has to be installed before it loads — one shared mock, then the dynamic
// import, the ordering every cf-backend route test uses.
mockAgentsSdk();

const { handleWebhookDeliveryRequest } = await import('../src/events/routes');
const { webhookRoutePath } = await import('../src/events/webhook-route');

/** The one route secret this suite mints and verifies under. */
const ROUTE_SECRET = 'test-webhook-route-secret-0123456789';

function sqlFor(db: Database): SqlExec {
  return sqlExec(db);
}

const WORKSPACE = 'kinu-main';
/** A real ULID, the shape `TriggerRegistry.register` mints. */
const TRIGGER = '01HZY6QK9N4T7M2P8V3XABCDEF';

interface DeliveryProbe {
  /** Names the route resolved an orchestrator stub for. Empty is the contract
   *  for every refusal below: a workspace object woken to be told no is the
   *  cost this rail exists to bound. */
  readonly woken: string[];
  /** The body text the ingress was handed, if it got that far. */
  bodyText: string | undefined;
}

interface Harness {
  readonly env: Env;
  readonly probe: DeliveryProbe;
}

function harness(): Harness {
  const probe: DeliveryProbe = { woken: [], bodyText: undefined };
  const agent = jsrpcStub({
    acceptWebhookDelivery: async (opts: { body_text: string }) => {
      probe.bodyText = opts.body_text;
      return { status: 'accepted' as const, event_id: 'evt_1', admitted: true };
    },
  });
  // The doubles are deliberately NOT typed as the bindings they stand in for:
  // a fake `idFromName` returning the name can never satisfy `DurableObjectId`,
  // and `jsrpcStub`'s prototype-bound methods can never satisfy
  // `DurableObjectStub`. `Object.assign` is what lets the members land without
  // the type system adjudicating the fakes.
  const view: Partial<Env> = {};
  Object.assign(view, {
    AUTH_KV: makeKv(),
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        probe.woken.push(name);
        return agent;
      },
    },
    WEBHOOK_ROUTE_SECRET: ROUTE_SECRET,
  });
  // SAFETY: the three members the route reads are constructed by the
  // Object.assign above — `AUTH_KV` (the knock budget), `WEBHOOK_ROUTE_SECRET`
  // (the route capability) and `OrchestratorAgent.get` (the ingress double) are
  // the complete set the delivery path touches, verified against its body.
  // Nothing unassigned is reachable through this cast.
  return { env: view as Env, probe };
}

/** A delivery on a URL the server minted, which is the only kind that reaches
 *  the gates this suite is about. */
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
    const { env, probe } = harness();
    const body = JSON.stringify({ note: 'x'.repeat(4096) });
    const response = await handleWebhookDeliveryRequest(await delivery(body), env);

    expect(response?.status).toBe(202);
    expect(probe.bodyText).toBe(body);
  });

  test('a body over the ceiling is refused, and no workspace object is woken', async () => {
    const { env, probe } = harness();
    const request = await delivery('x'.repeat(1024 * 1024 + 17));
    const response = await handleWebhookDeliveryRequest(request, env);

    expect(response?.status).toBe(413);
    expect(probe.woken).toEqual([]);
    expect(probe.bodyText).toBeUndefined();
  });

  test('an announced length over the ceiling is refused before the body is read', async () => {
    const { env, probe } = harness();
    const request = await delivery('{}', {
      headers: { 'content-length': String(8 * 1024 * 1024) },
    });
    const response = await handleWebhookDeliveryRequest(request, env);

    expect(response?.status).toBe(413);
    expect(probe.woken).toEqual([]);
  });

  test('one source cannot knock without bound', async () => {
    const { env, probe } = harness();
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    let refused: Response | null = null;
    for (let attempt = 0; attempt < 61 && !refused; attempt += 1) {
      const response = await handleWebhookDeliveryRequest(
        await delivery('{}', { headers }), env,
      );
      if (response?.status === 429) refused = response;
    }

    expect(refused?.status).toBe(429);
    // 60 admitted knocks, and the 61st woke nothing.
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
