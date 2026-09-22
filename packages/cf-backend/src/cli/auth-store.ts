// CLI device-authorization flow. Every record is short-lived and lives in KV under its own expiry
// (no sweep); the durable CLI token is minted and stored in the user's own DO.

import type { AuthIdentity } from '../auth/session';
import type { UserDO } from '../user/user-do';
import type { ObjectNamespace } from '@kinu.run/core';
import { randomToken, sha256Hex } from '@kinu.run/core';
import { readKvJson, writeKvJson, type KvStore } from '@kinu.run/agent-utils';
import { renderThrownChain } from '@kinu.run/core/obs';
import { parseAccessTokenUserId, type AccessTokenScope } from '@kinu.run/core';
import { ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import * as v from 'valibot';

/** Routes map this (and only this) to HTTP 429. */
export class RateLimitError extends Error {
  constructor() {
    super('Too many CLI auth attempts. Try again later.');
    this.name = 'RateLimitError';
  }
}

/** Matched by message: error classes do not survive a DO RPC boundary. */
const AUTHORIZATION_SPENT = /already been redeemed/i;

/** Caller-correctable (unknown / expired / already used) → 400; infra failures stay plain errors (500). */
export class CliAuthCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliAuthCodeError';
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
const CliAuthRecordSchema = v.object({
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

type CliAuthRecord = v.InferOutput<typeof CliAuthRecordSchema>;

const CodePointerSchema = v.object({ deviceHash: v.string() });

const RateBucketSchema = v.object({ count: v.number(), resetAt: v.number() });

export type CliAuthAuthority = Pick<
  UserDO, 'ensureProfile' | 'mintCliToken' | 'verifyCliToken' | 'verifyAccessToken'
>;

export type CliAuthEnv<Id = DurableObjectId> = OwnerCapabilityEnv & {
  AUTH_KV: KvStore;
  UserDO: ObjectNamespace<Id, CliAuthAuthority>;
};

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

export type CliTokenAuth<Authority = DurableObjectStub<UserDO>> =
  | { ok: true; identity: CliTokenIdentity<Authority> }
  | { ok: false; error: string };

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

  if (!token) return { ok: false, error: 'Missing Authorization: Bearer <token>' };
  const bearer = parseCliBearer(token);

  if (!bearer) return { ok: false, error: 'Malformed CLI token' };
  const userDO = env.UserDO.get(env.UserDO.idFromName(bearer.userId));

  const verified = bearer.kind === 'session'
    ? await userDO.verifyCliToken(await ownerCaller(env), token)
    : await userDO.verifyAccessToken(await ownerCaller(env), token);

  if (!verified.ok || !verified.user || !verified.tokenHash) {
    return { ok: false, error: verified.error ?? 'Invalid CLI token' };
  }

  return {
    ok: true,
    identity: {
      userId: verified.user.id,
      email: verified.user.email,
      displayName: verified.user.displayName,
      tokenHash: verified.tokenHash,
      kind: bearer.kind,
      scopes: bearer.kind === 'session' ? 'all' : verified.scopes ?? [],
      userDO,
    },
  };
}

export interface CliAuthRequest {
  origin: string;
  approvalOrigin: string;
  deviceName?: string;
  clientKey?: string;
}

export async function startCliAuth<Id>(env: CliAuthEnv<Id>, request: CliAuthRequest): Promise<CliAuthStartResult> {
  const { origin, approvalOrigin, deviceName, clientKey } = request;
  const now = Date.now();
  await rateLimit(env.AUTH_KV, `start:${cleanRateKey(clientKey)}`, 20, now);

  const expiresAt = now + AUTH_TTL_MS;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const deviceToken = randomToken(32);
    const userCode = createUserCode();

    // Reads to prove the claim; KV has no unique key to lean on.
    if (await readKvJson(env.AUTH_KV, codeKey(userCode), CodePointerSchema) !== null) continue;

    const deviceHash = await sha256Hex(deviceToken);

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

    // Record before pointer: a pointer that outran its record reads as an unknown code.
    await writeKvJson(env.AUTH_KV, deviceKey(deviceHash), record, expiresAt + RETENTION_MS);
    await writeKvJson(env.AUTH_KV, codeKey(userCode), { deviceHash }, expiresAt + RETENTION_MS);

    return {
      deviceToken,
      userCode,
      verificationUrl: `${cleanOrigin(approvalOrigin)}/cli/auth?code=${encodeURIComponent(userCode)}`,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }

  throw new Error('Could not allocate a CLI auth code.');
}

export async function inspectCliAuth(kv: KvStore, userCode: string): Promise<CliAuthRequestInfo | null> {
  const found = await readByUserCode(kv, userCode);

  if (!found) return null;
  const { record } = found;

  return {
    userCode: record.userCode,
    deviceName: record.deviceName,
    status: currentStatus(record),
    expiresAt: new Date(record.expiresAt).toISOString(),
    approvedAt: record.approvedAt ? new Date(record.approvedAt).toISOString() : undefined,
    user: record.userId && record.userEmail ? { id: record.userId, email: record.userEmail } : undefined,
  };
}

export async function pollCliAuth<Id>(
  env: CliAuthEnv<Id>, deviceToken: string, clientKey?: string,
): Promise<CliAuthPollResult> {
  const now = Date.now();
  await rateLimit(env.AUTH_KV, `poll-ip:${cleanRateKey(clientKey)}`, 300, now);

  const hash = await sha256Hex(deviceToken);
  await rateLimit(env.AUTH_KV, `poll-device:${hash}`, 180, now);

  const record = await readKvJson(env.AUTH_KV, deviceKey(hash), CliAuthRecordSchema);

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

  // KV is the transport, not the gate: no compare-and-swap and per-colo cached reads, so two polls can
  // both read `approved`. The one-time claim is the DO mint's, keyed by the device hash.
  await writeKvJson(
    env.AUTH_KV, deviceKey(hash), { ...record, status: 'consumed' }, record.expiresAt + RETENTION_MS,
  );

  const userDO = env.UserDO.get(env.UserDO.idFromName(record.userId));
  let minted: { token: string; expiresAt: number };

  try {
    minted = await userDO.mintCliToken(await ownerCaller(env), record.userId, hash, record.deviceName);
  } catch (cause) {
    // Error classes do not survive the RPC boundary, so the message is the contract.
    if (!AUTHORIZATION_SPENT.test(renderThrownChain({ cause }))) throw cause;

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
}

export async function approveCliAuth<Id>(
  env: CliAuthEnv<Id>,
  userCode: string,
  identity: AuthIdentity,
  clientKey?: string,
): Promise<{ ok: true; status: 'approved'; user: { id: string; email: string } }> {
  const now = Date.now();
  await rateLimit(env.AUTH_KV, `approve:${identity.userId}:${cleanRateKey(clientKey)}`, 30, now);

  const found = await readByUserCode(env.AUTH_KV, userCode);

  if (!found) throw new CliAuthCodeError('Unknown CLI auth code.');
  const { deviceHash, record } = found;

  const status = currentStatus(record, now);

  if (status === 'approved' || status === 'consumed') {
    // Idempotent replay only for the original approver; others must not learn whose code it is.
    if (record.userId !== identity.userId) {
      throw new CliAuthCodeError('CLI auth code already used.');
    }

    return {
      ok: true,
      status: 'approved',
      user: { id: identity.userId, email: record.userEmail ?? identity.email },
    };
  }

  if (status !== 'pending') {
    throw new CliAuthCodeError('CLI auth code expired. Run kinu auth again.');
  }

  const userDO = env.UserDO.get(env.UserDO.idFromName(identity.userId));
  await userDO.ensureProfile(await ownerCaller(env), identity.email);
  await writeKvJson(env.AUTH_KV, deviceKey(deviceHash), {
    ...record,
    status: 'approved',
    userId: identity.userId,
    userEmail: identity.email,
    approvedAt: now,
  }, record.expiresAt + RETENTION_MS);

  return { ok: true, status: 'approved', user: { id: identity.userId, email: identity.email } };
}

/** Abuse ceiling per client key and window; per-region, not exact, since KV reads are colo-cached. */
async function rateLimit(kv: KvStore, key: string, limit: number, now: number): Promise<void> {
  const bucketKey = `cli-auth-rate:${key}`;
  const bucket = await readKvJson(kv, bucketKey, RateBucketSchema);

  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + RATE_WINDOW_MS;
    await writeKvJson(kv, bucketKey, { count: 1, resetAt }, resetAt);

    return;
  }

  if (bucket.count >= limit) throw new RateLimitError();
  await writeKvJson(kv, bucketKey, { count: bucket.count + 1, resetAt: bucket.resetAt }, bucket.resetAt);
}

async function readByUserCode(
  kv: KvStore, userCode: string,
): Promise<{ deviceHash: string; record: CliAuthRecord } | null> {
  const pointer = await readKvJson(kv, codeKey(normalizeUserCode(userCode)), CodePointerSchema);

  if (!pointer) return null;
  const record = await readKvJson(kv, deviceKey(pointer.deviceHash), CliAuthRecordSchema);

  if (!record) return null;

  return { deviceHash: pointer.deviceHash, record };
}

function deviceKey(deviceHash: string): string {
  return `cli-auth:device:${deviceHash}`;
}

function codeKey(userCode: string): string {
  return `cli-auth:code:${userCode}`;
}

function currentStatus(record: CliAuthRecord, now = Date.now()): CliAuthRequestInfo['status'] {
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
