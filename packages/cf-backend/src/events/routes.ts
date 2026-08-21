/**
 * Hub HTTP routes:
 *
 *   POST /api/workspaces/<name>/webhook/<trigger_id>   — public webhook delivery
 *   GET  /api/workspaces/<name>/triggers                — list triggers (auth)
 *   POST /api/workspaces/<name>/triggers                — create trigger (auth + step-up)
 *   DELETE /api/workspaces/<name>/triggers/<id>         — revoke trigger (auth)
 *   GET  /api/workspaces/<name>/events                  — recent events (auth)
 *   GET  /api/workspaces/<name>/email                   — email ingress config (auth)
 *   PUT  /api/workspaces/<name>/email                   — set allowlist / notifications
 *                                                     (auth + step-up)
 *
 * The webhook route is the only one that DOES NOT require operator auth —
 * it has its own per-trigger HMAC / Bearer / mTLS gate.
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
import { readWebhookBodyText } from './body';
import { normalizeWebhookRateLimitPerMin } from '@kinu.run/core';
import { err, json, safeJson } from '../lib/http';
import { isFreshAuthTime } from '../auth/session';
import { decodeJsonWire } from '../lib/orchestrator-wire';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

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

// ── Route entry point ────────────────────────────────────────────

export async function handleHubRequest(
  request: Request,
  env: Env,
  agentName: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ── Webhook ingress (public, per-trigger auth) ────────────────
  const webhookMatch = path.match(new RegExp(`^/api/workspaces/${escapeRe(agentName)}/webhook/([^/]+)$`));
  if (webhookMatch) {
    if (method !== 'POST') return err(405, 'use POST');
    const trigger_id = decodeURIComponent(webhookMatch[1]);
    return await handleWebhookDelivery(request, env, agentName, trigger_id);
  }

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
    // Widening who can drive turns by email is a grant — same step-up rule
    // as webhook trigger creation.
    if (!isFreshAuthTime(requestAuthTimeMs(request))) {
      return err(401, 'step-up auth required (re-login within 5 minutes)');
    }
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

// ── Webhook delivery handler ─────────────────────────────────────

async function handleWebhookDelivery(
  request: Request,
  env: Env,
  agentName: string,
  trigger_id: string,
): Promise<Response> {
  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
  const parsedCf = v.safeParse(RequestCfSchema, request.cf);

  // The ingress needs an EventLog + ReplyChannelStore + TriggerRegistry view
  // of the agent's state. We invoke an RPC on the orchestrator that runs the
  // ingress inside the agent's DO (where it has direct SQL access). This
  // keeps the hub's atomicity guarantees (publish in one txn).
  const result = await agent.acceptWebhookDelivery({
    trigger_id,
    method: request.method,
    headers: extractHeaders(request),
    body_text: await readWebhookBodyText(request),
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
      // Step-up auth required for trigger creation (shared rule with the
      // CLI webhook route — see auth/session.ts isFreshAuthTime).
      if (!isFreshAuthTime(requestAuthTimeMs(request))) {
        return err(401, 'step-up auth required (re-login within 5 minutes)');
      }
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
    return json(await agent.cancelTrigger(trigger_id));
  }
  return err(404, 'not found');
}

// ── Events list handler ──────────────────────────────────────────

async function handleEventsList(request: Request, env: Env, agentName: string): Promise<Response> {
  const url = new URL(request.url);
  const variant = url.searchParams.get('variant') ?? undefined;
  const sinceRaw = url.searchParams.get('since');
  const limitRaw = url.searchParams.get('limit');
  const since = sinceRaw ? parseInt(sinceRaw, 10) : undefined;
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);
  return json(decodeJsonWire(await agent.listRecentEventsWire({ variant, since, limit })));
}

// ── helpers ──────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface WebhookHeaders {
  [name: string]: string;
}

function extractHeaders(request: Request): WebhookHeaders {
  const out: WebhookHeaders = {};
  request.headers.forEach((value, key) => { out[key] = value; });
  return out;
}
