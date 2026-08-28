/**
 * Forged ingress, driven through the two entry points a stranger can actually
 * reach: `worker.fetch` on a minted delivery URL, and `worker.email`.
 *
 * WHAT WAS MISSING. The refusals themselves are proven at the functions that
 * make them: `packages/core/tests/unit-webhook-ingress.test.ts` for a wrong,
 * missing or stale HMAC and for replay, and `unit-email-ingress.test.ts` for
 * the sender trust gate. What had no test was the CHAIN that has to arrive at
 * them. The two cf webhook suites stop short of it on purpose —
 * `unit-webhook-ingress.test.ts` measures what a delivery may COST before the
 * object is woken, `unit-webhook-route.test.ts` measures the route capability —
 * and both answer `acceptWebhookDelivery` with a stub that always accepts,
 * while the email gate is driven at the routing function with a mocked delivery
 * target. So a Durable Object that stopped verifying signatures, or an inbox
 * that stopped asking who sent the mail, would keep every one of those suites
 * green.
 *
 * So nothing here doubles the ingress. The Worker entry is `src/server.ts`, the
 * object behind it is a real `OrchestratorAgent` over its own SQLite, the
 * webhook trigger and its secret are created through the production
 * `createDurableWebhook`, and the oracle is that workspace's own event log read
 * back through `listRecentEvents` — the same rows the operator reads. A refusal
 * is proven by the absence of a row, which is the only thing that distinguishes
 * a rejected delivery from an accepted one the caller was lied to about.
 *
 * The clock is pinned because two of the properties are stated in time: the
 * HMAC replay window is five minutes wide, and the webhook dedupe key buckets
 * by five minutes, so an unpinned run could straddle either boundary.
 */
import { afterAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { hmacSha256Hex } from '@kinu.run/core';
import {
  orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent,
  type RecordedUserPlaneCalls,
} from './helpers/actor-harness';
import { makeKv } from './helpers/kv';
// Type-only, so it is erased and cannot load the entry ahead of the SDK stub.
import type { RecentEventRow } from '../src/orchestrator';

const ORIGIN = 'https://app.example';
/** The deployment secret that mints and verifies a delivery URL. */
const ROUTE_SECRET = 'ingress-forgery-route-secret-0123456789';
/** The shared secret the sender is supposed to sign a delivery with. */
const HOOK_SECRET = 'ingress-forgery-hook-secret';
/** The workspace `makeCtx` names, which is also the local part of its address. */
const WORKSPACE = 'harness-actor';
const EMAIL_DOMAIN = 'agents.example.com';
const AGENT_ADDRESS = `${WORKSPACE}@${EMAIL_DOMAIN}`;
const OWNER_EMAIL = 'owner@example.com';
const ATTACKER_EMAIL = 'attacker@evil.example';
const BODY = '{"deploy":"prod"}';
/** Pinned so the replay window and the dedupe bucket are the same on every run. */
const PINNED_NOW = new Date('2026-03-01T12:00:00.000Z');
const FIVE_MINUTES_MS = 5 * 60 * 1000;
/** Hex characters of the route capability a delivery path ends in — the width
 *  `webhook-route.ts` mints, so replacing exactly that tail leaves a path whose
 *  shape still matches and whose capability this deployment never issued. */
const CAPABILITY_HEX_CHARS = 32;

/** The two answers the delivery route gives, parsed rather than asserted: the
 *  body is `unknown` until something reads it, and WHICH refusal arrived is
 *  half of what these cases are about. */
const RefusalSchema = v.object({ error: v.string() });
const AcceptedSchema = v.object({
  accepted: v.boolean(), event_id: v.string(), admitted: v.boolean(),
});

// Dynamic because the entry's module graph reaches `cloudflare:email` through
// `agents`, which exists only inside workerd: the SDK stand-in `actor-harness`
// installs has to be in place before this module loads, and a static import
// would be hoisted above it. Every cf-backend route suite loads the entry this
// way for the same reason.
const { default: worker } = await import('../src/server');

interface Workspace {
  readonly harness: ActorHarness<HarnessOrchestratorAgent>;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  /** Workspace names the Worker resolved an Orchestrator stub for. Empty is the
   *  contract for a refusal that never reached the object at all. */
  readonly activations: string[];
  /** Rows of one variant in the workspace's own log, read the operator's way. */
  events(variant: 'webhook' | 'email'): Promise<RecentEventRow[]>;
}

/**
 * A real workspace behind a real Worker.
 *
 * The owner's verified address is served by the recording user plane, because
 * the email gate asks the owner's UserDO for it and a refusal there would read
 * as "owner email unknown" — a different refusal from the one under test.
 */
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
  const partialCtx: Partial<ExecutionContext> = {};
  Object.assign(partialCtx, { waitUntil() {}, passThroughOnException() {} });

  return {
    harness,
    // SAFETY: every member the two entry paths read is constructed above — the
    // knock budget, the published origin and SPA fallback the route table walks
    // past, the mail domain the recipient is resolved against, the route secret,
    // and the Orchestrator namespace both entries resolve the workspace through.
    // Nothing unassigned is reachable through this cast.
    env: view as Env,
    // SAFETY: both members of the entry's ExecutionContext contract.
    ctx: partialCtx as ExecutionContext,
    activations,
    async events(variant) {
      return await harness.agent.listRecentEvents({ variant });
    },
  };
}

/** One delivery on the URL this workspace minted, signed however the caller
 *  says. A `null` signature or timestamp omits that header, which is what a
 *  sender that never had the secret sends. */
function delivery(path: string, headers: {
  signature: string | null;
  timestamp: string | null;
}): Request {
  const sent = new Headers({ 'content-type': 'application/json' });
  if (headers.signature !== null) sent.set('x-kinu-signature', headers.signature);
  if (headers.timestamp !== null) sent.set('x-kinu-timestamp', headers.timestamp);
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: sent, body: BODY });
}

/** The signature this trigger's secret produces for the delivery body at an
 *  instant — what a sender that holds the secret sends, and the only thing the
 *  workspace admits. */
function signed(timestamp: number): Promise<string> {
  return hmacSha256Hex(HOOK_SECRET, `${timestamp}.${BODY}`);
}

/** A constructed message plus what the handler did with it at SMTP. */
interface ConstructedMail {
  readonly message: ForwardableEmailMessage;
  /** Reasons the message was refused to the sending server. Unauthorized mail
   *  is DROPPED instead of rejected, so an agent address cannot be used as an
   *  existence oracle — an empty list is that policy holding. */
  readonly rejections: string[];
  /** Addresses the message was forwarded on to. */
  readonly forwards: string[];
}

/** One raw message as the mail edge hands it over. `headerFrom` is the MIME
 *  `From:` line, which a sender writes and can therefore lie in; the envelope
 *  sender is the separate argument the gate is supposed to read. */
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
    // The object WAS woken — the signature is checked in the workspace's own
    // storage, which is the point of doing it there — and it published nothing.
    expect(ws.activations).toEqual([WORKSPACE]);
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
    // A captured delivery, replayed: the signature is genuine and matches its
    // own timestamp. Only the clock refuses it.
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
    // The same signed body on a path whose route capability this deployment
    // never issued. The refusal is owed BEFORE the object, so a correct trigger
    // signature must not buy an activation.
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

    // What a sender's retry looks like: byte-identical, and still verified.
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

    // The gate read the envelope sender the mail edge authenticated, not the
    // line the sender typed, so nothing was stored and no turn was woken.
    expect(await ws.events('email')).toEqual([]);
    // And the stranger learns nothing: the message is dropped, not bounced.
    expect(mail.rejections).toEqual([]);
    expect(mail.forwards).toEqual([]);
  });

  test("the owner's mail is admitted once, and the edge's redelivery adds no second event", async () => {
    const ws = workspace();
    const mail = () => inboundMail({
      envelopeFrom: OWNER_EMAIL, messageId: '<retried@mail.example.com>',
    });

    await worker.email(mail().message, ws.env);
    // Cloudflare Email Routing retries the same message; the Message-ID is what
    // says it is the same one.
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
