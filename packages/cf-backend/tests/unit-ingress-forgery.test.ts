/**
 * Forged ingress through the real `worker.fetch` / `worker.email` into a real OrchestratorAgent;
 * defends: an object that stopped verifying signatures or senders while stubbed suites stay green.
 * The clock is pinned: the HMAC replay window and the dedupe bucket are both five minutes.
 */
import { afterAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { hmacSha256Hex } from '@kinu.run/core';
import {
  orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent,
  type RecordedUserPlaneCalls,
} from './helpers/actor-harness';
import { makeKv } from './helpers/kv';
import { workerContext } from './helpers/bindings';
// Type-only, so it is erased and cannot load the entry ahead of the SDK stub.
import type { RecentEventRow } from '../src/orchestrator';

const ORIGIN = 'https://app.example';

const ROUTE_SECRET = 'ingress-forgery-route-secret-0123456789';

const HOOK_SECRET = 'ingress-forgery-hook-secret';

const WORKSPACE = 'harness-actor';

const EMAIL_DOMAIN = 'agents.example.com';

const AGENT_ADDRESS = `${WORKSPACE}@${EMAIL_DOMAIN}`;

const OWNER_EMAIL = 'owner@example.com';

const ATTACKER_EMAIL = 'attacker@evil.example';

const BODY = '{"deploy":"prod"}';

const PINNED_NOW = new Date('2026-03-01T12:00:00.000Z');

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** The capability width `webhook-route.ts` mints. */
const CAPABILITY_HEX_CHARS = 32;

const RefusalSchema = v.object({ error: v.string() });

const AcceptedSchema = v.object({
  accepted: v.boolean(), event_id: v.string(), admitted: v.boolean(),
});

// Dynamic: the SDK stand-in `actor-harness` installs must precede the entry's `cloudflare:email` import.
const { default: worker } = await import('../src/server');

interface Workspace {
  readonly harness: ActorHarness<HarnessOrchestratorAgent>;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  /** Empty is the contract for a refusal that never reached the object. */
  readonly activations: string[];
  events(variant: 'webhook' | 'email'): Promise<RecentEventRow[]>;
}

/** The owner's address comes from the recording user plane, so the email gate never refuses "owner email unknown". */
function workspace(): Workspace {
  const userPlane: RecordedUserPlaneCalls = {
    warmConnections: [], failWarm: null, titles: [], profile: { email: OWNER_EMAIL },
  };

  const harness = orchestratorHarness(userPlane);
  harness.agent.declareWebhookRouteSecret(ROUTE_SECRET);
  harness.agent.harnessHoldsCapability('harness-token');

  const activations: string[] = [];
  const view: Partial<Env> = {};
  Object.assign(view, {
    AUTH_KV: makeKv(),
    CLI_PUBLIC_ORIGIN: ORIGIN,
    EMAIL_DOMAIN,
    WEBHOOK_ROUTE_SECRET: ROUTE_SECRET,
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        activations.push(name);

        return harness.agent;
      },
    },
    ASSETS: {
      fetch: async () => new Response('<!doctype html>', {
        headers: { 'content-type': 'text/html' },
      }),
    },
  });

  return {
    harness,
    // SAFETY: every member the two entry paths read is constructed above — the
    // knock budget, the published origin and SPA fallback the route table walks
    // past, the mail domain the recipient is resolved against, the route secret,
    // and the Orchestrator namespace both entries resolve the workspace through.
    // Nothing unassigned is reachable through this cast.
    env: view as Env,
    ctx: workerContext(),
    activations,
    async events(variant) {
      return await harness.agent.listRecentEvents({ variant });
    },
  };
}

/** A `null` signature or timestamp omits that header. */
function delivery(path: string, headers: {
  signature: string | null;
  timestamp: string | null;
}): Request {
  const sent = new Headers({ 'content-type': 'application/json' });

  if (headers.signature !== null) sent.set('x-kinu-signature', headers.signature);

  if (headers.timestamp !== null) sent.set('x-kinu-timestamp', headers.timestamp);

  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: sent, body: BODY });
}

function signed(timestamp: number): Promise<string> {
  return hmacSha256Hex(HOOK_SECRET, `${timestamp}.${BODY}`);
}

interface ConstructedMail {
  readonly message: ForwardableEmailMessage;
  /** Unauthorized mail is dropped, not rejected, so an agent address is no existence oracle. */
  readonly rejections: string[];
  readonly forwards: string[];
}

/** `headerFrom` is the sender-written MIME `From:`; the gate must read the envelope sender. */
function inboundMail(opts: {
  envelopeFrom: string;
  headerFrom?: string;
  messageId?: string;
}): ConstructedMail {
  const messageId = opts.messageId ?? '<forgery-1@mail.example.com>';

  const raw = [
    `From: ${opts.headerFrom ?? opts.envelopeFrom}`,
    `To: ${AGENT_ADDRESS}`,
    'Subject: Ship it',
    `Message-ID: ${messageId}`,
    'Content-Type: text/plain',
    '',
    'Deploy the release branch to production.',
  ].join('\r\n');

  const body = new Response(raw).body;

  if (!body) throw new Error('expected a raw message stream');
  const rejections: string[] = [];
  const forwards: string[] = [];
  const partial: Partial<ForwardableEmailMessage> = {};
  Object.assign(partial, {
    from: opts.envelopeFrom,
    to: AGENT_ADDRESS,
    headers: new Headers({ 'message-id': messageId }),
    raw: body,
    rawSize: raw.length,
    setReject: (reason: string) => { rejections.push(reason); },
    forward: async (to: string) => { forwards.push(to); },
    reply: async () => {},
  });

  // SAFETY: every member the inbound path reads is constructed by the
  // `Object.assign` above — `from`, `to`, `headers` and `raw`, verified against
  // the bodies of `handleInboundEmail` and `routeInboundEmail` — and the three
  // disposition methods the handler's type declares are constructed alongside
  // them. Nothing unassigned is reachable through this cast.
  return { message: partial as ForwardableEmailMessage, rejections, forwards };
}

beforeEach(() => {
  setSystemTime(PINNED_NOW);
});

afterAll(() => {
  setSystemTime();
});

describe('a webhook delivery nobody could sign reaches no event log', () => {
  async function hooked() {
    const ws = workspace();

    const hook = await ws.harness.agent.createDurableWebhook({
      label: 'ci', auth_mode: 'hmac', secret: HOOK_SECRET,
    });

    return { ws, hook };
  }

  test('a wrong signature is refused, and the workspace stores nothing', async () => {
    const { ws, hook } = await hooked();
    const now = Date.now();

    const response = await worker.fetch(delivery(hook.url, {
      signature: await hmacSha256Hex('the-secret-an-attacker-guessed', `${now}.${BODY}`),
      timestamp: String(now),
    }), ws.env, ws.ctx);

    expect(response.status).toBe(401);
    expect(v.parse(RefusalSchema, await response.json())).toEqual({ error: 'signature mismatch' });
    // The object was woken (signatures are checked in its own storage) and published nothing.
    expect(ws.activations).toEqual([ws.harness.agent.name]);
    expect(await ws.events('webhook')).toEqual([]);
  });

  test('a delivery with no signature at all is refused the same way', async () => {
    const { ws, hook } = await hooked();

    const response = await worker.fetch(
      delivery(hook.url, { signature: null, timestamp: null }), ws.env, ws.ctx,
    );

    expect(response.status).toBe(401);
    expect(v.parse(RefusalSchema, await response.json())).toEqual({ error: 'missing hmac headers' });
    expect(await ws.events('webhook')).toEqual([]);
  });

  test('a correctly signed delivery from outside the replay window is refused', async () => {
    const { ws, hook } = await hooked();
    // A genuine signature on a replayed delivery: only the clock refuses it.
    const stale = Date.now() - FIVE_MINUTES_MS - 1000;

    const response = await worker.fetch(delivery(hook.url, {
      signature: await signed(stale), timestamp: String(stale),
    }), ws.env, ws.ctx);

    expect(response.status).toBe(401);
    expect(v.parse(RefusalSchema, await response.json())).toEqual({ error: 'timestamp out of window' });
    expect(await ws.events('webhook')).toEqual([]);
  });

  test('an unminted delivery URL never resolves a workspace object at all', async () => {
    const { ws, hook } = await hooked();
    const now = Date.now();
    // The refusal is owed before the object: a correct signature must not buy an activation.
    const forgedPath = hook.url.slice(0, -CAPABILITY_HEX_CHARS) + '0'.repeat(CAPABILITY_HEX_CHARS);

    const response = await worker.fetch(delivery(forgedPath, {
      signature: await signed(now), timestamp: String(now),
    }), ws.env, ws.ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(ws.activations).toEqual([]);
    expect(await ws.events('webhook')).toEqual([]);
  });

  test('a verified delivery is admitted once, and its redelivery adds no second event', async () => {
    const { ws, hook } = await hooked();
    const now = Date.now();
    const signature = await signed(now);

    const send = () => worker.fetch(
      delivery(hook.url, { signature, timestamp: String(now) }), ws.env, ws.ctx,
    );

    const first = await send();
    expect(first.status).toBe(202);
    expect(v.parse(AcceptedSchema, await first.json())).toMatchObject({ accepted: true, admitted: true });

    const second = await send();
    expect(second.status).toBe(202);
    expect(v.parse(AcceptedSchema, await second.json())).toMatchObject({ accepted: true, admitted: false });

    const events = await ws.events('webhook');
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      ingress: 'webhook_hmac',
      variant: 'webhook',
      payload: { webhook_id: hook.trigger_id, body: { deploy: 'prod' } },
    });
  });
});

describe('hostile mail reaches no event log', () => {
  test('a forged From header does not make a stranger the owner', async () => {
    const ws = workspace();
    const mail = inboundMail({ envelopeFrom: ATTACKER_EMAIL, headerFrom: OWNER_EMAIL });

    await worker.email(mail.message, ws.env);

    // The gate read the authenticated envelope sender, not the typed header.
    expect(await ws.events('email')).toEqual([]);
    expect(mail.rejections).toEqual([]);
    expect(mail.forwards).toEqual([]);
  });

  test("the owner's mail is admitted once, and the edge's redelivery adds no second event", async () => {
    const ws = workspace();

    const mail = () => inboundMail({
      envelopeFrom: OWNER_EMAIL, messageId: '<retried@mail.example.com>',
    });

    await worker.email(mail().message, ws.env);
    // Cloudflare Email Routing retries; the Message-ID identifies the same message.
    await worker.email(mail().message, ws.env);

    const events = await ws.events('email');
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      ingress: 'email_inbound',
      variant: 'email',
      payload: { from: OWNER_EMAIL, to: AGENT_ADDRESS, message_id: '<retried@mail.example.com>' },
    });
  });
});
