/**
 * Webhook ingress. hmac: `X-Kinu-Signature` = HMAC-SHA256(secret, `<ts>.<body>`), timestamp within
 * ±5 min, signature claimed once for that window. bearer: constant-time compare. mtls: edge-verified.
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

const HMAC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export type WebhookAuthMode = 'hmac' | 'bearer' | 'mtls';

export interface SecretStore {
  get(secretId: string): Promise<string | null>;
}

/** Read as claimed, not trusted: an absent or unknown `auth_mode` demands mTLS, the strictest. */
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
  vfs: VFS;
  secrets: SecretStore;
  sql: SqlExec;
  onAdmitted(): void;
}

export interface RegisterWebhookOpts {
  label: string;
  auth_mode: WebhookAuthMode;
  /** Blank or absent under hmac/bearer mints one. */
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

export interface RegisteredWebhook {
  trigger_id: string;
  /** Never returned to a reader of the trigger row. */
  secret_id: string;
  auth_mode: WebhookAuthMode;
  /** Shown to the operator once; null only for mTLS. No route serves it again. */
  secret: string | null;
}

function freshWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whitespace-only counts as absent. */
function webhookSecretOrMinted(provided: string | undefined): string {
  const trimmed = provided?.trim() ?? '';

  return trimmed === '' ? freshWebhookSecret() : trimmed;
}

/** A failed secret write revokes the trigger: an hmac trigger without a secret can never receive. */
export async function registerDurableWebhook(
  registry: TriggerRegistry,
  secrets: Pick<WebhookSecretStore, 'put' | 'deleteByTrigger'>,
  opts: RegisterWebhookOpts,
  now: number,
): Promise<RegisteredWebhook> {
  const rate_limit_per_min = normalizeWebhookRateLimitPerMin(opts.rate_limit_per_min);
  const secret_id = `webhook_secret_${Math.random().toString(36).slice(2, 12)}`;
  const secret = opts.auth_mode === 'mtls' ? null : webhookSecretOrMinted(opts.secret);

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

/** Only HMAC yields a `claim` (the signed artifact), making the signature single-use. */
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
    // Unparseable JSON is kept as raw text; other failures propagate.
    if (classify({ cause: error }) !== 'malformed-input') throw error;
    parsedBody = opts.body_text;
  }

  // Spend the claim before anything durable: freshness alone admits a replay across a dedupe
  // bucket boundary. A held claim answers as a duplicate, never a rejection.
  const held = auth.claim ? claimSignedDelivery(deps.sql, opts.trigger_id, auth.claim, opts.now) : null;

  if (held !== null) {
    return { status: 'admitted', event_id: held.event_id ?? undefined, admitted: false };
  }

  const delivery_id = opts.delivery_id ?? `${opts.now}-${Math.random().toString(36).slice(2, 10)}`;

  // No `ttl_ms_override`: the `http_pending` TTL lives in reply-channel.ts.
  deps.replies.open({
    event_id: 'pending',
    kind: 'http_pending',
    holder_addr: `delivery:${delivery_id}`,
    payload_policy: 'redact',
  }, opts.now);

  // Spill after the auth and rate gates so a rejected delivery never writes a file.
  const bodySerialized = JSON.stringify(parsedBody) ?? String(parsedBody);
  const spilled = await spillEventContent(deps.vfs, bodySerialized);

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
        body_path: spilled?.path,
        body_unsaved: spilled?.unsaved,
      },
      auth_outcome: 'verified',
      webhook_id: opts.trigger_id,
    },
    now: opts.now,
  });

  if (auth.claim) bindClaimedDelivery(deps.sql, opts.trigger_id, auth.claim.key, id);

  if (admitted) deps.onAdmitted();

  return { status: 'admitted', event_id: id, admitted };
}

const ClaimRowSchema = v.object({ event_id: v.nullable(v.string()) });

/** One call so a host cannot provision rate windows without the claim table. */
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

/** Null when this delivery took the claim. No await between read and insert: a DO's input gate
 *  does not reopen inside a synchronous run. */
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

function bindClaimedDelivery(sql: SqlExec, triggerId: string, claim: string, eventId: string): void {
  sql.exec(
    `UPDATE webhook_replay_claims SET event_id = ? WHERE trigger_id = ? AND claim = ?`,
    eventId, triggerId, claim,
  );
}
