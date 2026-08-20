// Browser auth state: one-time OAuth handoff state and browser sessions.
//
// Both are expiring, edge-read, single-owner records, so both live in KV and
// nothing else does. A session is verified on EVERY authenticated request from
// wherever the browser is, which is what KV is for — a cached read at the colo
// serving the request — and its lifetime is a TTL the store enforces itself, so
// there is no expiry sweep to run and no revoked-row bookkeeping.
//
// The durable half of an identity is not here. It lives in the user's own
// Durable Object, addressed by a userId DERIVED from the verified email
// (`deriveUserId`), so there is no account index to keep, no first-login race
// to lose, and nothing in KV that cannot be rebuilt by signing in again. The
// email is therefore the account: two providers reporting the same verified
// address are the same Kinu user, and an unverified address is not an
// identity at all — it would let one provider's unchecked claim address
// another person's Durable Object.

import type { AuthIdentity } from './session';
import type { OAuthProviderId } from './providers';
import type { UserDO } from '../user/user-do';
import { randomToken, sha256Hex } from '../lib/crypto';
import { readKvJson, writeKvJson, type KvStore } from '../lib/kv';
import { ownerCaller, type OwnerCapabilityEnv } from '../user/workspace-capability';
import * as v from 'valibot';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface OAuthStateInput {
  provider: OAuthProviderId;
  codeVerifier: string;
  nonce?: string | null;
  returnTo: string;
  redirectUri: string;
}

export interface OAuthProfile {
  provider: OAuthProviderId;
  providerSub: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
}

export interface BrowserSession {
  token: string;
  expiresAt: number;
  identity: AuthIdentity;
}

export interface AuthStoreEnv extends OwnerCapabilityEnv {
  AUTH_KV: KvStore;
  UserDO: DurableObjectNamespace<UserDO>;
}

const OAuthStateSchema = v.object({
  provider: v.string(),
  codeVerifier: v.string(),
  nonce: v.nullable(v.string()),
  returnTo: v.string(),
  redirectUri: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
});
export type OAuthStateRecord = v.InferOutput<typeof OAuthStateSchema>;

const SessionSchema = v.object({
  userId: v.string(),
  email: v.string(),
  displayName: v.nullable(v.string()),
  provider: v.string(),
  sub: v.string(),
  authTime: v.number(),
  expiresAt: v.number(),
});

/** Stable Kinu user id for a verified email: sha256 truncated to the 32 hex
 *  chars every userId-carrying format (UserDO name, `ptc_…` CLI token) expects.
 *  The one derivation for both the dev identity and a real sign-in. */
export async function deriveUserId(email: string): Promise<string> {
  return (await sha256Hex(email.trim().toLowerCase())).slice(0, 32);
}

export async function createOAuthState(
  kv: KvStore,
  input: OAuthStateInput,
): Promise<{ state: string; expiresAt: number }> {
  const now = Date.now();
  const state = randomToken(32);
  const expiresAt = now + OAUTH_STATE_TTL_MS;
  const record: OAuthStateRecord = {
    provider: input.provider,
    codeVerifier: input.codeVerifier,
    nonce: input.nonce ?? null,
    returnTo: sanitizeReturnTo(input.returnTo),
    redirectUri: input.redirectUri,
    createdAt: now,
    expiresAt,
  };
  await writeKvJson(kv, `oauth-state:${await sha256Hex(state)}`, record, expiresAt);
  return { state, expiresAt };
}

/** Read and burn the state a `/auth/<provider>/start` redirect handed out.
 *  Deleted before it is judged, so a second callback carrying the same state
 *  finds nothing even if it is already in flight. */
export async function consumeOAuthState(
  kv: KvStore,
  state: string,
  provider: OAuthProviderId,
): Promise<OAuthStateRecord> {
  const key = `oauth-state:${await sha256Hex(state)}`;
  const record = await readKvJson(kv, key, OAuthStateSchema);
  await kv.delete(key);

  if (!record) throw new Error('OAuth state is invalid or already used.');
  if (record.provider !== provider) throw new Error('OAuth state provider mismatch.');
  if (record.expiresAt <= Date.now()) throw new Error('OAuth state expired. Start sign-in again.');

  return { ...record, returnTo: sanitizeReturnTo(record.returnTo) };
}

export async function createSession(env: AuthStoreEnv, profile: OAuthProfile): Promise<BrowserSession> {
  const now = Date.now();
  const identity = await resolveIdentity(env, profile, now);
  const token = `ps_${randomToken(48)}`;
  const expiresAt = now + SESSION_TTL_MS;

  await writeKvJson(env.AUTH_KV, `session:${await sha256Hex(token)}`, {
    userId: identity.userId,
    email: identity.email,
    displayName: identity.displayName ?? null,
    provider: identity.provider ?? profile.provider,
    sub: identity.sub,
    authTime: now,
    expiresAt,
  }, expiresAt);

  return { token, expiresAt, identity };
}

/** The identity a session cookie stands for, or null when the token is not one.
 *
 *  The record is the identity as it stood at sign-in: email and display name
 *  are snapshotted here rather than read from the user's Durable Object,
 *  because this runs on every authenticated request and a DO round trip per
 *  request is not a thing to pay for a name. A rename lands on next sign-in. */
export async function verifySession(kv: KvStore, token: string): Promise<AuthIdentity | null> {
  if (!token.startsWith('ps_') || token.length < 48) return null;
  const record = await readKvJson(kv, `session:${await sha256Hex(token)}`, SessionSchema);
  if (!record || record.expiresAt <= Date.now()) return null;
  return {
    userId: record.userId,
    email: record.email,
    sub: record.sub,
    provider: record.provider,
    displayName: record.displayName,
    authTime: record.authTime,
  };
}

/** Drop a session. The delete reaches other colos within a minute, so a cookie
 *  copied off this browser can outlive logout by that much; the browser's own
 *  cookie is cleared in the same response. */
export async function revokeSession(kv: KvStore, token: string): Promise<void> {
  if (!token.startsWith('ps_')) return;
  await kv.delete(`session:${await sha256Hex(token)}`);
}

async function resolveIdentity(env: AuthStoreEnv, profile: OAuthProfile, now: number): Promise<AuthIdentity> {
  const email = profile.email.trim().toLowerCase();
  if (!email) throw new Error('OAuth provider did not return an email address.');
  if (!profile.providerSub) throw new Error('OAuth provider did not return a stable subject.');
  if (!profile.emailVerified) {
    throw new Error('OAuth provider did not report this email address as verified.');
  }

  const userId = await deriveUserId(email);
  // SAFETY: The UserDO namespace binding declares UserDO as its stub contract.
  const userDO = env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  const stored = await userDO.ensureProfile(await ownerCaller(env), email, profile.displayName ?? undefined);

  return {
    userId,
    email,
    sub: profile.providerSub,
    provider: profile.provider,
    displayName: profile.displayName ?? stored.displayName,
    authTime: now,
  };
}

/** Single source of truth for post-login redirect sanitization: relative
 *  paths only, no protocol-relative or backslash tricks, and never back
 *  into the auth flow itself. */
export function sanitizeReturnTo(input: string): string {
  const raw = input.trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  if (raw.startsWith('/auth/') || raw === '/login' || raw === '/logout') return '/';
  return raw;
}
