// Browser auth state: the OAuth handoff and browser sessions.
//
// The handoff record in KV holds the hash of a browser binding cookie; both are burned by the callback,
// so a callback URL is worthless away from the browser that started sign-in (login CSRF).
// Session liveness is decided only by the row in the user's Durable Object: KV propagates across colos
// slowly, so it can say neither that a session was revoked nor that it exists. KV carries a projection
// of the identity only. A request that cannot reach the authority is refused.
// The userId is derived from the verified email (`deriveUserId`), so the email is the account and an
// unverified address is not an identity.

import type { AuthIdentity } from './session';
import type { OAuthProviderId } from './providers';
import type { BrowserSessionIdentity, LiveBrowserSession, UserDO } from '../user/user-do';
import type { ObjectNamespace } from '@kinu.run/core';
import { randomToken, sha256Hex } from '@kinu.run/core';
import { readKvJson, writeKvJson, type KvStore } from '@kinu.run/agent-utils';
import { ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import { timingSafeEqual } from '@kinu.run/core';
import { classify, diagnostics, toKinuError, type KinuError } from '@kinu.run/core/obs';
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

/** Provider echoes `state`; the browser carries `binding` in a cookie. Both are needed to spend the
 *  record; minted together so no handoff is bound to nothing. */
export interface OAuthHandoff {
  state: string;
  binding: string;
  expiresAt: number;
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

/** A projection of the class, so a stand-in keeps the object's real contract. */
export type SessionAuthority = Pick<
  UserDO, 'ensureProfile' | 'registerBrowserSession' | 'verifyBrowserSession' | 'revokeBrowserSession'
>;

export interface AuthStoreEnv<Id = DurableObjectId> extends OwnerCapabilityEnv {
  AUTH_KV: KvStore;
  UserDO: ObjectNamespace<Id, SessionAuthority>;
}

const OAuthStateSchema = v.object({
  provider: v.string(),
  codeVerifier: v.string(),
  nonce: v.nullable(v.string()),
  returnTo: v.string(),
  redirectUri: v.string(),
  /** SHA-256 of the binding; the record never holds the binding itself. */
  bindingHash: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
});

export type OAuthStateRecord = v.InferOutput<typeof OAuthStateSchema>;

/** KV projection of a session row, written from the row's value. `userId` is read from the token,
 *  never this record, on the verify path. */
const SessionSchema = v.object({
  userId: v.string(),
  email: v.string(),
  displayName: v.nullable(v.string()),
  provider: v.string(),
  sub: v.string(),
  authTime: v.number(),
  expiresAt: v.number(),
});

/** Truncated sha256 in the shape every userId-carrying format (UserDO name, `ptc_…` token) expects;
 *  the one derivation for dev and real sign-in. */
export async function deriveUserId(email: string): Promise<string> {
  return (await sha256Hex(email.trim().toLowerCase())).slice(0, 32);
}

export async function createOAuthState(
  kv: KvStore,
  input: OAuthStateInput,
): Promise<OAuthHandoff> {
  const now = Date.now();
  const state = randomToken(32);
  const binding = randomToken(32);
  const expiresAt = now + OAUTH_STATE_TTL_MS;

  const record: OAuthStateRecord = {
    provider: input.provider,
    codeVerifier: input.codeVerifier,
    nonce: input.nonce ?? null,
    returnTo: sanitizeReturnTo(input.returnTo),
    redirectUri: input.redirectUri,
    bindingHash: await sha256Hex(binding),
    createdAt: now,
    expiresAt,
  };

  await writeKvJson(kv, `oauth-state:${await sha256Hex(state)}`, record, expiresAt);

  return { state, binding, expiresAt };
}

/** Deleted before it is judged, so a concurrent second callback finds nothing. A callback whose
 *  `binding` cookie is missing or wrong is refused before anything in the record is acted on. */
export async function consumeOAuthState(
  kv: KvStore,
  state: string,
  provider: OAuthProviderId,
  binding: string | null,
): Promise<OAuthStateRecord> {
  const key = `oauth-state:${await sha256Hex(state)}`;
  const record = await readKvJson(kv, key, OAuthStateSchema);
  await kv.delete(key);

  if (!record) throw new Error('OAuth state is invalid or already used.');

  if (!binding || !timingSafeEqual(await sha256Hex(binding), record.bindingHash)) {
    throw new Error('OAuth state was not issued to this browser. Start sign-in again.');
  }

  if (record.provider !== provider) throw new Error('OAuth state provider mismatch.');

  if (record.expiresAt <= Date.now()) throw new Error('OAuth state expired. Start sign-in again.');

  return { ...record, returnTo: sanitizeReturnTo(record.returnTo) };
}

/** The id is in the token, not KV, so logout always reaches the authority even before KV propagates. */
function parseSessionTokenUserId(token: string): string | null {
  const match = /^ps_([a-f0-9]{32})_[A-Za-z0-9_-]{64,}$/.exec(token);

  return match?.[1] ?? null;
}

export async function createSession<Id>(env: AuthStoreEnv<Id>, profile: OAuthProfile): Promise<BrowserSession> {
  const now = Date.now();
  const identity = await resolveIdentity(env, profile, now);
  const token = `ps_${identity.userId}_${randomToken(48)}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;
  const caller = await ownerCaller(env);
  const authority = sessionAuthority(env, identity.userId);

  // One value for both stores so they cannot disagree about what this cookie stands for.
  const minted: BrowserSessionIdentity = {
    email: identity.email,
    displayName: identity.displayName ?? null,
    provider: identity.provider ?? profile.provider,
    sub: identity.sub,
    authTime: now,
  };

  // Authority first: a cookie is never outstanding against a session nothing can revoke.
  await authority.registerBrowserSession(caller, tokenHash, expiresAt, minted);

  try {
    await writeKvJson(env.AUTH_KV, sessionKey(tokenHash), {
      userId: identity.userId,
      ...minted,
      expiresAt,
    }, expiresAt);
  } catch (writeFailed) {
    // This token is never returned; withdraw the row rather than leave it holding a slot.
    try {
      await authority.revokeBrowserSession(caller, tokenHash);
    } catch (withdrawFailed) {
      diagnostics.failure('auth.browser_session_row_stranded', toKinuError({
        doing: 'withdrawing the session row a failed sign-in left behind',
        cause: withdrawFailed,
        otherwise: 'unavailable',
      }));
    }

    throw new SessionAuthorityUnavailableError({ cause: writeFailed });
  }

  return { token, expiresAt, identity };
}

/** A session that cannot be checked is not an invalid one: answering 401 during an outage would sign
 *  everyone out into a sign-in that also fails. Raised only at the store boundaries. */
export class SessionAuthorityUnavailableError extends Error {
  constructor(options: { cause: unknown }) {
    super(
      'Kinu cannot reach the store that holds your sign-in right now. Try again shortly.',
      { cause: options.cause },
    );
    this.name = 'SessionAuthorityUnavailableError';
  }
}

/** Null when not signed in; throws {@link SessionAuthorityUnavailableError} when the answer cannot be
 *  obtained. Liveness is the authority row on every request; identity comes from the KV projection,
 *  or the row when KV has not caught up. Revocation deletes the row, so neither copy can revive it. */
export async function verifySession<Id>(env: AuthStoreEnv<Id>, token: string): Promise<AuthIdentity | null> {
  const userId = parseSessionTokenUserId(token);

  if (!userId) return null;
  const tokenHash = await sha256Hex(token);
  let record: v.InferOutput<typeof SessionSchema> | null;

  try {
    record = await readKvJson(env.AUTH_KV, sessionKey(tokenHash), SessionSchema);
  } catch (unreadable) {
    // Told apart by the decoder's error type, never prose. An unreachable namespace is an outage;
    // undecodable bytes are cleaned out and answered as signed out (a 503 would trap the browser).
    if (!isMalformedRecord({ cause: unreadable })) {
      throw new SessionAuthorityUnavailableError({ cause: unreadable });
    }

    await discardCorruptSession(env, userId, tokenHash, toKinuError({
      doing: 'decoding the browser session record this cookie names',
      cause: unreadable,
      otherwise: 'bad_input',
    }));

    return null;
  }

  // kv.ts floors TTLs, so a record can outlive its deadline; this only picks which identity copy to read.
  const projected = record && record.expiresAt > Date.now() ? record : null;

  // Outside the try: a missing owner secret is a misconfiguration, not an unreachable DO.
  const caller = await ownerCaller(env);
  let live: LiveBrowserSession | null;

  try {
    live = await sessionAuthority(env, userId).verifyBrowserSession(caller, tokenHash);
  } catch (unreachable) {
    throw new SessionAuthorityUnavailableError({ cause: unreachable });
  }

  if (!live) return null;

  // Row fallback serves the first request after sign-in at a colo KV has not reached. `identity` is
  // null only on rows registered before the row carried one.
  const snapshot = projected ?? live.identity;

  if (!snapshot) return null;

  // Annotated, not inferred, so the field-supply census sees the one site connecting `sessionTokenHash`.
  const identity: AuthIdentity = {
    // From the token, never a record, so no stored field can point a cookie at another user.
    userId,
    email: snapshot.email,
    sub: snapshot.sub,
    provider: snapshot.provider,
    displayName: snapshot.displayName,
    authTime: snapshot.authTime,
    // Lets a later logout reach websockets tagged with this session.
    sessionTokenHash: tokenHash,
  };

  return identity;
}

/** Decided by type, never by matching an error's prose. */
function isMalformedRecord(failure: { cause: unknown }): boolean {
  return failure.cause instanceof v.ValiError || classify(failure) === 'malformed-input';
}

/**
 * Reported once, then cleared from the row (first) and KV. Failures are recorded, never raised: turning
 * cleanup into an outage would trap the browser behind a cookie it cannot replace.
 */
async function discardCorruptSession<Id>(
  env: AuthStoreEnv<Id>,
  userId: string,
  tokenHash: string,
  fault: KinuError,
): Promise<void> {
  diagnostics.failure('auth.browser_session_record_malformed', fault);

  try {
    await sessionAuthority(env, userId).revokeBrowserSession(await ownerCaller(env), tokenHash);
  } catch (rowFailed) {
    diagnostics.failure('auth.browser_session_row_left', toKinuError({
      doing: 'revoking the session row of a record that no longer decodes',
      cause: rowFailed,
      otherwise: 'unavailable',
    }));
  }

  try {
    await env.AUTH_KV.delete(sessionKey(tokenHash));
  } catch (recordFailed) {
    diagnostics.failure('auth.browser_session_record_left', toKinuError({
      doing: 'removing a browser session record that no longer decodes',
      cause: recordFailed,
      otherwise: 'unavailable',
    }));
  }
}

/** Deletes the authority row first so the cookie is refused at every colo; throws if that fails.
 *  The KV delete after is cleanup: recorded on failure, never raised. */
export async function revokeSession<Id>(env: AuthStoreEnv<Id>, token: string): Promise<void> {
  const userId = parseSessionTokenUserId(token);

  if (!userId) return;
  const tokenHash = await sha256Hex(token);
  const caller = await ownerCaller(env);
  await sessionAuthority(env, userId).revokeBrowserSession(caller, tokenHash);

  try {
    await env.AUTH_KV.delete(sessionKey(tokenHash));
  } catch (cleanupFailed) {
    diagnostics.failure('auth.browser_session_record_left', toKinuError({
      doing: 'removing the KV record of a session that is already revoked',
      cause: cleanupFailed,
      otherwise: 'unavailable',
    }));
  }
}

function sessionKey(tokenHash: string): string {
  return `session:${tokenHash}`;
}

/** The one authority on which of a user's sessions are live. */
function sessionAuthority<Id>(env: AuthStoreEnv<Id>, userId: string): SessionAuthority {
  return env.UserDO.get(env.UserDO.idFromName(userId));
}

async function resolveIdentity<Id>(env: AuthStoreEnv<Id>, profile: OAuthProfile, now: number): Promise<AuthIdentity> {
  const email = profile.email.trim().toLowerCase();

  if (!email) throw new Error('OAuth provider did not return an email address.');

  if (!profile.providerSub) throw new Error('OAuth provider did not return a stable subject.');

  if (!profile.emailVerified) {
    throw new Error('OAuth provider did not report this email address as verified.');
  }

  const userId = await deriveUserId(email);

  const stored = await sessionAuthority(env, userId)
    .ensureProfile(await ownerCaller(env), email, profile.displayName ?? undefined);

  return {
    userId,
    email,
    sub: profile.providerSub,
    provider: profile.provider,
    displayName: profile.displayName ?? stored.displayName,
    authTime: now,
  };
}

/** Relative paths only: no protocol-relative or backslash tricks, never back into the auth flow. */
export function sanitizeReturnTo(input: string): string {
  const raw = input.trim();

  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';

  if (raw.startsWith('/auth/') || raw === '/login' || raw === '/logout') return '/';

  return raw;
}
