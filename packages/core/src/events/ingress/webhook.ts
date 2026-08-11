/**
 * Webhook ingress — an HTTP delivery becomes a durable event.
 *
 * The backend in front of this owns exactly the transport: read the request,
 * hand over its headers and body, answer with the status this returns. Every
 * decision between those two points — the content-type pin, HMAC / bearer /
 * mTLS verification, the replay window, the rate limit, body parsing, the reply
 * channel, the oversize spill and the publish — is the same on any host, so it
 * lives here once.
 *
 * Auth modes:
 *   hmac    `X-Proteus-Signature` = HMAC-SHA256(secret, `<ts>.<body>`), with
 *           `X-Proteus-Timestamp` inside a ±5 minute window (replay bound).
 *   bearer  `Authorization: Bearer <secret>`, compared in constant time.
 *   mtls    the edge verified a client certificate; no secret is involved.
 */

import type { EventLog } from '../hub/log.js';
import type { ReplyChannelStore } from '../hub/reply-channel.js';
import type { TriggerRegistry } from '../hub/triggers.js';
import { spillEventContent } from '../hub/content-spill.js';
import type { SqlExec, VFS } from '../../types/primitives.js';
import { hmacSha256Hex, timingSafeEqual } from '../../utils/crypto.js';
import { normalizeWebhookRateLimitPerMin, tryConsumeWebhookRateLimit } from './rate-limit.js';

/** How far an HMAC delivery's timestamp may be from the receiver's clock. */
const HMAC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** How long the delivery's reply channel stays open for a held response. */
const WEBHOOK_REPLY_TTL_MS = 30_000;

export type WebhookAuthMode = 'hmac' | 'bearer' | 'mtls';

/**
 * Where a webhook's shared secret lives.
 *
 * The ingress needs the secret and nothing else about it: on the cloud backend
 * it is a row in the workspace's own storage, and a host that keeps secrets
 * somewhere else entirely — a config file, a platform secret binding — supplies
 * the same one method.
 */
export interface SecretStore {
  get(secretId: string): Promise<string | null>;
}

/** The spec a webhook trigger row carries, written by
 *  {@link registerDurableWebhook} and read back below. A stored row is claimed,
 *  not trusted: every field is read as optional, and an absent or unrecognised
 *  `auth_mode` demands the strictest mode (a verified client certificate). */
export interface WebhookTriggerSpec {
  label?: string;
  auth_mode: WebhookAuthMode;
  secret_id?: string;
  accepted_content_type?: string;
}

export interface WebhookDelivery {
  trigger_id: string;
  method: string;
  headers: Record<string, string>;
  body_text: string;
  cf_mtls_verified: boolean;
  delivery_id: string | null;
  hmac_signature: string | null;
  hmac_timestamp: string | null;
  bearer_header: string | null;
  content_type: string | null;
  now: number;
}

export type WebhookDeliveryResult = {
  status: 'admitted' | 'rejected';
  http_status?: number;
  reason?: string;
  event_id?: string;
  admitted?: boolean;
};

export interface WebhookIngressDeps {
  triggers: TriggerRegistry;
  log: EventLog;
  replies: ReplyChannelStore;
  /** The receiving agent's file plane — an oversize body is spilled here so the
   *  woken turn can read the delivery it was woken by. */
  vfs: VFS;
  secrets: SecretStore;
  /** Where the rate-limit windows live (the agent's own storage). */
  sql: SqlExec;
  /** A fresh event was admitted — wake the agent loop (debounced drain). */
  onAdmitted(): void;
}

export interface RegisterWebhookOpts {
  label: string;
  auth_mode: WebhookAuthMode;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

export interface RegisteredWebhook {
  trigger_id: string;
  /** The opaque handle the secret is stored under, never returned to a reader
   *  of the trigger row. */
  secret_id: string;
  auth_mode: WebhookAuthMode;
}

/**
 * Register a durable webhook trigger. The caller persists the secret under the
 * returned `secret_id` (only it knows where its secrets live) and publishes
 * whatever URL its transport answers on.
 */
export function registerDurableWebhook(
  registry: TriggerRegistry,
  opts: RegisterWebhookOpts,
  now: number,
): RegisteredWebhook {
  const rate_limit_per_min = normalizeWebhookRateLimitPerMin(opts.rate_limit_per_min);
  const secret_id = `webhook_secret_${Math.random().toString(36).slice(2, 12)}`;
  const trigger_id = registry.register({
    kind: 'webhook_durable',
    spec: {
      label: opts.label,
      auth_mode: opts.auth_mode,
      secret_id,
      accepted_content_type: opts.accepted_content_type ?? 'application/json',
    } satisfies WebhookTriggerSpec,
    creator_trust: 'owner',
    rate_limit_per_min,
  }, now);
  return { trigger_id, secret_id, auth_mode: opts.auth_mode };
}

/** Verify a delivery against its trigger's auth mode. */
async function verifyWebhookAuth(
  deps: WebhookIngressDeps,
  spec: Partial<WebhookTriggerSpec>,
  opts: WebhookDelivery,
): Promise<
  | { ok: true; ingress: 'webhook_hmac' | 'webhook_bearer' | 'webhook_mtls' }
  | { ok: false; reason: string }
> {
  if (spec.auth_mode === 'hmac') {
    if (!spec.secret_id) return { ok: false, reason: 'no hmac secret configured' };
    const secret = await deps.secrets.get(spec.secret_id);
    if (!secret) return { ok: false, reason: 'secret revoked' };
    if (!opts.hmac_signature || !opts.hmac_timestamp) {
      return { ok: false, reason: 'missing hmac headers' };
    }
    const ts = parseInt(opts.hmac_timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(opts.now - ts) > HMAC_TIMESTAMP_WINDOW_MS) {
      return { ok: false, reason: 'timestamp out of window' };
    }
    const expected = await hmacSha256Hex(secret, `${ts}.${opts.body_text}`);
    if (!timingSafeEqual(expected, opts.hmac_signature)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    return { ok: true, ingress: 'webhook_hmac' };
  }
  if (spec.auth_mode === 'bearer') {
    if (!spec.secret_id) return { ok: false, reason: 'no bearer secret' };
    const stored = await deps.secrets.get(spec.secret_id);
    if (!stored) return { ok: false, reason: 'secret revoked' };
    if (!opts.bearer_header || !opts.bearer_header.startsWith('Bearer ')) {
      return { ok: false, reason: 'missing bearer' };
    }
    const presented = opts.bearer_header.slice('Bearer '.length).trim();
    if (!timingSafeEqual(stored, presented)) {
      return { ok: false, reason: 'bearer mismatch' };
    }
    return { ok: true, ingress: 'webhook_bearer' };
  }
  if (!opts.cf_mtls_verified) {
    return { ok: false, reason: 'client cert not verified' };
  }
  return { ok: true, ingress: 'webhook_mtls' };
}

/** Gate + publish one webhook delivery. Runs inside the agent's storage. */
export async function acceptWebhookDelivery(
  deps: WebhookIngressDeps,
  opts: WebhookDelivery,
): Promise<WebhookDeliveryResult> {
  const trigger = deps.triggers.get(opts.trigger_id);
  if (!trigger) return { status: 'rejected', http_status: 404, reason: 'trigger not found' };
  if (trigger.state !== 'active') {
    return { status: 'rejected', http_status: 503, reason: `trigger ${trigger.state}` };
  }
  if (trigger.kind !== 'webhook_durable' && trigger.kind !== 'webhook_ephemeral') {
    return { status: 'rejected', http_status: 400, reason: 'not a webhook trigger' };
  }

  const spec: Partial<WebhookTriggerSpec> = trigger.spec;

  const receivedCT = opts.content_type?.split(';')[0].trim() ?? '';
  if (spec.accepted_content_type && spec.accepted_content_type !== receivedCT) {
    return { status: 'rejected', http_status: 415, reason: `expected ${spec.accepted_content_type}` };
  }

  const auth = await verifyWebhookAuth(deps, spec, opts);
  if (!auth.ok) return { status: 'rejected', http_status: 401, reason: auth.reason };

  const rate = tryConsumeWebhookRateLimit(deps.sql, opts.trigger_id, trigger.rate_limit_per_min, opts.now);
  if (!rate.allowed) {
    return { status: 'rejected', http_status: 429, reason: `rate limit exceeded (${rate.limit}/min)` };
  }

  let parsedBody: unknown;
  try {
    parsedBody = receivedCT.includes('json') ? JSON.parse(opts.body_text) : opts.body_text;
  } catch { parsedBody = opts.body_text; }

  const delivery_id = opts.delivery_id ?? `${opts.now}-${Math.random().toString(36).slice(2, 10)}`;

  // Open a reply channel for the event system. HTTP delivery itself returns
  // 202 immediately; a future held-response path can wait on this channel
  // without changing the durable event shape.
  const reply_channel_id = deps.replies.open({
    event_id: 'pending',
    kind: 'http_pending',
    holder_addr: `delivery:${delivery_id}`,
    payload_policy: 'redact',
    ttl_ms_override: WEBHOOK_REPLY_TTL_MS,
  }, opts.now);

  // A delivery larger than the brief budget is spilled to this agent's own
  // file plane first, so the woken turn gets a readable path alongside the
  // brief instead of an unreachable — and, for JSON, syntactically broken —
  // fragment of the thing that woke it. After the auth + rate gates, so a
  // rejected delivery never writes a file.
  const bodySerialized = JSON.stringify(parsedBody) ?? String(parsedBody);
  const bodyPath = await spillEventContent(deps.vfs, bodySerialized);

  const { id, admitted } = deps.log.publish({
    descriptor: {
      ingress: auth.ingress,
      variant: 'webhook',
      payload: {
        webhook_id: opts.trigger_id,
        http_method: opts.method,
        http_headers: opts.headers,
        body: parsedBody,
        delivery_id,
        ...(bodyPath ? { body_path: bodyPath } : {}),
      },
      auth_outcome: 'verified',
      webhook_id: opts.trigger_id,
    },
    now: opts.now,
    reply_channel: reply_channel_id ? { id: reply_channel_id, kind: 'http_pending' } : undefined,
  });

  // Wake the agent to act on the new webhook event — an autonomous turn,
  // debounced so a delivery burst drains as ONE turn. Only when newly
  // admitted (a duplicate is already bound or in flight).
  if (admitted) deps.onAdmitted();

  return { status: 'admitted', event_id: id, admitted };
}
