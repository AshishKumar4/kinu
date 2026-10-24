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
import { decodeJsonValue, safeJsonParse, type JsonObject, type JsonValue } from '../../utils/json';
import { checkWatcher, watchCheckOf, WatchCheckSchema, type WatchAsk, type WatchCheck, type WatchDeps } from './watch';
import type { SqlExec } from '../../types/primitives';
import { hmacSha256Hex, timingSafeEqual } from '../../utils/crypto';
import {
  initWebhookRateLimitTables, normalizeWebhookRateLimitPerMin, tryConsumeWebhookRateLimit,
} from './rate-limit';
import { sha256Hex } from '../../safety/argument-digest';
import type { WebhookSecretStore } from './secrets';

const HMAC_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export type WebhookAuthMode = 'hmac' | 'bearer' | 'mtls' | 'github';

/** A GitHub signature covers no time, so a claimed one is held as long as its secret can verify it: a replay, ever, is a
 *  duplicate. A rotated secret, or a revoked trigger, forgets its claims ({@link forgetClaims}). */
const GITHUB_CLAIM_KEPT = Number.MAX_SAFE_INTEGER;

/** What GitHub signs when a hook is made (its ping), and what every delivery of a repository hook signs it names. */
const GitHubPingSchema = v.object({ zen: v.string(), hook_id: v.number() });

const GitHubRepositorySchema = v.object({ repository: v.object({ full_name: v.string() }) });

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

/** A new webhook secret: 32 random bytes as hex. */
export function freshWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whitespace-only counts as absent. */
function webhookSecretOrMinted(provided: string | undefined): string {
  const trimmed = provided?.trim() ?? '';

  return trimmed === '' ? freshWebhookSecret() : trimmed;
}

/** A push watcher's own part of its trigger: the repository whose deliveries it checks, and the hook made for it. */
const GitHubPushSchema = v.object({
  source: v.literal('github-repo'), repo: v.string(), event: v.string(), hookId: v.optional(v.number()),
});

export type GitHubPush = v.InferOutput<typeof GitHubPushSchema>;

/** The trigger's push watch; null for one that is none. */
export function gitHubPushOf(trigger: Pick<TriggerRow, 'spec'>): GitHubPush | null {
  const push = v.safeParse(GitHubPushSchema, trigger.spec['push']);

  return push.success ? push.output : null;
}

/** A push watcher as its agent reads it back. */
export interface PushWatcher {
  readonly id: string;
  readonly kind: 'webhook_durable';
  readonly repo: string;
  readonly hookId: number;
}

export interface PushWatcherOpts {
  readonly repo: string;
  /** The one event its hook delivers: a signature covers the body alone, so one event per hook is what says which it is. */
  readonly event: string;
  readonly label?: string;
  readonly payload?: JsonObject;
  readonly missionLabel?: string;
  readonly check: WatchCheck;
}

/**
 * A watcher GitHub's deliveries for `opts.repo` run rather than a clock: a webhook trigger an agent made, whose deliveries
 * are signed with the secret minted here (`auth_mode: 'github'`). Its hook is made next, at GitHub, and kept by
 * {@link keepPushHook}; a secret that cannot be stored leaves no trigger.
 */
export function registerPushWatcher(
  registry: TriggerRegistry, secrets: Pick<WebhookSecretStore, 'put' | 'deleteByTrigger'>, opts: PushWatcherOpts, now: number,
): Promise<{ readonly trigger_id: string; readonly secret: string }> {
  return settle(Effect.gen(function* () {
    const secret_id = `webhook_secret_${Math.random().toString(36).slice(2, 12)}`;
    const secret = freshWebhookSecret();

    const spec: JsonObject = {
      auth_mode: 'github', secret_id, accepted_content_type: 'application/json',
      push: { source: 'github-repo', repo: opts.repo, event: opts.event },
      ...(opts.label !== undefined && { label: opts.label }),
      ...(opts.payload !== undefined && { payload: opts.payload }),
      ...(opts.missionLabel !== undefined && { mission_label: opts.missionLabel }),
      check: v.parse(WatchCheckSchema, opts.check),
    };

    const trigger_id = yield* Effect.promise(() => registry.register({ kind: 'webhook_durable', spec, creator_trust: 'authenticated' }, now));

    yield* storedSecret({ registry, secrets, trigger_id, secret_id, secret, now }, `the watcher of ${opts.repo}`);

    return { trigger_id, secret };
  }));
}

/** The hook made at GitHub for a push watcher, kept in its push watch; false for a trigger that is no push watcher. */
export function keepPushHook(registry: TriggerRegistry, triggerId: string, hookId: number): boolean {
  const trigger = registry.get(triggerId);
  const push = trigger === null ? null : gitHubPushOf(trigger);

  return trigger !== null && push !== null && registry.amendSpec(triggerId, { ...trigger.spec, push: { ...push, hookId } });
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

  return settleSync(storedSecret({ registry, secrets, trigger_id, secret_id, secret, now }, `webhook "${opts.label}"`).pipe(Effect.as(registered)));
}

/** A new trigger's secret stored, or the trigger revoked: one that cannot verify a delivery can never receive. */
function storedSecret(
  held: {
    readonly registry: TriggerRegistry; readonly secrets: Pick<WebhookSecretStore, 'put' | 'deleteByTrigger'>;
    readonly trigger_id: string; readonly secret_id: string; readonly secret: string; readonly now: number;
  },
  what: string,
): Effect.Effect<void> {
  const { registry, secrets, trigger_id, secret_id, secret, now } = held;

  return Effect.try({ try: () => secrets.put(secret_id, trigger_id, secret), catch: (cause) => ({ cause }) }).pipe(
    Effect.tapError(() => Effect.sync(() => {
      registry.revoke(trigger_id, now);
      secrets.deleteByTrigger(trigger_id);
    })),
    Effect.catch((failed) => Effect.die(new Error(`${what} was not created: its secret could not be stored`, { cause: failed.cause }))),
  );
}

interface WebhookRefusal { readonly reason: string }

/** What a delivery's proof lets it spend once: its key, and until when the proof would verify again. */
interface SignedClaim {
  readonly key: string;
  readonly expiresAt: number;
}

interface WebhookAuth {
  readonly ingress: 'webhook_hmac' | 'webhook_bearer' | 'webhook_mtls';
  readonly claim?: SignedClaim;
}

const refused = (reason: string): Effect.Effect<never, WebhookRefusal> => Effect.fail({ reason });

/** Only HMAC yields a `claim` (the signed artifact), making the signature single-use. */
function verifyWebhookAuth(
  deps: WebhookIngressDeps,
  spec: Partial<WebhookTriggerSpec>,
  opts: WebhookDelivery,
  push: GitHubPush | null,
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

    if (spec.auth_mode === 'github') return yield* verifyGitHubDelivery(deps, spec, opts, push);

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

/**
 * Why a signed body is not one the watcher asked for, or null when it is: it names another repository, or GitHub calls it
 * another event than the one its hook delivers. A ping, known by its body, is asked for. The event header is not signed,
 * but the hook delivers one event alone, so a signed body is of that one, and a header naming another is refused.
 */
function notWatched(push: GitHubPush | null, body: JsonValue, event: string | undefined): string | null {
  if (v.is(GitHubPingSchema, body)) return null;
  const named = v.safeParse(GitHubRepositorySchema, body);

  if (push === null || !named.success || named.output.repository.full_name.toLowerCase() !== push.repo.toLowerCase()) return 'the delivery names another repository';

  if (event !== push.event) return 'the delivery is of an event the watcher did not ask for';

  return null;
}

/**
 * A delivery from a repository hook Kinu made: signed over its body alone, so its signature is what is claimed once, and
 * it must be one the watcher asked for ({@link notWatched}) before it is claimed.
 */
function verifyGitHubDelivery(deps: WebhookIngressDeps, spec: Partial<WebhookTriggerSpec>, opts: WebhookDelivery, push: GitHubPush | null): Effect.Effect<WebhookAuth, WebhookRefusal> {
  return Effect.gen(function* () {
    const secretId = spec.secret_id;

    if (!secretId) return yield* refused('no github secret configured');
    const secret = yield* Effect.promise(() => deps.secrets.get(secretId));

    if (!secret) return yield* refused('secret revoked');
    const presented = opts.headers['x-hub-signature-256'];

    if (presented === undefined || !presented.startsWith('sha256=')) return yield* refused('missing X-Hub-Signature-256');
    const expected = `sha256=${yield* Effect.promise(() => hmacSha256Hex(secret, opts.body_text))}`;

    if (!timingSafeEqual(expected, presented)) return yield* refused('signature mismatch');
    const unasked = notWatched(push, safeJsonParse(opts.body_text), opts.headers['x-github-event']);

    if (unasked !== null) return yield* refused(unasked);

    return { ingress: 'webhook_hmac', claim: { key: `github:${sha256Hex(presented, 32)}`, expiresAt: GITHUB_CLAIM_KEPT } };
  });
}

/** A repository hook's delivery as its check reads it: the one event its hook delivers, and GitHub's delivery id beside
 *  the payload. The id is not signed: it is GitHub's word, as sent. */
function gitHubInput(push: GitHubPush | null, opts: WebhookDelivery, payload: JsonValue): JsonValue {
  return { event: push?.event ?? null, delivery: opts.headers['x-github-delivery'] ?? null, payload };
}

/** Whether a check answers the trigger's deliveries, rather than each being published as an event. */
function watchesDeliveries(deps: WebhookIngressDeps, trigger: TriggerRow): boolean {
  return deps.watch !== undefined && watchCheckOf(trigger) !== null;
}

/** A delivery a check answers, or GitHub's ping that nothing answers; null for one published as an event. `claim` is
 *  what its signature proved, which keys a fire and is taken with it; a delivery none proved is keyed by its arrival. */
async function checkedDelivery(
  deps: WebhookIngressDeps, trigger: TriggerRow, opts: WebhookDelivery, delivered: { body: JsonValue; claim: SignedClaim | undefined },
): Promise<WebhookDeliveryResult | null> {
  const { body, claim } = delivered;
  const github = trigger.spec['auth_mode'] === 'github';

  // GitHub's ping when a hook is made, known by its signed body: answered, and nothing to check.
  if (github && v.is(GitHubPingSchema, body)) return { status: 'admitted', admitted: false };

  if (!watchesDeliveries(deps, trigger)) return null;

  const input = github ? gitHubInput(gitHubPushOf(trigger), opts, body) : body;
  const signed = claim === undefined ? {} : { delivery: claim.key, claim: () => claimSignedDelivery(deps.sql, trigger.id, claim, opts.now) === null };

  return watchedDelivery(deps, trigger.id, { at: opts.now, input, ...signed });
}

/**
 * A watcher's delivery is its check's input, and only what the check found is published. Answered once the check
 * committed: a deliverer that gave up and sends again is folded into the running check's re-check.
 */
async function watchedDelivery(deps: WebhookIngressDeps, triggerId: string, asked: Omit<WatchAsk, 'timer'>): Promise<WebhookDeliveryResult> {
  const { watch } = deps;

  if (watch === undefined) return { status: 'rejected', http_status: 503, reason: 'this workspace runs no checks' };
  const fired = await checkWatcher({ registry: deps.triggers, log: deps.log, ...watch }, triggerId, { ...asked, timer: false }, Date.now);

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

    const verified = yield* Effect.result(verifyWebhookAuth(deps, spec, opts, gitHubPushOf(trigger)));

    if (Result.isFailure(verified)) return { status: 'rejected', http_status: 401, reason: verified.failure.reason };
    const auth = verified.success;

    const rate = tryConsumeWebhookRateLimit(deps.sql, opts.trigger_id, trigger.rate_limit_per_min, opts.now);

    if (!rate.allowed) {
      return { status: 'rejected', http_status: 429, reason: `rate limit exceeded (${rate.limit}/min)` };
    }

    // Unparseable JSON is kept as raw text; other failures propagate.
    const parsedBody: unknown = receivedCT.includes('json') ? safeJsonParse(opts.body_text) : opts.body_text;

    // Spend the claim before anything durable: freshness alone admits a replay across a dedupe
    // bucket boundary. A held claim answers as a duplicate, never a rejection. A watched delivery's
    // claim is only read here: its check's commit takes it, with what the check found.
    const spend = watchesDeliveries(deps, trigger) ? heldClaim : claimSignedDelivery;
    const held = auth.claim === undefined ? null : spend(deps.sql, opts.trigger_id, auth.claim, opts.now);

    if (held !== null) {
      return { status: 'admitted', event_id: held.event_id ?? undefined, admitted: false };
    }

    const checked = yield* Effect.promise(() => checkedDelivery(deps, trigger, opts, { body: decodeJsonValue({ value: parsedBody ?? null }), claim: auth.claim }));

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

/** The delivery that holds `claim` already, or null when none does; expired claims go first. */
function heldClaim(sql: SqlExec, triggerId: string, claim: SignedClaim, now: number): { event_id: string | null } | null {
  sql.exec(`DELETE FROM webhook_replay_claims WHERE expires_at <= ?`, now);

  const held = v.safeParse(ClaimRowSchema, sql.exec(
    `SELECT event_id FROM webhook_replay_claims WHERE trigger_id = ? AND claim = ?`,
    triggerId, claim.key,
  ).toArray()[0]);

  return held.success ? { event_id: held.output.event_id } : null;
}

/** Null when this delivery took the claim. No await between read and insert: a DO's input gate
 *  does not reopen inside a synchronous run. */
function claimSignedDelivery(sql: SqlExec, triggerId: string, claim: SignedClaim, now: number): { event_id: string | null } | null {
  const held = heldClaim(sql, triggerId, claim, now);

  if (held !== null) return held;
  sql.exec(
    `INSERT INTO webhook_replay_claims (trigger_id, claim, event_id, expires_at) VALUES (?, ?, NULL, ?)`,
    triggerId, claim.key, claim.expiresAt,
  );

  return null;
}

/** Every claim of a trigger forgotten: its secret rotated, no signature it claimed can verify again. */
export function forgetClaims(sql: SqlExec, triggerId: string): void {
  sql.exec(`DELETE FROM webhook_replay_claims WHERE trigger_id = ?`, triggerId);
}

function bindClaimedDelivery(sql: SqlExec, triggerId: string, claim: string, eventId: string): void {
  sql.exec(
    `UPDATE webhook_replay_claims SET event_id = ? WHERE trigger_id = ? AND claim = ?`,
    eventId, triggerId, claim,
  );
}
