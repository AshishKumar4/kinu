// CLI device-authorization flow. A sign-in's state lives in its own short-lived Durable Objects (`auth-do.ts`), which
// read the same at every location: the terminal polls from one and the approval is often made at another. Its rate
// limits stay in KV. The durable CLI token is minted and stored in the user's own DO.

import { Cause, Effect, Result } from 'effect';
import type { AuthIdentity } from '../auth/session';
import type { UserDO } from '../user/user-do';
import type { CliAuthDO } from './auth-do';
import type { ObjectNamespace } from '@kinu.run/core';
import { objectNamed, randomToken, sha256Hex } from '@kinu.run/core';
import { readKvJson, writeKvJson, type KvStore } from '@kinu.run/agent-utils';
import { KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';
import { parseAccessTokenUserId, type AccessTokenScope } from '@kinu.run/core';
import { ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import * as v from 'valibot';

/** Routes map this (and only this) to HTTP 429. */
export class RateLimitError extends KinuError {
  override readonly name: string = 'RateLimitError';

  constructor() {
    super('budget', 'Too many CLI auth attempts. Try again later.');
  }
}

/** Matched by message: error classes do not survive a DO RPC boundary. */
const AUTHORIZATION_SPENT = /already been redeemed/i;

/** Caller-correctable (unknown / expired / already used) → 400; infra failures stay plain errors (500). */
export class CliAuthCodeError extends KinuError {
  override readonly name: string = 'CliAuthCodeError';

  constructor(message: string) {
    super('bad_input', message);
  }
}

const AUTH_TTL_MS = 10 * 60 * 1000;

/** Lets a late poll hear "already delivered" instead of "unknown request". */
const RETENTION_MS = 10 * 60 * 1000;

// Independent of DEFAULT_SESSION_REFLECTION_INTERVAL: this is a client polling
// cadence, while that constant counts completed turns between reflection work.
const POLL_INTERVAL_SECONDS = 5;

const RATE_WINDOW_MS = 10 * 60 * 1000;

export interface CliAuthStartResult {
  deviceToken: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface CliAuthPollResult {
  status: 'pending' | 'approved' | 'expired';
  message?: string;
  origin?: string;
  token?: string;
  expiresAt?: string;
  user?: { id: string; email: string };
}

export interface CliAuthRequestInfo {
  userCode: string;
  deviceName: string;
  status: 'pending' | 'approved' | 'expired' | 'consumed';
  expiresAt: string;
  approvedAt?: string;
  user?: { id: string; email: string };
}

/** `expired` is never stored; it is read off `expiresAt`. */
export const CliAuthRecordSchema = v.object({
  userCode: v.string(),
  deviceName: v.string(),
  status: v.picklist(['pending', 'approved', 'consumed']),
  origin: v.string(),
  userId: v.nullable(v.string()),
  userEmail: v.nullable(v.string()),
  createdAt: v.number(),
  expiresAt: v.number(),
  approvedAt: v.nullable(v.number()),
});

export type CliAuthRecord = v.InferOutput<typeof CliAuthRecordSchema>;

const RateBucketSchema = v.object({ count: v.number(), resetAt: v.number() });

export type CliAuthAuthority = Pick<
  UserDO, 'ensureProfile' | 'mintCliToken' | 'verifyCliToken' | 'verifyAccessToken'
>;

export type CliAuthObject = Pick<CliAuthDO, 'claimCode' | 'deviceOf' | 'open' | 'read' | 'approve' | 'collect'>;

export type CliAuthEnv<Id = DurableObjectId> = OwnerCapabilityEnv & {
  /** Rate limits only: a count read stale at another location loosens a limit for a while, and holds no sign-in. */
  AUTH_KV: KvStore;
  CliAuthDO: ObjectNamespace<Id, CliAuthObject>;
  UserDO: ObjectNamespace<Id, CliAuthAuthority>;
};

interface CliAuthApproval {
  status: 'approved';
  user: { id: string; email: string };
}

export interface CliTokenIdentity<Authority = DurableObjectStub<UserDO>> {
  userId: string;
  email: string;
  displayName: string | null;
  tokenHash: string;
  /** `session` = interactive `ptc_…` token from browser approval (unscoped);
     *  `access` = long-lived `pta_…` CI token restricted to `scopes`. */
  kind: 'session' | 'access';
  scopes: 'all' | AccessTokenScope[];
  userDO: Authority;
}

export function tokenAllows(identity: Pick<CliTokenIdentity, 'scopes'>, scope: AccessTokenScope): boolean {
  return identity.scopes === 'all' || identity.scopes.includes(scope);
}

export type CliTokenAuth<Authority = DurableObjectStub<UserDO>> = Result.Result<CliTokenIdentity<Authority>, string>;

/** `readBearer` is the same read from a Request. */
export function bearerOf(authorization: string | null): string | null {
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim() ?? '';

  return token === '' ? null : token;
}

export function readBearer(request: Request): string | null {
  return bearerOf(request.headers.get('authorization'));
}

/** The `ptc_…` format's single home, used by UserDO.mintCliToken. Keep this module free of
 *  `cloudflare:workers` imports so unit tests load it under plain bun. */
export function parseCliTokenUserId(token: string): string | null {
  const match = /^ptc_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(token);

  return match?.[1] ?? null;
}

/** Null for anything this authenticator does not mint. The preview edge strips Authorization exactly
 *  when this is non-null, so authoritative and withheld bearers are one set by construction. */
export function parseCliBearer(token: string): { userId: string; kind: 'session' | 'access' } | null {
  const sessionUserId = parseCliTokenUserId(token);

  if (sessionUserId) return { userId: sessionUserId, kind: 'session' };
  const accessUserId = parseAccessTokenUserId(token);

  if (accessUserId) return { userId: accessUserId, kind: 'access' };

  return null;
}

/** Accepts `ptc_…` and scoped `pta_…` tokens. Shared by the CLI HTTP API and the MCP server. */
export async function authenticateCliToken<Id, Authority extends CliAuthAuthority>(
  request: Request,
  env: Pick<CliAuthEnv<Id>, 'CREDENTIAL_ENCRYPTION_KEY'> & { UserDO: ObjectNamespace<Id, Authority> },
): Promise<CliTokenAuth<Authority>> {
  const token = readBearer(request);

  if (!token) return Result.fail('Missing Authorization: Bearer <token>');
  const bearer = parseCliBearer(token);

  if (!bearer) return Result.fail('Malformed CLI token');
  const userDO = objectNamed(env.UserDO, bearer.userId);

  const verified = bearer.kind === 'session'
    ? await userDO.verifyCliToken(await ownerCaller(env), token)
    : await userDO.verifyAccessToken(await ownerCaller(env), token);

  if (!verified.ok || !verified.user || !verified.tokenHash) {
    return Result.fail(verified.error ?? 'Invalid CLI token');
  }

  return Result.succeed({
    userId: verified.user.id,
    email: verified.user.email,
    displayName: verified.user.displayName,
    tokenHash: verified.tokenHash,
    kind: bearer.kind,
    scopes: bearer.kind === 'session' ? 'all' : verified.scopes ?? [],
    userDO,
  });
}

export interface CliAuthRequest {
  origin: string;
  approvalOrigin: string;
  deviceName?: string;
  clientKey?: string;
}

export function startCliAuth<Id>(env: CliAuthEnv<Id>, request: CliAuthRequest): Promise<CliAuthStartResult> {
  return settle(Effect.gen(function* () {
    const { origin, approvalOrigin, deviceName, clientKey } = request;
    const now = Date.now();
    yield* rateLimit(env.AUTH_KV, `start:${cleanRateKey(clientKey)}`, 20, now);

    const expiresAt = now + AUTH_TTL_MS;
    const until = expiresAt + RETENTION_MS;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const deviceToken = randomToken(32);
      const userCode = createUserCode();
      const deviceHash = yield* Effect.promise(async () => sha256Hex(deviceToken));

      // The code before its record, harmlessly: nobody holds the code until this answers.
      if (!(yield* Effect.promise(() => codeObject(env, userCode).claimCode(deviceHash, until)))) continue;

      const record: CliAuthRecord = {
        userCode,
        deviceName: cleanDeviceName(deviceName),
        status: 'pending',
        origin: cleanOrigin(origin),
        userId: null,
        userEmail: null,
        createdAt: now,
        expiresAt,
        approvedAt: null,
      };

      yield* Effect.promise(() => deviceObject(env, deviceHash).open(record, until));

      return {
        deviceToken,
        userCode,
        verificationUrl: `${cleanOrigin(approvalOrigin)}/cli/auth?code=${encodeURIComponent(userCode)}`,
        expiresAt: new Date(expiresAt).toISOString(),
        intervalSeconds: POLL_INTERVAL_SECONDS,
      };
    }

    return yield* Effect.die(new Error('Could not allocate a CLI auth code.'));
  }));
}

export async function inspectCliAuth<Id>(env: Pick<CliAuthEnv<Id>, 'CliAuthDO'>, userCode: string): Promise<CliAuthRequestInfo | null> {
  const device = await deviceByUserCode(env, userCode);
  const record = device === null ? null : await device.read();

  if (!record) return null;

  return {
    userCode: record.userCode,
    deviceName: record.deviceName,
    status: currentStatus(record),
    expiresAt: new Date(record.expiresAt).toISOString(),
    approvedAt: record.approvedAt ? new Date(record.approvedAt).toISOString() : undefined,
    user: record.userId && record.userEmail ? { id: record.userId, email: record.userEmail } : undefined,
  };
}

export function pollCliAuth<Id>(
  env: CliAuthEnv<Id>, deviceToken: string, clientKey?: string,
): Promise<CliAuthPollResult> {
  return settle(Effect.gen(function* () {
    const now = Date.now();
    yield* rateLimit(env.AUTH_KV, `poll-ip:${cleanRateKey(clientKey)}`, 300, now);

    const hash = sha256Hex(deviceToken);
    yield* rateLimit(env.AUTH_KV, `poll-device:${hash}`, 180, now);

    // An approved request is consumed as it is read, so no other poll reads it approved.
    const record = yield* Effect.promise(() => deviceObject(env, hash).collect(now));

    if (!record) return { status: 'expired', message: 'Unknown CLI auth request.' };

    const status = currentStatus(record, now);

    if (status === 'expired') return { status: 'expired', message: 'CLI auth request expired.' };

    if (status === 'pending') return { status: 'pending' };

    if (status === 'consumed') {
      return { status: 'expired', message: 'CLI auth token was already delivered. Run kinu auth again if it was not saved.' };
    }

    if (!record.userId || !record.userEmail) {
      return { status: 'expired', message: 'CLI auth approval is incomplete. Run kinu auth again.' };
    }

    // The one-time claim is still the UserDO mint's, keyed by the device hash: one approval is one token whatever the
    // request's object answers.
    const userDO = objectNamed(env.UserDO, record.userId);
    const userId = record.userId;

    const minted = yield* Effect.catchCause(
      Effect.promise(async (): Promise<{ token: string; expiresAt: number }> => userDO.mintCliToken(await ownerCaller(env), userId, hash, record.deviceName)),
      (failed) => {
        const cause = Cause.squash(failed);

        // Error classes do not survive the RPC boundary, so the message is the contract.
        return AUTHORIZATION_SPENT.test(renderThrownChain({ cause })) ? Effect.succeed(null) : Effect.die(cause);
      },
    );

    if (minted === null) {
      return {
        status: 'expired',
        message: 'CLI auth token was already delivered. Run kinu auth again if it was not saved.',
      };
    }

    return {
      status: 'approved',
      origin: record.origin,
      token: minted.token,
      expiresAt: new Date(minted.expiresAt).toISOString(),
      user: { id: record.userId, email: record.userEmail },
    };
  }));
}

export function approveCliAuth<Id>(
  env: CliAuthEnv<Id>,
  userCode: string,
  identity: AuthIdentity,
  clientKey?: string,
): Promise<CliAuthApproval> {
  return settle(Effect.gen(function* () {
    const now = Date.now();
    yield* rateLimit(env.AUTH_KV, `approve:${identity.userId}:${cleanRateKey(clientKey)}`, 30, now);

    const device = yield* Effect.promise(async () => deviceByUserCode(env, userCode));

    if (device === null) return yield* Effect.die(new CliAuthCodeError('Unknown CLI auth code.'));
    const replayed = yield* approvalOf(yield* Effect.promise(() => device.read()), identity, now);

    if (replayed !== null) return replayed;
    const userDO = objectNamed(env.UserDO, identity.userId);
    yield* Effect.promise(async () => userDO.ensureProfile(await ownerCaller(env), identity.email));

    // The object approves only a pending request, so one approved or expired since the read is answered as it stands.
    const approved = yield* approvalOf(yield* Effect.promise(() => device.approve(identity.userId, identity.email, now)), identity, now);

    if (approved === null) return yield* Effect.die(new Error('The CLI auth request was still pending after its approval.'));

    return approved;
  }));
}

/** What approving `record` as `identity` answers once it is no longer pending; null while it is. */
function approvalOf(record: CliAuthRecord | null, identity: AuthIdentity, now: number): Effect.Effect<CliAuthApproval | null> {
  if (record === null) return Effect.die(new CliAuthCodeError('Unknown CLI auth code.'));
  const status = currentStatus(record, now);

  if (status === 'pending') return Effect.succeed(null);

  if (status === 'expired') return Effect.die(new CliAuthCodeError('CLI auth code expired. Run kinu auth again.'));

  // Idempotent replay only for the original approver; others must not learn whose code it is.
  if (record.userId !== identity.userId) return Effect.die(new CliAuthCodeError('CLI auth code already used.'));

  return Effect.succeed({ status: 'approved', user: { id: identity.userId, email: record.userEmail ?? identity.email } });
}

/**
 * Abuse ceiling per client key and window. It stays in KV, whose reads are cached per location: a count read stale
 * there loosens the limit for a while, which a ceiling can afford, and no sign-in waits on it.
 */
function rateLimit(kv: KvStore, key: string, limit: number, now: number): Effect.Effect<void, RateLimitError> {
  return Effect.gen(function* () {
    const bucketKey = `cli-auth-rate:${key}`;
    const bucket = yield* Effect.promise(() => readKvJson(kv, bucketKey, RateBucketSchema));

    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + RATE_WINDOW_MS;
      yield* Effect.promise(() => writeKvJson(kv, bucketKey, { count: 1, resetAt }, RATE_WINDOW_MS));

      return;
    }

    if (bucket.count >= limit) return yield* new RateLimitError();
    yield* Effect.promise(() => writeKvJson(kv, bucketKey, { count: bucket.count + 1, resetAt: bucket.resetAt }, bucket.resetAt - now));
  });
}

/** The request object a user code names; null for a code no live sign-in holds. */
async function deviceByUserCode<Id>(env: Pick<CliAuthEnv<Id>, 'CliAuthDO'>, userCode: string): Promise<CliAuthObject | null> {
  const deviceHash = await codeObject(env, normalizeUserCode(userCode)).deviceOf();

  return deviceHash === null ? null : deviceObject(env, deviceHash);
}

function deviceObject<Id>(env: Pick<CliAuthEnv<Id>, 'CliAuthDO'>, deviceHash: string): CliAuthObject {
  return objectNamed(env.CliAuthDO, `device:${deviceHash}`);
}

function codeObject<Id>(env: Pick<CliAuthEnv<Id>, 'CliAuthDO'>, userCode: string): CliAuthObject {
  return objectNamed(env.CliAuthDO, `code:${userCode}`);
}

export function currentStatus(record: CliAuthRecord, now = Date.now()): CliAuthRequestInfo['status'] {
  if (record.status !== 'consumed' && now > record.expiresAt) return 'expired';

  return record.status;
}

function cleanDeviceName(input?: string): string {
  const s = (input ?? 'terminal').trim().replace(/\s+/g, ' ');

  return s ? s.slice(0, 80) : 'terminal';
}

function cleanOrigin(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function cleanRateKey(input?: string): string {
  const s = (input ?? 'unknown').trim();

  return s ? s.slice(0, 160) : 'unknown';
}

function normalizeUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
}

function createUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(8));

  for (const b of bytes) out += alphabet[b % alphabet.length];

  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
