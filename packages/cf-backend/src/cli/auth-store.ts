// The CLI device-authorization flow: a terminal asks for a code, a signed-in
// browser approves it, the terminal polls until a token comes back.
//
// Every record here is short-lived by construction — a request is dead ten
// minutes after it is created, whatever happens to it — so all of it lives in
// KV under its own expiry and there is no sweep to run. The one durable thing
// the flow produces, the CLI token, is minted by and stored in the user's own
// Durable Object.

import type { AuthIdentity } from '../auth/session';
import type { UserDO } from '../user/user-do';
import { randomToken, sha256Hex } from '../lib/crypto';
import { readKvJson, writeKvJson, type KvStore } from '../lib/kv';
import { renderThrownChain } from '@kinu.run/core/obs';
import { parseAccessTokenUserId, type AccessTokenScope } from './access-token-store';
import { ownerCaller, type OwnerCapabilityEnv } from '../user/workspace-capability';
import * as v from 'valibot';

/** Thrown when a CLI auth rate limit trips — routes map this (and only
 *  this) to HTTP 429; every other failure is a real error. */
export class RateLimitError extends Error {
  constructor() {
    super('Too many CLI auth attempts. Try again later.');
    this.name = 'RateLimitError';
  }
}

/** `UserDO.mintCliToken`'s refusal when an approval has already been redeemed.
 *  Matched rather than typed because it crosses a Durable Object RPC boundary,
 *  where an error class does not survive and the message is the contract. */
const AUTHORIZATION_SPENT = /already been redeemed/i;

/** Caller-correctable auth-code failure (unknown / expired / already used)
 *  — routes map this to HTTP 400. Infra failures stay plain errors (500). */
export class CliAuthCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliAuthCodeError';
  }
}

const AUTH_TTL_MS = 10 * 60 * 1000;
/** How long a finished request stays readable past its deadline, so a late
 *  poll is told "already delivered" instead of "unknown request". */
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

/** `expired` is never stored: a request's deadline is in the record and its key
 *  is gone soon after, so expiry is read off `expiresAt` rather than written. */
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

type CliAuthEnv = OwnerCapabilityEnv & {
  AUTH_KV: KvStore;
  UserDO: DurableObjectNamespace<UserDO>;
};

export interface CliTokenIdentity {
  userId: string;
  email: string;
  displayName: string | null;
  tokenHash: string;
  /** `session` = interactive `ptc_…` token from browser approval (unscoped);
   *  `access` = long-lived `pta_…` CI token restricted to `scopes`. */
  kind: 'session' | 'access';
  scopes: 'all' | AccessTokenScope[];
  userDO: DurableObjectStub<UserDO>;
}

export function tokenAllows(identity: Pick<CliTokenIdentity, 'scopes'>, scope: AccessTokenScope): boolean {
  return identity.scopes === 'all' || identity.scopes.includes(scope);
}

export type CliTokenAuth =
  | { ok: true; identity: CliTokenIdentity }
  | { ok: false; error: string };

export function readBearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

/** Parse the userId embedded in a `ptc_…` CLI token. The format's single
 *  home, kept in sync with UserDO.mintCliToken (which imports this module's
 *  parser for verification). This module stays free of `cloudflare:workers`
 *  imports so unit tests can load it under plain bun. */
export function parseCliTokenUserId(token: string): string | null {
  const match = /^ptc_([a-f0-9]{32})_[A-Za-z0-9_-]{24,}$/.exec(token);
  return match?.[1] ?? null;
}

/** Authenticate a CLI bearer token from the Authorization header — either an
 *  interactive `ptc_…` session token or a scoped `pta_…` access token. Routes
 *  to the UserDO embedded in the token, verifies the stored hash. Shared by
 *  the CLI HTTP API and the MCP server (external MCP clients can't do browser
 *  OAuth; the CLI token is their per-user credential). */
export async function authenticateCliToken(
  request: Request,
  env: Pick<CliAuthEnv, 'UserDO' | 'CREDENTIAL_ENCRYPTION_KEY'>,
): Promise<CliTokenAuth> {
  const token = readBearer(request);
  if (!token) return { ok: false, error: 'Missing Authorization: Bearer <token>' };
  const sessionUserId = parseCliTokenUserId(token);
  const accessUserId = sessionUserId ? null : parseAccessTokenUserId(token);
  const userId = sessionUserId ?? accessUserId;
  if (!userId) return { ok: false, error: 'Malformed CLI token' };
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
  const verified = sessionUserId
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
      kind: sessionUserId ? 'session' : 'access',
      scopes: sessionUserId ? 'all' : verified.scopes ?? [],
      userDO,
    },
  };
}

export async function startCliAuth(
  env: CliAuthEnv,
  origin: string,
  approvalOrigin: string,
  deviceName?: string,
  clientKey?: string,
): Promise<CliAuthStartResult> {
  const now = Date.now();
  await rateLimit(env.AUTH_KV, `start:${cleanRateKey(clientKey)}`, 20, RATE_WINDOW_MS, now);

  const expiresAt = now + AUTH_TTL_MS;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const deviceToken = randomToken(32);
    const userCode = createUserCode();
    // A code is one in 32^8, so this reads to prove the claim rather than to
    // expect a clash; KV has no unique key to lean on instead.
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
    // Record before pointer: a pointer is what the browser resolves, and one
    // that outran its record would read as an unknown code either way.
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

export async function pollCliAuth(env: CliAuthEnv, deviceToken: string, clientKey?: string): Promise<CliAuthPollResult> {
  const now = Date.now();
  await rateLimit(env.AUTH_KV, `poll-ip:${cleanRateKey(clientKey)}`, 300, RATE_WINDOW_MS, now);

  const hash = await sha256Hex(deviceToken);
  await rateLimit(env.AUTH_KV, `poll-device:${hash}`, 180, RATE_WINDOW_MS, now);

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

  // KV IS THE TRANSPORT, NOT THE GATE. Marking the record consumed here is
  // still worth doing — it is what a later poll of the same request reads back
  // and what the approval page shows — but it cannot be the one-time check: KV
  // has no compare-and-swap and serves reads from each colo's cache, so two
  // polls of one approved request can both arrive here having read `approved`.
  // The claim that actually holds is the mint's own, in the Durable Object that
  // owns CLI tokens, keyed by this request's device hash.
  await writeKvJson(
    env.AUTH_KV, deviceKey(hash), { ...record, status: 'consumed' }, record.expiresAt + RETENTION_MS,
  );

  // SAFETY: Env.UserDO is generated from the UserDO binding, whose stubs implement UserDO RPC methods.
  const userDO = env.UserDO.get(env.UserDO.idFromName(record.userId)) as DurableObjectStub<UserDO>;
  let minted: { token: string; expiresAt: number };
  try {
    minted = await userDO.mintCliToken(await ownerCaller(env), record.userId, hash, record.deviceName);
  } catch (cause) {
    // The DO refused a second redemption of this approval. Error classes do not
    // survive the RPC boundary, so the message is the contract — the same
    // reading `workspace-create.ts` does of `claimOwner`'s refusal.
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

export async function approveCliAuth(
  env: CliAuthEnv,
  userCode: string,
  identity: AuthIdentity,
  clientKey?: string,
): Promise<{ ok: true; status: 'approved'; user: { id: string; email: string } }> {
  const now = Date.now();
  await rateLimit(env.AUTH_KV, `approve:${identity.userId}:${cleanRateKey(clientKey)}`, 30, RATE_WINDOW_MS, now);

  const found = await readByUserCode(env.AUTH_KV, userCode);
  if (!found) throw new CliAuthCodeError('Unknown CLI auth code.');
  const { deviceHash, record } = found;

  const status = currentStatus(record, now);
  if (status === 'approved' || status === 'consumed') {
    // Idempotent replay only for the original approver. Anyone else
    // presenting an already-approved code must not learn whose it is.
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

  // SAFETY: Env.UserDO is generated from the UserDO binding, whose stubs implement UserDO RPC methods.
  const userDO = env.UserDO.get(env.UserDO.idFromName(identity.userId)) as DurableObjectStub<UserDO>;
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

/** Abuse ceiling per client key and window.
 *
 *  KV serves reads from the colo's own cache, so a burst spread across colos
 *  can see a stale count and this ceiling is per-region rather than exact.
 *  That is the right shape for what it defends: flooding pending requests and
 *  hammering the approve endpoint, neither of which the exactness would
 *  change — a user code is one in 32^8 and cannot be guessed inside a window
 *  at any rate. */
async function rateLimit(
  kv: KvStore, key: string, limit: number, windowMs: number, now: number,
): Promise<void> {
  const bucketKey = `cli-auth-rate:${key}`;
  const bucket = await readKvJson(kv, bucketKey, RateBucketSchema);
  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs;
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
