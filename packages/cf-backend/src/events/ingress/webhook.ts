/**
 * Webhook ingress — HTTP request → WebhookEvent via EventLog.publish.
 *
 *   POST /api/agents/<agent>/webhook/<trigger_id>
 *
 * Authentication is mandatory (no `auth=none` mode). Three auth schemes,
 * configured per trigger:
 *
 *   hmac    — HMAC-SHA256(timestamp || '.' || body), 5-min window, replay
 *             cache via dedupe_key
 *   bearer  — `Authorization: Bearer <secret>` header (constant-time compare)
 *   mtls    — client certificate presented (verified by CF before reaching
 *             the Worker; we just check that the request was mTLS-verified)
 *
 * On success: publish a WebhookEvent + open an `http_pending` reply channel
 * (30s TTL). The Worker holds the HTTP response open until the channel
 * is replied or expires.
 *
 * On failure: 401 (auth), 415 (content type), 429 (rate), 413 (body too
 * large) without ever publishing.
 *
 * Body cap: 1MB. Content types: configured per trigger (one accepted MIME).
 */

import {
  type EventLog, type ReplyChannelStore, type ReplyChannelKind,
  type WebhookPayload, type TriggerRegistry, type TriggerRow,
  IngressRejectedError, ulid,
} from '@proteus/core';

const BODY_MAX_BYTES = 1024 * 1024;          // 1 MB hard cap
const HMAC_TS_SKEW_MS = 5 * 60 * 1000;       // 5-minute clock skew window
const HTTP_REPLY_TTL_MS = 30_000;            // 30s — CF Worker request limit margin

export interface WebhookIngressDeps {
  log: EventLog;
  replies: ReplyChannelStore;
  triggers: TriggerRegistry;
}

export interface WebhookIngressEnv {
  /** Lookup the per-trigger secret. Returns null if revoked / missing. */
  getTriggerSecret(trigger_id: string): Promise<string | null>;
}

export type WebhookIngressOutcome =
  | { kind: 'published'; event_id: string; admitted: boolean; reply_channel_id: string | null }
  | { kind: 'rejected'; status: number; reason: string };

/** Handle an incoming HTTP webhook. Returns the outcome; callers convert to
 *  HTTP response. */
export async function handleWebhookIngress(
  deps: WebhookIngressDeps,
  env: WebhookIngressEnv,
  request: Request,
  trigger_id: string,
  now: number,
): Promise<WebhookIngressOutcome> {
  // Resolve trigger.
  const trigger = deps.triggers.get(trigger_id);
  if (!trigger) return reject(404, 'trigger not found');
  if (trigger.state !== 'active') return reject(503, `trigger ${trigger.state}`);
  if (trigger.kind !== 'webhook_durable' && trigger.kind !== 'webhook_ephemeral') {
    return reject(400, 'not a webhook trigger');
  }

  // Body size check BEFORE parse.
  const contentLength = parseInt(request.headers.get('content-length') ?? '0', 10);
  if (contentLength > BODY_MAX_BYTES) return reject(413, 'body too large');

  // Read body once, with size enforcement.
  const bodyText = await readBodyCapped(request, BODY_MAX_BYTES);
  if (bodyText.length > BODY_MAX_BYTES) return reject(413, 'body too large');

  // Content-type pinning per trigger.
  const triggerSpec = trigger.spec as {
    accepted_content_type?: string;
    auth_mode: 'hmac' | 'bearer' | 'mtls';
    secret_id?: string;
  };
  const receivedCT = request.headers.get('content-type')?.split(';')[0].trim() ?? '';
  if (triggerSpec.accepted_content_type && triggerSpec.accepted_content_type !== receivedCT) {
    return reject(415, `expected ${triggerSpec.accepted_content_type}, got ${receivedCT}`);
  }

  // Auth.
  const authIngress = await verifyWebhookAuth(triggerSpec, request, bodyText, env, now);
  if (!authIngress.ok) return reject(401, authIngress.reason);

  // Parse body once auth passes. JSON or text — generic blob preserved.
  let parsedBody: unknown;
  try {
    parsedBody = receivedCT.includes('json') ? JSON.parse(bodyText) : bodyText;
  } catch {
    parsedBody = bodyText;
  }

  // Build payload + delivery id (the idempotency key — provided by the
  // sender as a header where supported, otherwise synthesized from
  // ts+hash). dedupeKeyFor will use this.
  const delivery_id = request.headers.get('idempotency-key')
    ?? request.headers.get('x-delivery-id')
    ?? `${now}-${ulid().slice(0, 8)}`;

  const payload: WebhookPayload = {
    webhook_id: trigger_id,
    http_method: request.method,
    http_headers: extractHeaders(request),
    body: parsedBody,
    delivery_id,
  };

  // Open reply channel (HTTP-pending, 30s TTL).
  const reply_channel_id = deps.replies.open({
    event_id: 'pending',
    kind: 'http_pending' as ReplyChannelKind,
    holder_addr: `request:${delivery_id}`,
    payload_policy: 'full',
    ttl_ms_override: HTTP_REPLY_TTL_MS,
  }, now);

  // Publish (dedupe enforced by UNIQUE index on dedupe_key).
  const { id, admitted } = deps.log.publish({
    descriptor: {
      ingress: authIngress.ingress,
      variant: 'webhook',
      payload,
      auth_outcome: 'verified',
      webhook_id: trigger_id,
    },
    now,
    reply_channel: reply_channel_id ? { id: reply_channel_id, kind: 'http_pending' } : undefined,
  });

  return { kind: 'published', event_id: id, admitted, reply_channel_id };
}

// ── Auth verification ────────────────────────────────────────────

/** Webhook auth always resolves to one of the webhook-specific ingress kinds
 *  — which is exactly what the `variant: 'webhook'` IngressDescriptor needs. */
type WebhookIngress = 'webhook_hmac' | 'webhook_bearer' | 'webhook_mtls';
interface AuthOutcome { ok: true; ingress: WebhookIngress }
interface AuthFailed  { ok: false; reason: string }
type AuthResult = AuthOutcome | AuthFailed;

async function verifyWebhookAuth(
  spec: { auth_mode: 'hmac' | 'bearer' | 'mtls'; secret_id?: string },
  request: Request,
  bodyText: string,
  env: WebhookIngressEnv,
  now: number,
): Promise<AuthResult> {
  switch (spec.auth_mode) {
    case 'hmac':
      return verifyHmac(spec, request, bodyText, env, now);
    case 'bearer':
      return verifyBearer(spec, request, env);
    case 'mtls':
      return verifyMtls(request);
  }
}

async function verifyHmac(
  spec: { secret_id?: string },
  request: Request,
  bodyText: string,
  env: WebhookIngressEnv,
  now: number,
): Promise<AuthResult> {
  if (!spec.secret_id) return { ok: false, reason: 'no hmac secret configured' };
  const secret = await env.getTriggerSecret(spec.secret_id);
  if (!secret) return { ok: false, reason: 'secret revoked' };

  const tsHeader = request.headers.get('x-proteus-timestamp');
  const sigHeader = request.headers.get('x-proteus-signature');
  if (!tsHeader || !sigHeader) return { ok: false, reason: 'missing hmac headers' };
  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid timestamp' };
  if (Math.abs(now - ts) > HMAC_TS_SKEW_MS) return { ok: false, reason: 'timestamp out of window' };

  const expected = await computeHmacSha256(secret, `${ts}.${bodyText}`);
  if (!timingSafeEqual(expected, sigHeader)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true, ingress: 'webhook_hmac' };
}

async function verifyBearer(
  spec: { secret_id?: string },
  request: Request,
  env: WebhookIngressEnv,
): Promise<AuthResult> {
  if (!spec.secret_id) return { ok: false, reason: 'no bearer secret configured' };
  const stored = await env.getTriggerSecret(spec.secret_id);
  if (!stored) return { ok: false, reason: 'secret revoked' };
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };
  const presented = header.slice('Bearer '.length).trim();
  if (!timingSafeEqual(stored, presented)) return { ok: false, reason: 'bearer mismatch' };
  return { ok: true, ingress: 'webhook_bearer' };
}

function verifyMtls(request: Request): AuthResult {
  const cfData = (request as Request & { cf?: { tlsClientAuth?: { certVerified?: string } } }).cf;
  if (cfData?.tlsClientAuth?.certVerified === 'SUCCESS') {
    return { ok: true, ingress: 'webhook_mtls' };
  }
  return { ok: false, reason: 'client certificate not verified by CF edge' };
}

// ── Helpers ──────────────────────────────────────────────────────

function reject(status: number, reason: string): WebhookIngressOutcome {
  return { kind: 'rejected', status, reason };
}

async function readBodyCapped(request: Request, max: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) return text + '__OVERFLOW__';
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function computeHmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip auth + internal CF headers; keep app-level headers.
  const blocked = new Set([
    'authorization', 'cookie', 'x-proteus-signature', 'x-proteus-timestamp',
    'cf-access-jwt-assertion', 'cf-access-authenticated-user-email',
  ]);
  request.headers.forEach((value, key) => {
    if (!blocked.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}
