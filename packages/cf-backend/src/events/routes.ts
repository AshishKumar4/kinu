/**
 * Hub HTTP routes:
 *
 *   POST /api/workspaces/<name>/webhook/<trigger_id>/v1-<token>
 *                                                       — public webhook delivery
 *   GET  /api/workspaces/<name>/triggers                — list triggers (auth)
 *   POST /api/workspaces/<name>/triggers                — create trigger (auth + step-up)
 *   DELETE /api/workspaces/<name>/triggers/<id>         — revoke trigger (auth)
 *   GET  /api/workspaces/<name>/events                  — recent events (auth)
 *   GET  /api/workspaces/<name>/email                   — email ingress config (auth)
 *   PUT  /api/workspaces/<name>/email                   — set allowlist / notifications
 *                                                     (auth + step-up)
 *
 * The delivery route is the only one that needs no operator auth, and it is NOT
 * part of `handleHubRequest`: it is served before the auth gate by
 * `handleWebhookDeliveryRequest`, whose first act is to verify the route
 * capability the URL carries (see webhook-route.ts). Reaching a workspace and
 * authenticating a payload are two different gates, and the per-trigger HMAC /
 * Bearer / mTLS check is still the second one.
 *
 * All operator routes (triggers/events) require browser auth from the
 * auth middleware AND ownership verification (handled by server.ts).
 *
 * `createDurableWebhook` is gated behind a fresh-auth (step-up) check: the
 * incoming request must carry a session auth time within the last 5 minutes.
 * The auth middleware forwards this as `x-kinu-auth-time`.
 */

import { getAgentByName } from 'agents';
import type { OrchestratorAgent } from '../orchestrator';
import {
  boundEventQuery, DEFAULT_RATE_LIMIT_PER_MIN, normalizeWebhookRateLimitPerMin,
} from '@kinu.run/core';
import { err, json, readBounded, safeJson } from '../lib/http';
import { ingressAdmitted, ingressDenied, peerIp } from '../lib/ingress-budget';
import { isFreshAuthTime } from '../auth/session';
import { decodeJsonWire } from '../lib/orchestrator-wire';
import {
  matchWebhookDeliveryPath, verifyWebhookRoute, webhookRouteSecret,
  WEBHOOK_ROUTE_UNAVAILABLE, type SignedWebhookRoute,
} from './webhook-route';
import * as v from 'valibot';
import { diagnostics, KinuError, renderThrownChain } from '@kinu.run/core/obs';

/**
 * What a verified webhook delivery may cost this Worker before it knows
 * anything about its sender. The route is public by design — the credential
 * that would settle who is calling is the trigger's own secret, and that lives
 * inside the workspace object the request is asking us to wake — so every bound
 * below is spent against an anonymous caller.
 *
 * The body ceiling is a refusal rather than a truncation: the HMAC is computed
 * over these exact bytes, so a clipped body is a signature failure, not a
 * smaller delivery. A notification is the shape this carries; a payload
 * transfer is what the Files routes are for.
 *
 * The knock budget is no longer what stands between an anonymous POST and a
 * persistent Durable Object — the route capability in the URL is
 * (`webhook-route.ts`), and it is checked before any of this. What the budget
 * still buys is a bound on a URL that leaked: the capability names a workspace
 * for as long as the trigger lives, and one sender should not be able to spend
 * the object's whole minute at the edge. `lib/ingress-budget.ts` states that
 * control's exact residuals.
 *
 * Neither number is invented here. The body ceiling is the 1 MiB frame ceiling
 * this repo already reasons about for the DO rail (`terminal-route.ts`,
 * `files-routes.ts`). The knock budget IS the per-trigger delivery rate the
 * product already declares — `DEFAULT_RATE_LIMIT_PER_MIN`, enforced inside the
 * object by `tryConsumeWebhookRateLimit` — because a sender that may deliver N
 * times a minute has no reason to knock more often than N. Deriving it means a
 * change to the product's rate limit moves the edge budget with it, instead of
 * leaving a second number here to drift.
 */
const WEBHOOK_BODY_MAX_BYTES = 1024 * 1024;
const WEBHOOK_KNOCKS_PER_WINDOW = DEFAULT_RATE_LIMIT_PER_MIN;
const OVER_WEBHOOK_BODY_LIMIT = 'webhook body over the 1 MiB limit';

const WebhookRequestSchema = v.object({
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
  const forwarded = Number(request.headers.get('x-kinu-auth-time') ?? '');
  if (Number.isFinite(forwarded) && forwarded > 0) return forwarded;
  return null;
}

/**
 * The step-up rule the grant routes share: widening who can drive turns needs
 * a sign-in from the last 5 minutes. One spelling, so the two arms cannot
 * drift into two different freshnesses or two different refusals.
 */
function requireStepUp(request: Request): Response | null {
  if (isFreshAuthTime(requestAuthTimeMs(request))) return null;
  return err(401, 'step-up auth required (re-login within 5 minutes)');
}

// ── Route entry point ────────────────────────────────────────────

export async function handleHubRequest(
  request: Request,
  env: Env,
  agentName: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ── Triggers CRUD (auth + ownership already enforced upstream) ─
  const triggersBase = `/api/workspaces/${agentName}/triggers`;
  if (path === triggersBase || path.startsWith(triggersBase + '/')) {
    return await handleTriggersRoute(request, env, agentName, path.slice(triggersBase.length));
  }

  // ── Events listing ────────────────────────────────────────────
  if (path === `/api/workspaces/${agentName}/events` && method === 'GET') {
    return await handleEventsList(request, env, agentName);
  }

  // ── Email ingress config (Mission Inbox) ──────────────────────
  if (path === `/api/workspaces/${agentName}/email`) {
    return await handleEmailConfigRoute(request, env, agentName);
  }

  return null;
}

// ── Public webhook delivery ──────────────────────────────────────

/**
 * The public delivery endpoint, and the only entry point for it.
 *
 * Order here is the security contract. The route capability in the URL is
 * verified before the ingress budget is spent, before the body is read, before
 * the Orchestrator namespace is addressed and before any RPC — so an
 * unauthenticated caller cannot activate a Durable Object by naming one,
 * whatever name it picks. Every refusal short of a wrong method answers the
 * same unconditional 404, so the endpoint reports nothing about which workspace
 * or trigger exists, nor about whether this deployment can sign routes at all.
 *
 * Returns null for a path that is not webhook delivery, leaving it to the rest
 * of the route table.
 */
export async function handleWebhookDeliveryRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const match = matchWebhookDeliveryPath(new URL(request.url).pathname);
  if (match === null) return null;
  if (request.method !== 'POST') return err(405, 'use POST');
  const secret = webhookRouteSecret(env);
  if (secret === null || match.kind !== 'signed') return deliveryNotFound();
  if (!(await verifyWebhookRoute(secret, match))) return deliveryNotFound();
  return await handleWebhookDelivery(request, env, match);
}

/** One answer for every unroutable delivery: nothing read, nothing cached, and
 *  no way to tell the causes apart. */
function deliveryNotFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}

// ── Email ingress config handler ─────────────────────────────────

async function handleEmailConfigRoute(
  request: Request,
  env: Env,
  agentName: string,
): Promise<Response> {
  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
  if (request.method === 'GET') {
    return json(await agent.getEmailIngress());
  }
  if (request.method === 'PUT') {
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
    if (body.allow !== undefined) {
      await agent.setEmailAllowlist(body.allow);
    }
    if (body.notifications !== undefined) {
      await agent.setEmailNotifications(body.notifications === true);
    }
    return json(await agent.getEmailIngress());
  }
  return err(405, 'GET or PUT');
}

// ── Verified delivery ────────────────────────────────────────────

/**
 * Runs a delivery whose route capability this deployment minted.
 *
 * ORDER IS STILL THE PROPERTY. The capability settled which workspace and
 * trigger the request may address, and it settled that both names are ones the
 * product issues, so what is left is cost: budget, then bytes, then the object,
 * each gate costing strictly less than the one after it, and the object last
 * because waking it is the expensive, persistent thing.
 */
async function handleWebhookDelivery(
  request: Request,
  env: Env,
  route: SignedWebhookRoute,
): Promise<Response> {
  const kv = env.AUTH_KV;
  if (kv && !(await ingressAdmitted(kv, 'webhook', peerIp(request), WEBHOOK_KNOCKS_PER_WINDOW))) {
    return ingressDenied();
  }

  // `readBounded` owns BOTH halves of the bound — the declared-length
  // pre-filter and the count of arriving bytes — so this route states the limit
  // and reads the outcome, and there is one place either can change.
  const bounded = await readBounded(request, WEBHOOK_BODY_MAX_BYTES);
  if (bounded === 'too_large') return err(413, OVER_WEBHOOK_BODY_LIMIT);
  if (bounded instanceof KinuError) {
    diagnostics.failure('webhook.body_unreadable', bounded);
    return err(400, 'could not read the request body');
  }

  const agent = await getAgentByName<Env, OrchestratorAgent>(
    env.OrchestratorAgent, route.workspaceName,
  );
  const parsedCf = v.safeParse(RequestCfSchema, request.cf);

  // The ingress needs an EventLog + ReplyChannelStore + TriggerRegistry view
  // of the agent's state. We invoke an RPC on the orchestrator that runs the
  // ingress inside the agent's DO (where it has direct SQL access). This
  // keeps the hub's atomicity guarantees (publish in one txn).
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
  // Webhook v1 acknowledges after durable publish. Agent replies are handled
  // through the event/reply-channel system; held-open HTTP webhook responses are
  // intentionally not exposed until that channel has a production-safe waiter.
  return json({
    accepted: true,
    event_id: result.event_id,
    admitted: result.admitted,
  }, { status: 202 });
}

// ── Triggers CRUD handler ────────────────────────────────────────

async function handleTriggersRoute(
  request: Request,
  env: Env,
  agentName: string,
  rest: string,
): Promise<Response> {
  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
  const method = request.method;

  if (rest === '' || rest === '/') {
    if (method === 'GET') {
      return json(decodeJsonWire(await agent.listTriggersWire()));
    }
    if (method === 'POST') {
      // Creating a trigger is a grant (shared rule with the CLI webhook
      // route — see auth/session.ts isFreshAuthTime).
      const stepUp = requireStepUp(request);
      if (stepUp) return stepUp;
      // A trigger whose delivery URL cannot be signed is a row no delivery
      // could ever reach, so an unconfigured deployment is reported here
      // instead of writing one. Public delivery says none of this; it 404s.
      if (webhookRouteSecret(env) === null) return err(503, WEBHOOK_ROUTE_UNAVAILABLE);
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
        return json(await agent.createDurableWebhook({
          label: body.label,
          auth_mode: body.auth_mode,
          secret: body.secret,
          accepted_content_type: body.accepted_content_type,
          rate_limit_per_min: rateLimit,
        }), { status: 201 });
      } catch (e) {
        return err(500, renderThrownChain({ cause: e }));
      }
    }
    return err(405, 'GET or POST');
  }

  // /triggers/<id>
  const idMatch = rest.match(/^\/([^/]+)$/);
  if (idMatch && method === 'DELETE') {
    const trigger_id = decodeURIComponent(idMatch[1]);
    // `owner`: this route is below server.ts's auth, CSRF and workspace-ownership
    // gates, so the caller has been shown to be the workspace's owner. The
    // model's own `agent.cancelSchedule` reaches the same method as `self` and
    // is refused an owner-created ingress.
    return json(await agent.cancelTrigger(trigger_id, 'owner'));
  }
  return err(404, 'not found');
}

// ── Events list handler ──────────────────────────────────────────

async function handleEventsList(request: Request, env: Env, agentName: string): Promise<Response> {
  const url = new URL(request.url);
  const variant = url.searchParams.get('variant') ?? undefined;
  // The same closed parser the object behind this RPC applies, so a request
  // that skips the route gets the identical ceiling. `parseInt('abc', 10)` is
  // NaN, which the parser reads as "unstated" — the route never has to decide
  // what a garbage query string meant, and SQLite never sees a NaN datatype
  // mismatch.
  const bounds = boundEventQuery({
    since: url.searchParams.has('since')
      ? parseInt(url.searchParams.get('since') ?? '', 10) : undefined,
    limit: url.searchParams.has('limit')
      ? parseInt(url.searchParams.get('limit') ?? '', 10) : undefined,
  });

  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
  return json(decodeJsonWire(await agent.listRecentEventsWire({
    variant, since: bounds.since, limit: bounds.limit,
  })));
}

// ── helpers ──────────────────────────────────────────────────────

interface WebhookHeaders {
  [name: string]: string;
}

function extractHeaders(request: Request): WebhookHeaders {
  const out: WebhookHeaders = {};
  request.headers.forEach((value, key) => { out[key] = value; });
  return out;
}
