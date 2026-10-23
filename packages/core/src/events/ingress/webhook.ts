import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Webhook ingress. hmac: `X-Kinu-Signature` = HMAC-SHA256(secret, `<ts>.<body>`), timestamp within
 * ±5 min, signature claimed once for that window. bearer: constant-time compare. mtls: edge-verified.
 * github: a repository hook Kinu made, `X-Hub-Signature-256` = `sha256=` HMAC-SHA256(secret, body)
 * (docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries), claimed once for the days GitHub keeps a
 * delivery to redeliver; its `ping` is answered and checks nothing.
 */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { TriggerRegistry } from '../hub/triggers';
import type { TriggerRow } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import { Effect, Result } from 'effect';
import { settle, settleSync } from '../../obs/index';
import { decodeJsonValue, safeJsonParse, type JsonValue } from '../../utils/json';
import { checkWatcher, watchCheckOf, type WatchDeps } from './watch';
import type { SqlExec } from '../../types/primitives';
import { hmacSha256Hex, timingSafeEqual } from '../../utils/crypto';
import {
  initWebhookRateLimitTables, normalizeWebhookRateLimitPerMin, tryConsumeWebhookRateLimit,
} from './rate-limit';
import { sha256Hex } from '../../safety/argument-digest';
import type { WebhookSecretStore } from './secrets';

const HMAC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export type WebhookAuthMode = 'hmac' | 'bearer' | 'mtls' | 'github';

/** GitHub keeps a delivery to redeliver for 3 days (docs.github.com/webhooks/testing-and-troubleshooting-webhooks/
 *  redelivering-webhooks); its signature covers no time, so one is held that long and a replay within it is a duplicate. */
const GITHUB_CLAIM_MS = 3 * 24 * 60 * 60 * 1000;

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
  vfs: VFS;
  secrets: SecretStore;
  sql: SqlExec;
  onAdmitted(): void;
  /** Where a watcher's check runs; absent, a watcher's delivery publishes as any webhook's does. */
  watch?: Pick<WatchDeps, 'run' | 'claims'>;
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

  const registered: RegisteredWebhook = { trigger_id, secret_id, auth_mode: opts.auth_mode, secret };

  if (secret === null) return registered;

  return settleSync(Effect.try({ try: () => secrets.put(secret_id, trigger_id, secret), catch: (cause) => ({ cause }) }).pipe(
    Effect.tapError(() => Effect.sync(() => {
      registry.revoke(trigger_id, now);
      secrets.deleteByTrigger(trigger_id);
    })),
    Effect.catch((failed) => Effect.die(new Error(`webhook "${opts.label}" was not created: its secret could not be stored`, { cause: failed.cause }))),
    Effect.as(registered),
  ));
}

interface WebhookRefusal { readonly reason: string }

interface WebhookAuth {
  readonly ingress: 'webhook_hmac' | 'webhook_bearer' | 'webhook_mtls';
  readonly claim?: { key: string; expiresAt: number };
}

const refused = (reason: string): Effect.Effect<never, WebhookRefusal> => Effect.fail({ reason });

/** Only HMAC yields a `claim` (the signed artifact), making the signature single-use. */
function verifyWebhookAuth(
  deps: WebhookIngressDeps,
  spec: Partial<WebhookTriggerSpec>,
  opts: WebhookDelivery,
): Effect.Effect<WebhookAuth, WebhookRefusal> {
  return Effect.gen(function* () {
    if (spec.auth_mode === 'hmac') {
      const secretId = spec.secret_id;

      if (!secretId) return yield* refused('no hmac secret configured');
      const secret = yield* Effect.promise(() => deps.secrets.get(secretId));

      if (!secret) return yield* refused('secret revoked');

      if (!opts.hmac_signature || !opts.hmac_timestamp) return yield* refused('missing hmac headers');

      const ts = parseInt(opts.hmac_timestamp, 10);

      if (!Number.isFinite(ts) || Math.abs(opts.now - ts) > HMAC_TIMESTAMP_WINDOW_MS) return yield* refused('timestamp out of window');

      const signature = opts.hmac_signature;
      const expected = yield* Effect.promise(() => hmacSha256Hex(secret, `${ts}.${opts.body_text}`));

      if (!timingSafeEqual(expected, signature)) return yield* refused('signature mismatch');

      return {
        ingress: 'webhook_hmac',
        claim: {
          key: `hmac:${sha256Hex(`${String(ts)}.${signature}`, 32)}`,
          expiresAt: ts + HMAC_TIMESTAMP_WINDOW_MS,
        },
      };
    }

    if (spec.auth_mode === 'github') return yield* verifyGitHubDelivery(deps, spec, opts);

    if (spec.auth_mode === 'bearer') {
      const secretId = spec.secret_id;

      if (!secretId) return yield* refused('no bearer secret');
      const stored = yield* Effect.promise(() => deps.secrets.get(secretId));

      if (!stored) return yield* refused('secret revoked');

      if (!opts.bearer_header || !opts.bearer_header.startsWith('Bearer ')) return yield* refused('missing bearer');

      const presented = opts.bearer_header.slice('Bearer '.length).trim();

      if (!timingSafeEqual(stored, presented)) return yield* refused('bearer mismatch');

      return { ingress: 'webhook_bearer' };
    }

    if (!opts.cf_mtls_verified) return yield* refused('client cert not verified');

    return { ingress: 'webhook_mtls' };
  });
}

/** A delivery from a repository hook Kinu made: signed over its body alone, so its signature is what is claimed once. */
function verifyGitHubDelivery(deps: WebhookIngressDeps, spec: Partial<WebhookTriggerSpec>, opts: WebhookDelivery): Effect.Effect<WebhookAuth, WebhookRefusal> {
  return Effect.gen(function* () {
    const secretId = spec.secret_id;

    if (!secretId) return yield* refused('no github secret configured');
    const secret = yield* Effect.promise(() => deps.secrets.get(secretId));

    if (!secret) return yield* refused('secret revoked');
    const presented = opts.headers['x-hub-signature-256'];

    if (presented === undefined || !presented.startsWith('sha256=')) return yield* refused('missing X-Hub-Signature-256');
    const expected = `sha256=${yield* Effect.promise(() => hmacSha256Hex(secret, opts.body_text))}`;

    if (!timingSafeEqual(expected, presented)) return yield* refused('signature mismatch');

    return { ingress: 'webhook_hmac', claim: { key: `github:${sha256Hex(presented, 32)}`, expiresAt: opts.now + GITHUB_CLAIM_MS } };
  });
}

/** A repository hook's delivery as its check reads it: GitHub's event name and delivery id beside the payload. */
function gitHubInput(opts: WebhookDelivery, payload: JsonValue): JsonValue {
  return { event: opts.headers['x-github-event'] ?? null, delivery: opts.headers['x-github-delivery'] ?? null, payload };
}

/** A delivery a check answers, or GitHub's ping that nothing answers; null for one published as an event. */
async function checkedDelivery(
  deps: WebhookIngressDeps, trigger: TriggerRow, opts: WebhookDelivery, body: JsonValue,
): Promise<WebhookDeliveryResult | null> {
  const github = trigger.spec['auth_mode'] === 'github';

  // GitHub's ping when a hook is made: answered, and nothing to check.
  if (github && opts.headers['x-github-event'] === 'ping') return { status: 'admitted', admitted: false };

  if (deps.watch === undefined || watchCheckOf(trigger) === null) return null;

  return watchedDelivery(deps, trigger.id, opts.now, github ? gitHubInput(opts, body) : body);
}

/**
 * A watcher's delivery is its check's input, and only what the check found is published. Answered once the check
 * committed: a deliverer that gave up and sends again is folded into the running check's re-check.
 */
async function watchedDelivery(deps: WebhookIngressDeps, triggerId: string, at: number, input: JsonValue): Promise<WebhookDeliveryResult> {
  const { watch } = deps;

  if (watch === undefined) return { status: 'rejected', http_status: 503, reason: 'this workspace runs no checks' };
  const fired = await checkWatcher({ registry: deps.triggers, log: deps.log, ...watch }, triggerId, { at, timer: false, input }, Date.now);

  if (fired) deps.onAdmitted();

  return { status: 'admitted', event_id: undefined, admitted: fired };
}

export function acceptWebhookDelivery(
  deps: WebhookIngressDeps,
  opts: WebhookDelivery,
): Promise<WebhookDeliveryResult> {
  return settle(Effect.gen(function* () {
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

    const verified = yield* Effect.result(verifyWebhookAuth(deps, spec, opts));

    if (Result.isFailure(verified)) return { status: 'rejected', http_status: 401, reason: verified.failure.reason };
    const auth = verified.success;

    const rate = tryConsumeWebhookRateLimit(deps.sql, opts.trigger_id, trigger.rate_limit_per_min, opts.now);

    if (!rate.allowed) {
      return { status: 'rejected', http_status: 429, reason: `rate limit exceeded (${rate.limit}/min)` };
    }

    // Unparseable JSON is kept as raw text; other failures propagate.
    const parsedBody: unknown = receivedCT.includes('json') ? safeJsonParse(opts.body_text) : opts.body_text;

    // Spend the claim before anything durable: freshness alone admits a replay across a dedupe
    // bucket boundary. A held claim answers as a duplicate, never a rejection.
    const held = auth.claim ? claimSignedDelivery(deps.sql, opts.trigger_id, auth.claim, opts.now) : null;

    if (held !== null) {
      return { status: 'admitted', event_id: held.event_id ?? undefined, admitted: false };
    }

    const checked = yield* Effect.promise(() => checkedDelivery(deps, trigger, opts, decodeJsonValue({ value: parsedBody ?? null })));

    if (checked !== null) return checked;

    const delivery_id = opts.delivery_id ?? `${opts.now}-${Math.random().toString(36).slice(2, 10)}`;

    // Spill after the auth and rate gates so a rejected delivery never writes a file.
    const bodySerialized = JSON.stringify(parsedBody) ?? String(parsedBody);
    const spilled = yield* Effect.promise(() => spillEventContent(deps.vfs, bodySerialized));

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
  }));
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
    `INSERT INTO webhook_replay_claims (trigger_id, claim, event_id, expires_at) VALUES (?, ?, NULL, ?)`,
    triggerId, claim.key, claim.expiresAt,
  );

  return null;
}

function bindClaimedDelivery(sql: SqlExec, triggerId: string, claim: string, eventId: string): void {
  sql.exec(
    `UPDATE webhook_replay_claims SET event_id = ? WHERE trigger_id = ? AND claim = ?`,
    eventId, triggerId, claim,
  );
}
