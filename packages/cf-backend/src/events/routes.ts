/**
 * Hub HTTP routes:
 *
 *   POST /api/agents/<name>/webhook/<trigger_id>   — public webhook delivery
 *   GET  /api/agents/<name>/triggers                — list triggers (auth)
 *   POST /api/agents/<name>/triggers                — create trigger (auth + step-up)
 *   DELETE /api/agents/<name>/triggers/<id>         — revoke trigger (auth)
 *   GET  /api/agents/<name>/events                  — recent events (auth)
 *
 * The webhook route is the only one that DOES NOT require operator auth —
 * it has its own per-trigger HMAC / Bearer / mTLS gate.
 *
 * All operator routes (triggers/events) require browser auth from the
 * auth middleware AND ownership verification (handled by server.ts).
 *
 * `createDurableWebhook` is gated behind a fresh-auth (step-up) check: the
 * incoming request must carry a session auth time within the last 5 minutes.
 * The auth middleware forwards this as `x-proteus-auth-time`.
 */

import { getAgentByName } from 'agents';
import type { OrchestratorAgent } from '../orchestrator.js';
import { readWebhookBodyText } from './body.js';
import { normalizeWebhookRateLimitPerMin } from './webhook-rate-limit.js';

const STEP_UP_WINDOW_MS = 5 * 60 * 1000;   // 5-min window for sensitive ops

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function requestAuthTimeMs(request: Request): number | null {
  const forwarded = Number(request.headers.get('x-proteus-auth-time') ?? '');
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
  const webhookMatch = path.match(new RegExp(`^/api/agents/${escapeRe(agentName)}/webhook/([^/]+)$`));
  if (webhookMatch) {
    if (method !== 'POST') return err(405, 'use POST');
    const trigger_id = decodeURIComponent(webhookMatch[1]);
    return await handleWebhookDelivery(request, env, agentName, trigger_id);
  }

  // ── Triggers CRUD (auth + ownership already enforced upstream) ─
  const triggersBase = `/api/agents/${agentName}/triggers`;
  if (path === triggersBase || path.startsWith(triggersBase + '/')) {
    return await handleTriggersRoute(request, env, agentName, path.slice(triggersBase.length));
  }

  // ── Events listing ────────────────────────────────────────────
  if (path === `/api/agents/${agentName}/events` && method === 'GET') {
    return await handleEventsList(request, env, agentName);
  }

  return null;
}

// ── Webhook delivery handler ─────────────────────────────────────

async function handleWebhookDelivery(
  request: Request,
  env: Env,
  agentName: string,
  trigger_id: string,
): Promise<Response> {
  const agent = await getAgentByName<Env, OrchestratorAgent>(env.OrchestratorAgent, agentName);

  // The ingress needs an EventLog + ReplyChannelStore + TriggerRegistry view
  // of the agent's state. We invoke an RPC on the orchestrator that runs the
  // ingress inside the agent's DO (where it has direct SQL access). This
  // keeps the hub's atomicity guarantees (publish in one txn).
  const result = await agent.acceptWebhookDelivery({
    trigger_id,
    method: request.method,
    headers: extractHeaders(request),
    body_text: await readWebhookBodyText(request),
    cf_mtls_verified: ((request as Request & { cf?: { tlsClientAuth?: { certVerified?: string } } }).cf
      ?.tlsClientAuth?.certVerified) === 'SUCCESS',
    delivery_id: request.headers.get('idempotency-key')
      ?? request.headers.get('x-delivery-id')
      ?? null,
    hmac_signature: request.headers.get('x-proteus-signature'),
    hmac_timestamp: request.headers.get('x-proteus-timestamp'),
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
      return json(await agent.listTriggers());
    }
    if (method === 'POST') {
      // Step-up auth required for trigger creation.
      const iat = requestAuthTimeMs(request);
      if (!iat || Date.now() - iat > STEP_UP_WINDOW_MS) {
        return err(401, 'step-up auth required (re-login within 5 minutes)');
      }
      const body = await safeJson<{
        label?: string;
        auth_mode?: 'hmac' | 'bearer' | 'mtls';
        secret?: string;
        accepted_content_type?: string;
        rate_limit_per_min?: number;
      }>(request);
      if (!body || !body.label || !body.auth_mode) {
        return err(400, 'label and auth_mode required');
      }
      let rateLimit: number;
      try {
        rateLimit = normalizeWebhookRateLimitPerMin(body.rate_limit_per_min);
      } catch (e) {
        return err(400, e instanceof Error ? e.message : String(e));
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
        return err(500, (e as Error).message);
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
  return json(await agent.listRecentEvents({ variant, since, limit }));
}

// ── helpers ──────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => { out[key] = value; });
  return out;
}

async function safeJson<T = unknown>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}
