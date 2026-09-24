/** Hub routes (triggers, events, email) behind the workspace gate; grants need step-up. Public delivery: `webhookDeliveryRoutes`. */

import { Hono, type Context } from 'hono';
import type { OrchestratorAgent } from '../orchestrator';
import type { KvStore } from '@kinu.run/agent-utils';
import {
  boundEventQuery, DEFAULT_RATE_LIMIT_PER_MIN, normalizeWebhookRateLimitPerMin,
} from '@kinu.run/core';
import { err, json, readBounded, safeJson } from '@kinu.run/core';
import { ingressAdmitted, ingressDenied, peerIp } from '@kinu.run/core';
import { isFreshAuthTime } from '../auth/session';
import { AUTH_TIME_HEADER } from '../cli/rpc-gate';
import {
  matchWebhookDeliveryPath, verifyWebhookRoute, webhookRouteSecret,
  WEBHOOK_ROUTE_UNAVAILABLE, type SignedWebhookRoute,
} from '@kinu.run/core';
import * as v from 'valibot';
import { diagnostics, KinuError, renderThrownChain } from '@kinu.run/core/obs';
import { rawParam, type FamilyEnv } from '../api/context';
import { LITERAL_WORKSPACE, type WorkspaceVariables } from '../api/workspace';

/**
 * Bounds spent against an anonymous caller. The body ceiling refuses rather than truncates (the HMAC covers exact bytes);
 * the knock budget is derived from `DEFAULT_RATE_LIMIT_PER_MIN` so it moves with the product rate. See `lib/ingress-budget.ts`.
 */
const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;

const WEBHOOK_KNOCKS_PER_WINDOW = DEFAULT_RATE_LIMIT_PER_MIN;

const OVER_WEBHOOK_BODY_LIMIT = 'webhook body over the 1 MiB limit';

export const WebhookRequestSchema = v.object({
  label: v.optional(v.string()),
  auth_mode: v.optional(v.picklist(['hmac', 'bearer', 'mtls'])),
  secret: v.optional(v.string()),
  accepted_content_type: v.optional(v.string()),
  rate_limit_per_min: v.optional(v.number()),
});

const RequestCfSchema = v.object({
  tlsClientAuth: v.optional(v.object({ certVerified: v.optional(v.string()) })),
});

function requestAuthTimeMs(request: Request): number | null {
  const forwarded = Number(request.headers.get(AUTH_TIME_HEADER) ?? '');

  if (Number.isFinite(forwarded) && forwarded > 0) return forwarded;

  return null;
}

/** Widening who can drive turns needs a fresh sign-in; one spelling so the grant routes cannot drift. */
function requireStepUp(request: Request): Response | null {
  if (isFreshAuthTime(requestAuthTimeMs(request))) return null;

  return err(401, 'step-up auth required (re-login within 5 minutes)');
}

export type HubTarget = Pick<OrchestratorAgent,
  'listTriggers' | 'createDurableWebhook' | 'cancelTrigger' | 'listRecentEvents'
  | 'getEmailIngress' | 'setEmailAllowlist' | 'setEmailNotifications'
>;

/**
 * A resolver, not the binding: the SDK's `getAgentByName` awaits `__unsafe_ensureInitialized` (runs `onStart`) under its
 * own retry (agents@0.22.0 `dist/agent-routing.js:176-183`, read 2026-09-22). Injectable for tests.
 */
export type HubResolver = (name: string) => Promise<HubTarget>;

export type HubEnv = Pick<Env, 'WEBHOOK_ROUTE_SECRET'>;

interface HubVariables extends WorkspaceVariables {
  hub: HubTarget;
}

type HubContext<Bindings extends HubEnv> = Context<FamilyEnv<Bindings, HubVariables>>;

const TRIGGERS = `${LITERAL_WORKSPACE}/triggers`;

const EMAIL = `${LITERAL_WORKSPACE}/email`;

export function hubRoutes<Bindings extends HubEnv>(
  resolverFor: (env: Bindings) => HubResolver,
): Hono<FamilyEnv<Bindings, HubVariables>> {
  const routes = new Hono<FamilyEnv<Bindings, HubVariables>>();

  const resolve = async (c: HubContext<Bindings>, next: () => Promise<void>): Promise<void> => {
    c.set('hub', await resolverFor(c.env)(c.get('workspace').name));
    await next();
  };

  // Resolved before the method check.
  routes.use(`${TRIGGERS}/*`, resolve);

  routes.on('GET', [TRIGGERS, `${TRIGGERS}/`], async (c) => json({ body: await c.get('hub').listTriggers() }));

  routes.on('POST', [TRIGGERS, `${TRIGGERS}/`], createTrigger);

  routes.on('ALL', [TRIGGERS, `${TRIGGERS}/`], async () => err(405, 'GET or POST'));

  // `owner`: proven by the workspace gate; the model's cancel comes as `self`.
  routes.delete(`${TRIGGERS}/:id`, async (c) =>
    json({ body: await c.get('hub').cancelTrigger(decodeURIComponent(rawParam(c, 'id')), 'owner') }));

  routes.all(`${TRIGGERS}/*`, async () => err(404, 'not found'));

  routes.get(`${LITERAL_WORKSPACE}/events`, async (c) => {
    const url = new URL(c.req.url);
    const variant = url.searchParams.get('variant') ?? undefined;

    // Same closed parser the object applies; NaN from `parseInt` reads as unstated, so SQLite never sees a NaN.
    const bounds = boundEventQuery({
      since: url.searchParams.has('since')
        ? parseInt(url.searchParams.get('since') ?? '', 10) : undefined,
      limit: url.searchParams.has('limit')
        ? parseInt(url.searchParams.get('limit') ?? '', 10) : undefined,
    });

    const agent = await resolverFor(c.env)(c.get('workspace').name);

    return json({
      body: await agent.listRecentEvents({ variant, since: bounds.since, limit: bounds.limit }),
    });
  });

  routes.use(EMAIL, resolve);

  routes.get(EMAIL, async (c) => json({ body: await c.get('hub').getEmailIngress() }));

  routes.put(EMAIL, async (c) => {
    const request = c.get('workspace').request;
    // Widening who can drive turns by email is a grant.
    const stepUp = requireStepUp(request);

    if (stepUp) return stepUp;

    const body = await safeJson(request, v.object({
      allow: v.optional(v.array(v.string())),
      notifications: v.optional(v.boolean()),
    }));

    if (!body || (body.allow === undefined && body.notifications === undefined)) {
      return err(400, 'allow (string[]) and/or notifications (boolean) required');
    }

    const agent = c.get('hub');

    if (body.allow !== undefined) {
      await agent.setEmailAllowlist(body.allow);
    }

    if (body.notifications !== undefined) {
      await agent.setEmailNotifications(body.notifications === true);
    }

    return json({ body: await agent.getEmailIngress() });
  });

  routes.all(EMAIL, async () => err(405, 'GET or PUT'));

  return routes;
}

async function createTrigger<Bindings extends HubEnv>(c: HubContext<Bindings>): Promise<Response> {
  const request = c.get('workspace').request;
  // Creating a trigger is a grant (same rule as the CLI webhook route: auth/session.ts isFreshAuthTime).
  const stepUp = requireStepUp(request);

  if (stepUp) return stepUp;

  // An unsignable delivery URL is a row nothing could reach, so report it here; public delivery just 404s.
  if (webhookRouteSecret(c.env) === null) return err(503, WEBHOOK_ROUTE_UNAVAILABLE);
  const body = await safeJson(request, WebhookRequestSchema);

  if (!body || !body.label || !body.auth_mode) {
    return err(400, 'label and auth_mode required');
  }

  let rateLimit: number;

  try {
    rateLimit = normalizeWebhookRateLimitPerMin(body.rate_limit_per_min);
  } catch (e) {
    return err(400, renderThrownChain({ cause: e }));
  }

  try {
    return json({
      body: await c.get('hub').createDurableWebhook({
        label: body.label,
        auth_mode: body.auth_mode,
        secret: body.secret,
        accepted_content_type: body.accepted_content_type,
        rate_limit_per_min: rateLimit,
      }),
    }, { status: 201 });
  } catch (e) {
    return err(500, renderThrownChain({ cause: e }));
  }
}

export type WebhookDeliveryTarget = Pick<OrchestratorAgent, 'acceptWebhookDelivery'>;

/** See {@link HubResolver}. */
export type WebhookDeliveryResolver = (name: string) => Promise<WebhookDeliveryTarget>;

export interface WebhookDeliveryEnv extends HubEnv {
  AUTH_KV?: KvStore;
}

/** Before the session gate. The URL capability is checked before budget, body or any RPC; every refusal but a wrong method is one 404. */
export function webhookDeliveryRoutes<Bindings extends WebhookDeliveryEnv>(
  resolverFor: (env: Bindings) => WebhookDeliveryResolver,
): Hono<FamilyEnv<Bindings, object>> {
  const routes = new Hono<FamilyEnv<Bindings, object>>();

  routes.all('/api/workspaces/:name/webhook/*', async (c, next) => {
    const match = matchWebhookDeliveryPath(c.req.path);

    if (match === null) return next();

    if (c.req.method !== 'POST') return err(405, 'use POST');
    const secret = webhookRouteSecret(c.env);

    if (secret === null || match.kind !== 'signed') return deliveryNotFound();

    if (!(await verifyWebhookRoute(secret, match))) return deliveryNotFound();

    return await handleWebhookDelivery(c.req.raw, c.env, match, resolverFor(c.env));
  });

  return routes;
}

/** One answer for every unroutable delivery: nothing read, nothing cached, causes indistinguishable. */
function deliveryNotFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Capability already settled; the rest is cost ordering: budget, then bytes, then the object, which is the costly persistent thing. */
async function handleWebhookDelivery(
  request: Request,
  env: WebhookDeliveryEnv,
  route: SignedWebhookRoute,
  resolveAgent: WebhookDeliveryResolver,
): Promise<Response> {
  const kv = env.AUTH_KV;

  if (kv && !(await ingressAdmitted(kv, 'webhook', peerIp(request), WEBHOOK_KNOCKS_PER_WINDOW))) {
    return ingressDenied();
  }

  const bounded = await readBounded(request, WEBHOOK_BODY_MAX_BYTES);

  if (bounded === 'too_large') return err(413, OVER_WEBHOOK_BODY_LIMIT);

  if (bounded instanceof KinuError) {
    diagnostics.failure('webhook.body_unreadable', bounded);

    return err(400, 'could not read the request body');
  }

  const agent = await resolveAgent(route.workspaceName);

  const parsedCf = v.safeParse(RequestCfSchema, request.cf);

  // Ingress runs inside the agent's DO (direct SQL) so publish stays one transaction.
  const result = await agent.acceptWebhookDelivery({
    trigger_id: route.triggerId,
    method: request.method,
    headers: extractHeaders(request),
    body_text: new TextDecoder().decode(bounded),
    cf_mtls_verified: parsedCf.success && parsedCf.output.tlsClientAuth?.certVerified === 'SUCCESS',
    delivery_id: request.headers.get('idempotency-key')
      ?? request.headers.get('x-delivery-id')
      ?? null,
    hmac_signature: request.headers.get('x-kinu-signature'),
    hmac_timestamp: request.headers.get('x-kinu-timestamp'),
    bearer_header: request.headers.get('authorization'),
    content_type: request.headers.get('content-type'),
    now: Date.now(),
  });

  if (result.status === 'rejected') {
    return err(result.http_status ?? 400, result.reason ?? 'rejected');
  }

  // v1 acknowledges after durable publish; held-open HTTP responses await a production-safe waiter.
  return json({
    body: {
      accepted: true,
      event_id: result.event_id,
      admitted: result.admitted,
    },
  }, { status: 202 });
}

interface WebhookHeaders {
  [name: string]: string;
}

function extractHeaders(request: Request): WebhookHeaders {
  const out: WebhookHeaders = {};

  for (const [key, value] of request.headers) out[key] = value;

  return out;
}
