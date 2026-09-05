// Browser auth state: the OAuth handoff, and browser sessions.
//
// The handoff is one-time, short-lived, and half of it is in the browser. KV
// holds the record a callback spends; the browser holds a random binding
// cookie whose HASH is in that record. Both halves are burned by the callback
// that spends them, so a callback URL is worth nothing away from the browser
// that started the sign-in. Without that half, the URL is bearer authority:
// an attacker completes a sign-in in their own browser, hands the resulting
// `?code=&state=` link to a victim, and the victim's browser comes back
// holding the attacker's session.
//
// A session is not one-time. What it stands for is written ONCE, at sign-in,
// into a row in the user's own Durable Object — the email, provider, subject
// and auth time the cookie has meant ever since — and that same row is the
// only thing that says the session is still live. KV carries a projection of
// those fields, and only a projection: a KV delete reaches other colos within
// a minute, so KV cannot say a session was REVOKED (a cookie copied off the
// browser and replayed at a lagging colo outlived logout by exactly that
// window), and a KV write is no faster, so KV cannot say a session EXISTS
// either (the first request after a sign-in redirect, at a colo the write had
// not reached, read as signed out and sent the browser back into a sign-in
// that would lose the same race). Every verification reads the row, and the
// token carries the user id that addresses it — so neither verification nor
// logout depends on a cached read to find the authority. There is no
// remembered verdict and no KV-only pass: a request that cannot reach the
// authority is refused.
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
import type { BrowserSessionIdentity, LiveBrowserSession, UserDO } from '../user/user-do';
import { randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { readKvJson, writeKvJson, type KvStore } from '../lib/kv';
import { ownerCaller, type OwnerCapabilityEnv } from '../user/workspace-capability';
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

/** A started sign-in. The provider echoes `state` back; the browser carries
 *  `binding` in its own cookie. Both are needed to spend the record, and
 *  neither is derivable from the other. Minted together here so no caller can
 *  start a handoff that is bound to nothing. */
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
  /** SHA-256 of the binding the initiating browser was handed. The record
   *  never holds the binding itself, exactly as it never holds the state. */
  bindingHash: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
});
export type OAuthStateRecord = v.InferOutput<typeof OAuthStateSchema>;

/** The projection of a session row that KV carries. Written from the row's own
 *  value, so every field but the last two is the row's; `userId` is written so
 *  a record is self-describing to whoever reads the namespace, and read from
 *  the TOKEN on the verify path, where the addressed object is the authority
 *  for it. */
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

/** Read and burn the state a `/auth/<provider>/start` redirect handed out.
 *  Deleted before it is judged, so a second callback carrying the same state
 *  finds nothing even if it is already in flight — and the binding is spent
 *  with it, because the only copy of its hash was in the record.
 *
 *  `binding` is what the handoff cookie carried on THIS callback. A callback
 *  that presents none, or one from another browser, is refused before
 *  anything in the record is acted on: the record names the provider, the
 *  PKCE verifier and the place to land, and none of that is owed to a browser
 *  that did not start the sign-in. */
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

/** The user id a session token routes to, or null when the token is not one.
 *  The id is IN the token, not read from KV, so logout can always reach the
 *  authority that revokes the session, including inside the minute a fresh
 *  sign-in's KV record needs to reach every colo. */
function parseSessionTokenUserId(token: string): string | null {
  const match = /^ps_([a-f0-9]{32})_[A-Za-z0-9_-]{64,}$/.exec(token);
  return match?.[1] ?? null;
}

export async function createSession(env: AuthStoreEnv, profile: OAuthProfile): Promise<BrowserSession> {
  const now = Date.now();
  const identity = await resolveIdentity(env, profile, now);
  const token = `ps_${identity.userId}_${randomToken(48)}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;
  const caller = await ownerCaller(env);
  const authority = sessionAuthority(env, identity.userId);
  // ONE value for both stores, so the authority's row and the projection of it
  // cannot come to disagree about what this cookie stands for.
  const minted: BrowserSessionIdentity = {
    email: identity.email,
    displayName: identity.displayName ?? null,
    provider: identity.provider ?? profile.provider,
    sub: identity.sub,
    authTime: now,
  };

  // The authority goes first, so a cookie is never outstanding against a
  // session nothing can revoke.
  await authority.registerBrowserSession(caller, tokenHash, expiresAt, minted);
  try {
    await writeKvJson(env.AUTH_KV, sessionKey(tokenHash), {
      userId: identity.userId,
      ...minted,
      expiresAt,
    }, expiresAt);
  } catch (writeFailed) {
    // This token is never returned, so the row stands for a session nobody can
    // present. Withdraw it rather than leave it holding a slot for a month.
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

/** One of the two stores a session depends on would not answer, so this
 *  request has no answer about the session either.
 *
 *  Its own class because a session that cannot be CHECKED is not a session
 *  that is INVALID: reported as the 401 an expired cookie gets, an outage
 *  would tell every signed-in user their sign-in lapsed and send them into a
 *  sign-in the same outage also fails. Raised at the store boundaries and
 *  nowhere else: what the bytes SAY is judged separately, and a record that is
 *  missing, lapsed or not a session at all is simply not signed in. */
export class SessionAuthorityUnavailableError extends Error {
  constructor(options: { cause: unknown }) {
    super(
      'Kinu cannot reach the store that holds your sign-in right now. Try again shortly.',
      { cause: options.cause },
    );
    this.name = 'SessionAuthorityUnavailableError';
  }
}

/** The identity a session cookie stands for, or null when the token is not one,
 *  is unknown here, has lapsed, or is no longer live. Throws
 *  {@link SessionAuthorityUnavailableError} when the answer cannot be obtained,
 *  which is never the same as "not signed in".
 *
 *  Whether the session still EXISTS is the authority's answer, on every
 *  request, with nothing cached in front of it. The identity is the one written
 *  at sign-in (a rename lands on the next sign-in), read from the KV
 *  projection when that has arrived at this colo and from the authority's own
 *  row when it has not, which is what the first request after a sign-in
 *  redirect can get. Both copies were written from one value, so neither can
 *  contradict the other, and neither can revive a revoked session: revocation
 *  deletes the row, and the row is what is read here. */
export async function verifySession(env: AuthStoreEnv, token: string): Promise<AuthIdentity | null> {
  const userId = parseSessionTokenUserId(token);
  if (!userId) return null;
  const tokenHash = await sha256Hex(token);
  let record: v.InferOutput<typeof SessionSchema> | null;
  try {
    record = await readKvJson(env.AUTH_KV, sessionKey(tokenHash), SessionSchema);
  } catch (unreadable) {
    // Two failures share this await, and they are told apart by the decoder's
    // own error type, never by matching prose. A namespace that will not answer
    // is an outage. Bytes that no longer decode are a record THIS Worker wrote:
    // a real fault, reported and cleaned out of both stores, and still answered
    // as not signed in. A 503 there would trap the browser behind a cookie it
    // cannot replace, because replacing it means reaching an authenticated
    // route that would refuse for the same reason.
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
  // A projection past the deadline it carries is no projection: kv.ts floors a
  // TTL at a minute, so a record can outlive its own deadline by that much.
  // Nothing about lifetime is DECIDED here — the row drops lapsed sessions in
  // the same transaction as the read below — this only picks which copy of the
  // identity is read.
  const projected = record && record.expiresAt > Date.now() ? record : null;

  // The caller is resolved outside the try: a deployment holding no owner
  // secret is a misconfiguration with its own answer, not a Durable Object
  // that cannot be reached.
  const caller = await ownerCaller(env);
  let live: LiveBrowserSession | null;
  try {
    live = await sessionAuthority(env, userId).verifyBrowserSession(caller, tokenHash);
  } catch (unreachable) {
    throw new SessionAuthorityUnavailableError({ cause: unreachable });
  }
  if (!live) return null;

  // The projection normally answers. When it has not reached this colo yet, the
  // row that just answered for liveness carries the same fields, so the first
  // request after a sign-in is served rather than sent back to a sign-in that
  // would only lose the same race. `identity` is null only on a row registered
  // before the row carried one, where the projection is still its only copy.
  const snapshot = projected ?? live.identity;
  if (!snapshot) return null;

  // Annotated, not inferred, so the field-supply census sees the one site
  // that connects `sessionTokenHash` to its readers.
  const identity: AuthIdentity = {
    // From the token, which is the object just consulted — never from a
    // record, so no stored field can point an accepted cookie at another user.
    userId,
    email: snapshot.email,
    sub: snapshot.sub,
    provider: snapshot.provider,
    displayName: snapshot.displayName,
    authTime: snapshot.authTime,
    // The hash this verification was made against, so a downstream websocket can
    // name this session on its connection tags — the handle a later logout
    // needs to reach a socket the cookie no longer gates. From the token for
    // the same reason `userId` is.
    sessionTokenHash: tokenHash,
  };
  return identity;
}

/** Whether a failed read is the record refusing to decode rather than KV
 *  refusing to answer: valibot's own refusal, or bytes that are not JSON.
 *  Decided by type, never by matching an error's prose. */
function isMalformedRecord(failure: { cause: unknown }): boolean {
  return failure.cause instanceof v.ValiError || classify(failure) === 'malformed-input';
}

/**
 * Retire a session whose record no longer decodes.
 *
 * The record is a fault worth naming AND a credential nothing can honour, so it
 * is reported once and then cleared from BOTH stores that hold it: the row
 * first, because that is what makes the cookie dead everywhere, then the record
 * KV kept. Each store's failure is named on its own, and neither is raised —
 * the caller's answer is already "not signed in", and turning a cleanup into an
 * outage would trap this browser behind a cookie it cannot replace.
 *
 * The owner capability is resolved INSIDE the row's try for the same reason: a
 * deployment missing its secret cannot clean up, and must still let the browser
 * sign in again.
 */
async function discardCorruptSession(
  env: AuthStoreEnv,
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

/** Revoke ONE session, everywhere, now: the authority's row is deleted first,
 *  so the next request carrying this cookie is refused at whatever colo it
 *  reaches. The user's other sessions keep their rows.
 *
 *  Throws when the authority refuses or cannot be reached, and logout reports
 *  that rather than claiming a revocation it did not get. The KV delete after
 *  it is cleanup: the row is already gone, so the record stands for nothing and
 *  would expire on its own TTL anyway. A cleanup that fails is recorded, never
 *  raised — raising it would report a revocation that landed as one that did
 *  not, and would cost the browser the cookie it could retry with. */
export async function revokeSession(env: AuthStoreEnv, token: string): Promise<void> {
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

/** The user's own Durable Object, which is the one authority on which of their
 *  sessions are live and the durable half of their identity. */
function sessionAuthority(env: AuthStoreEnv, userId: string): DurableObjectStub<UserDO> {
  // SAFETY: The UserDO namespace binding declares UserDO as its stub contract.
  return env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
}

async function resolveIdentity(env: AuthStoreEnv, profile: OAuthProfile, now: number): Promise<AuthIdentity> {
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

/** Single source of truth for post-login redirect sanitization: relative
 *  paths only, no protocol-relative or backslash tricks, and never back
 *  into the auth flow itself. */
export function sanitizeReturnTo(input: string): string {
  const raw = input.trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  if (raw.startsWith('/auth/') || raw === '/login' || raw === '/logout') return '/';
  return raw;
}
