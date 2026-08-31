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
 *   hmac    `X-Kinu-Signature` = HMAC-SHA256(secret, `<ts>.<body>`), with
 *           `X-Kinu-Timestamp` inside a ±5 minute window, and the signed
 *           artifact CLAIMED once for the rest of that window (see
 *           {@link claimSignedDelivery}) — freshness alone admitted the same
 *           captured bytes twice across a dedupe-bucket boundary.
 *   bearer  `Authorization: Bearer <secret>`, compared in constant time.
 *   mtls    the edge verified a client certificate; no secret is involved.
 */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { ReplyChannelStore } from '../hub/reply-channel';
import type { TriggerRegistry } from '../hub/triggers';
import { spillEventContent } from '../hub/content-spill';
import { classify } from '../../obs/index';
import type { SqlExec, VFS } from '../../types/primitives';
import { hmacSha256Hex, timingSafeEqual } from '../../utils/crypto';
import {
  initWebhookRateLimitTables, normalizeWebhookRateLimitPerMin, tryConsumeWebhookRateLimit,
} from './rate-limit';
import { sha256Hex } from '../../safety/argument-digest';
import type { WebhookSecretStore } from './secrets';

/** How far an HMAC delivery's timestamp may be from the receiver's clock. */
const HMAC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

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
  /** The shared secret the operator chose, when they chose one. Blank or
   *  absent under hmac/bearer means "mint me one"; mTLS has none to mint. */
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

export interface RegisteredWebhook {
  trigger_id: string;
  /** The opaque handle the secret is stored under, never returned to a reader
   *  of the trigger row. */
  secret_id: string;
  auth_mode: WebhookAuthMode;
  /** The plaintext secret this webhook now authenticates with, for the caller
   *  to show its operator ONCE — null only for mTLS, which has none. Nothing
   *  reads it back afterwards: the store holds the only other copy, and no
   *  route serves it. */
  secret: string | null;
}

/** A fresh 256-bit webhook secret. Hex, so it survives every header, shell and
 *  config file an operator will paste it into. */
function freshWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Register a durable webhook trigger, WITH the credential its auth mode needs.
 *
 * The secret is decided here rather than by each caller, because "hmac with no
 * secret" is not a webhook: `verifyWebhookAuth` answers `no hmac secret
 * configured` to every delivery and no route can set one afterwards, so a
 * caller that forgot to pass one created a 201-reported trigger that could
 * never receive anything. An operator's own secret is kept; a blank one is
 * minted; mTLS keeps none.
 *
 * Storing it is part of registering it: a trigger left active with no stored
 * secret is that same unusable row, so a failed write revokes the trigger and
 * the failure reaches the caller. The trigger's URL is published by the caller
 * only after this returns, so nothing can be delivered to a half-created one.
 */
export async function registerDurableWebhook(
  registry: TriggerRegistry,
  secrets: Pick<WebhookSecretStore, 'put' | 'deleteByTrigger'>,
  opts: RegisterWebhookOpts,
  now: number,
): Promise<RegisteredWebhook> {
  const rate_limit_per_min = normalizeWebhookRateLimitPerMin(opts.rate_limit_per_min);
  const secret_id = `webhook_secret_${Math.random().toString(36).slice(2, 12)}`;
  const secret = opts.auth_mode === 'mtls' ? null : (opts.secret?.trim() || freshWebhookSecret());
  const trigger_id = await registry.register({
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
  if (secret !== null) {
    try {
      secrets.put(secret_id, trigger_id, secret, now);
    } catch (cause) {
      registry.revoke(trigger_id, now);
      secrets.deleteByTrigger(trigger_id);
      throw new Error(`webhook "${opts.label}" was not created: its secret could not be stored`, { cause });
    }
  }
  return { trigger_id, secret_id, auth_mode: opts.auth_mode, secret };
}

/**
 * Verify a delivery against its trigger's auth mode.
 *
 * A verified HMAC delivery also names its `claim`: the identity of the signed
 * artifact it presented, which is what makes a signature single-use for the
 * rest of its acceptance window. Bearer and mTLS have no such artifact — the
 * credential is the same on every legitimate request — so they carry none.
 */
async function verifyWebhookAuth(
  deps: WebhookIngressDeps,
  spec: Partial<WebhookTriggerSpec>,
  opts: WebhookDelivery,
): Promise<
  | {
      ok: true;
      ingress: 'webhook_hmac' | 'webhook_bearer' | 'webhook_mtls';
      claim?: { key: string; expiresAt: number };
    }
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
    return {
      ok: true,
      ingress: 'webhook_hmac',
      // The signed bytes, hashed: two deliveries share this only when they
      // present the same timestamp and the same signature, which is exactly
      // what a replay is. It stops being admissible when the window the
      // signature was verified against closes, so that is when the claim
      // stops being worth keeping.
      claim: {
        key: `hmac:${sha256Hex(`${String(ts)}.${opts.hmac_signature}`, 32)}`,
        expiresAt: ts + HMAC_TIMESTAMP_WINDOW_MS,
      },
    };
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
  } catch (error) {
    // A JSON content-type with a body that will not parse is a sender's bug,
    // not ours: keep the raw text so the durable event still carries what
    // arrived, and let every other failure propagate.
    if (classify({ cause: error }) !== 'malformed-input') throw error;
    parsedBody = opts.body_text;
  }

  // THE SIGNED ARTIFACT IS SPENT HERE, before anything durable happens.
  //
  // Freshness is not single-use: the same captured timestamp, body and
  // signature verify for the whole ±5 minute window, and admission identity was
  // the body hash inside the RECEIVER's five-minute bucket — so one capture
  // replayed either side of a bucket boundary published two events and woke two
  // turns from one authorization. The claim is what makes it once.
  //
  // A held claim answers as the duplicate it is (the event the first delivery
  // produced, if it got that far), never as a rejection: a sender retrying
  // because it never saw our 202 and an attacker replaying the capture are the
  // same bytes, and the honest answer to both is "already have it".
  const held = auth.claim ? claimSignedDelivery(deps.sql, opts.trigger_id, auth.claim, opts.now) : null;
  if (held !== null) {
    return { status: 'admitted', event_id: held.event_id ?? undefined, admitted: false };
  }

  const delivery_id = opts.delivery_id ?? `${opts.now}-${Math.random().toString(36).slice(2, 10)}`;

  // Open a reply channel for the event system. HTTP delivery itself returns
  // 202 immediately; a future held-response path can wait on this channel
  // without changing the durable event shape.
  // No `ttl_ms_override`: `http_pending` already carries this kind's TTL in
  // reply-channel.ts's own table, and the override here was a second copy of that
  // same 30_000 — two names for one policy, which is how one of them gets edited
  // alone.
  const reply_channel_id = deps.replies.open({
    event_id: 'pending',
    kind: 'http_pending',
    holder_addr: `delivery:${delivery_id}`,
    payload_policy: 'redact',
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
        body_path: bodyPath || undefined,
      },
      auth_outcome: 'verified',
      webhook_id: opts.trigger_id,
    },
    now: opts.now,
    reply_channel: reply_channel_id ? { id: reply_channel_id, kind: 'http_pending' } : undefined,
  });
  // What the claim above now stands for, so a replay is answered with the event
  // rather than with a bare acknowledgement.
  if (auth.claim) bindClaimedDelivery(deps.sql, opts.trigger_id, auth.claim.key, id);

  // Wake the agent to act on the new webhook event — an autonomous turn,
  // debounced so a delivery burst drains as ONE turn. Only when newly
  // admitted (a duplicate is already bound or in flight).
  if (admitted) deps.onAdmitted();

  return { status: 'admitted', event_id: id, admitted };
}

// ── The one-time claim on a signed delivery ──────────────────────

const ClaimRowSchema = v.object({ event_id: v.nullable(v.string()) });

/**
 * The tables webhook ingress admits deliveries against: the per-trigger rate
 * windows, and the claims that make a verified signature single-use.
 *
 * One call rather than two, because a host that provisioned the rate window and
 * not the claim table would still admit deliveries — replayable ones — and
 * nothing downstream would say so.
 */
export function initWebhookIngressTables(sql: SqlExec): void {
  initWebhookRateLimitTables(sql);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_replay_claims (
      trigger_id TEXT NOT NULL,
      claim      TEXT NOT NULL,
      -- The event the claiming delivery published, once it published one. NULL
      -- for the instant between the claim and the publish, and permanently for
      -- an activation that died inside it: the delivery is spent either way,
      -- which is the at-most-once side of this trade and the correct one when
      -- the alternative is publishing a captured request twice.
      event_id   TEXT,
      claimed_at INTEGER NOT NULL,
      -- When the claimed proof stops being admissible on its own terms, so the
      -- row stops being worth keeping. Bounded by the signature window, which
      -- is what bounds this table.
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (trigger_id, claim)
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_replay_claims_gc
    ON webhook_replay_claims (expires_at)
  `);
}

/**
 * Spend one signed delivery, or report the claim already held.
 *
 * Returns null when THIS delivery took the claim, and the held row when an
 * earlier one did. Read-then-insert with no await between them: a Durable
 * Object's input gate does not reopen inside a synchronous run, so two
 * deliveries of the same signature cannot both see it free.
 */
function claimSignedDelivery(
  sql: SqlExec,
  triggerId: string,
  claim: { key: string; expiresAt: number },
  now: number,
): { event_id: string | null } | null {
  sql.exec(`DELETE FROM webhook_replay_claims WHERE expires_at <= ?`, now);
  const held = v.safeParse(ClaimRowSchema, sql.exec(
    `SELECT event_id FROM webhook_replay_claims WHERE trigger_id = ? AND claim = ?`,
    triggerId, claim.key,
  ).toArray()[0]);
  if (held.success) return { event_id: held.output.event_id };
  sql.exec(
    `INSERT INTO webhook_replay_claims (trigger_id, claim, event_id, claimed_at, expires_at)
     VALUES (?, ?, NULL, ?, ?)`,
    triggerId, claim.key, now, claim.expiresAt,
  );
  return null;
}

/** Name the event a spent claim produced. */
function bindClaimedDelivery(sql: SqlExec, triggerId: string, claim: string, eventId: string): void {
  sql.exec(
    `UPDATE webhook_replay_claims SET event_id = ? WHERE trigger_id = ? AND claim = ?`,
    eventId, triggerId, claim,
  );
}
