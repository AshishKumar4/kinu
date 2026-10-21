// Browser auth state: the OAuth handoff and browser sessions.
//
// The handoff record in KV holds the hash of a browser binding cookie; both are burned by the callback,
// so a callback URL is worthless away from the browser that started sign-in (login CSRF).
// Session liveness is decided only by the row in the user's Durable Object: KV propagates across colos
// slowly, so it can say neither that a session was revoked nor that it exists. KV carries a projection
// of the identity only. A request that cannot reach the authority is refused.
// The userId is derived from the verified email (`deriveUserId`), so the email is the account and an
// unverified address is not an identity.

import { Cause, Data, Effect } from 'effect';
import type { AuthIdentity } from './session';
import type { OAuthProviderId } from '@kinu.run/core/identity';
import { builtinSignInOn, type SignInDeclarationEnv } from '@kinu.run/core/identity';
import type { UserDO } from '../user/user-do';
import type { BrowserSessionIdentity, LiveBrowserSession } from '../user/sessions';
import type { ObjectNamespace } from '@kinu.run/core';
import { objectNamed, randomToken, sha256Hex } from '@kinu.run/core';
import { readKvJson, writeKvJson, type KvStore } from '@kinu.run/agent-utils';
import { ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import { timingSafeEqual } from '@kinu.run/core';
import { type KinuError, settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { sanitizeReturnTo } from '@kinu.run/core';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface OAuthStateInput {
  provider: OAuthProviderId;
  codeVerifier: string;
  nonce?: string | null;
  returnTo: string;
  redirectUri: string;
  /** A connect's: the account whose session started it, which the callback attaches to and must still be signed in
   *  as. Absent, the run is a sign-in. */
  connectFor?: string | null;
  /** A connect's run, the starting page's own id (`ConnectRunSchema`), which its finish page names. */
  connectRun?: string | null;
}

/** A handoff spent by the browser it was issued to: its record, and why it is refused if it is (expired, another
 *  provider's). Refused, the record still says whether it was a connect, and whose run. */
export interface ConsumedOAuthState {
  readonly record: OAuthStateRecord;
  readonly refusal: string | null;
}

/** Provider echoes `state`; the browser carries `binding` in a cookie. Both are needed to spend the
 *  record; minted together so no handoff is bound to nothing. */
export interface OAuthHandoff {
  state: string;
  binding: string;
}

export interface OAuthProfile {
  /** `dev`: the dev identity's exchange (`POST /api/auth/dev-session`), whose possession check verified the email. */
  provider: OAuthProviderId | 'password' | 'passkey' | 'dev';
  providerSub: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
  credentialGeneration?: number;
}

export interface BrowserSession {
  token: string;
  /** The one instant the KV record's TTL and the cookie's lifetime are both taken from. */
  issuedAt: number;
  expiresAt: number;
  identity: AuthIdentity;
}

/** A projection of the class, so a stand-in keeps the object's real contract. */
export type SessionAuthority = Pick<
  UserDO, 'ensureProfile' | 'registerBrowserSession' | 'verifyBrowserSession' | 'revokeBrowserSession'
>;

export interface AuthStoreEnv<Id = DurableObjectId> extends OwnerCapabilityEnv, SignInDeclarationEnv {
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
  connectFor: v.optional(v.nullable(v.string()), null),
  connectRun: v.optional(v.nullable(v.string()), null),
  createdAt: v.number(),
  expiresAt: v.number(),
});

type OAuthStateRecord = v.InferOutput<typeof OAuthStateSchema>;

/** Truncated sha256 in the shape every userId-carrying format (UserDO name, `ptc_…` token) expects;
 *  the one derivation for dev and real sign-in. */
async function deriveUserId(email: string): Promise<string> {
  return (await sha256Hex(email.trim().toLowerCase())).slice(0, 32);
}

/** Never the userId an OAuth login of the address gets. */
async function deriveBuiltinUserId(email: string): Promise<string> {
  return deriveUserId(`builtin:${email.trim().toLowerCase()}`);
}

/**
 * The account an address is here, the one rule every sign-in mints by and every person named by address (a share's
 * recipient) resolves by: a deployment offers built-in sign-in or OAuth, never both (`builtinSignInOn`).
 */
export async function accountIdFor(env: SignInDeclarationEnv, email: string): Promise<string> {
  return builtinSignInOn(env) ? deriveBuiltinUserId(email) : deriveUserId(email);
}

const BUILTIN_METHODS: ReadonlySet<string> = new Set(['password', 'passkey']);

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
    returnTo: sanitizeReturnTo(input.returnTo, new URL(input.redirectUri).origin),
    redirectUri: input.redirectUri,
    bindingHash: await sha256Hex(binding),
    connectFor: input.connectFor ?? null,
    connectRun: input.connectRun ?? null,
    createdAt: now,
    expiresAt,
  };

  // Kept as long as the state is redeemable: a later callback is named by its browser's own cookie (`handoffCookie`).
  await writeKvJson(kv, `oauth-state:${await sha256Hex(state)}`, record, OAUTH_STATE_TTL_MS);

  return { state, binding };
}

/** Deleted before it is judged, so a concurrent second callback finds nothing, and a planted link spends its own state
 *  (the planted-link test). A callback without the `binding` it was issued is refused before anything in the record is
 *  read back; one with it is answered with its record, refused or not, so a connect that is refused still names its
 *  run. */
export function consumeOAuthState(
  kv: KvStore,
  state: string,
  provider: OAuthProviderId,
  binding: string | null,
): Promise<ConsumedOAuthState> {
  return settle(Effect.gen(function* () {
    const key = `oauth-state:${yield* Effect.promise(async () => sha256Hex(state))}`;
    const record = yield* Effect.promise(async () => readKvJson(kv, key, OAuthStateSchema));
    yield* Effect.promise(async () => kv.delete(key));

    if (!record) return yield* Effect.die(new Error('OAuth state expired, or was already used. Start again.'));

    if (!binding || !timingSafeEqual(yield* Effect.promise(async () => sha256Hex(binding)), record.bindingHash)) {
      return yield* Effect.die(new Error('OAuth state was not issued to this browser. Start sign-in again.'));
    }

    const bound = { ...record, returnTo: sanitizeReturnTo(record.returnTo, new URL(record.redirectUri).origin) };

    if (record.provider !== provider) return { record: bound, refusal: 'OAuth state provider mismatch.' };

    if (record.expiresAt <= Date.now()) return { record: bound, refusal: 'OAuth state expired. Start sign-in again.' };

    return { record: bound, refusal: null };
  }));
}

/** The id is in the token, so a check or a logout reaches the account's object with no lookup. */
function parseSessionTokenUserId(token: string): string | null {
  const match = /^ps_([a-f0-9]{32})_[A-Za-z0-9_-]{64,}$/.exec(token);

  return match?.[1] ?? null;
}

export function createSession<Id>(env: AuthStoreEnv<Id>, profile: OAuthProfile): Promise<BrowserSession> {
  return settle(Effect.gen(function* () {
    const now = Date.now();
    const identity = yield* resolveIdentity(env, profile, now);
    const token = `ps_${identity.userId}_${randomToken(48)}`;
    const tokenHash = yield* Effect.promise(async () => sha256Hex(token));
    const expiresAt = now + SESSION_TTL_MS;
    const caller = yield* Effect.promise(async () => ownerCaller(env));
    const authority = sessionAuthority(env, identity.userId);

    const minted: BrowserSessionIdentity = {
      email: identity.email,
      displayName: identity.displayName ?? null,
      provider: identity.provider ?? profile.provider,
      sub: identity.sub,
      authTime: now,
    };

    // Registered before the cookie exists: a cookie is never outstanding against a session nothing can revoke.
    yield* Effect.promise(async () => authority.registerBrowserSession(caller, tokenHash, expiresAt, { ...minted, credentialGeneration: profile.credentialGeneration ?? 0 }));

    return { token, issuedAt: now, expiresAt, identity };
  }));
}

/** A session that cannot be checked is not an invalid one: answering 401 during an outage would sign
 *  everyone out into a sign-in that also fails. Raised only at the store boundaries. */
export class SessionAuthorityUnavailableError extends Data.TaggedError('SessionAuthorityUnavailableError')<{ readonly message: string; readonly cause?: unknown }> {
  constructor(options: { cause: unknown }) {
    super({ message: 'Kinu cannot reach the store that holds your sign-in right now. Try again shortly.', cause: options.cause });
  }
}

/** Null when not signed in; throws {@link SessionAuthorityUnavailableError} when the answer cannot be
 *  obtained. The account's session row is liveness and identity both; revocation deletes it. */
export function verifySession<Id>(env: AuthStoreEnv<Id>, token: string): Promise<AuthIdentity | null> {
  return settle(Effect.gen(function* () {
    const userId = parseSessionTokenUserId(token);

    if (!userId) return null;
    const tokenHash = sha256Hex(token);

    // Outside the catch: a missing owner secret is a misconfiguration, not an unreachable DO.
    const caller = yield* Effect.promise(() => ownerCaller(env));

    const live: LiveBrowserSession | null = yield* Effect.catchCause(
      Effect.promise(() => sessionAuthority(env, userId).verifyBrowserSession(caller, tokenHash)),
      (failed) => Effect.die(new SessionAuthorityUnavailableError({ cause: Cause.squash(failed) })),
    );

    if (!live) return null;
    const snapshot = live.identity;

    // Once OAuth is declared, built-in sessions end with built-in sign-in.
    if (BUILTIN_METHODS.has(snapshot.provider) && !builtinSignInOn(env)) return null;

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
  }));
}

/** Deletes the session row, so the cookie is refused everywhere at once; throws if that fails. */
export async function revokeSession<Id>(env: AuthStoreEnv<Id>, token: string): Promise<void> {
  const userId = parseSessionTokenUserId(token);

  if (!userId) return;
  const tokenHash = await sha256Hex(token);
  const caller = await ownerCaller(env);
  await sessionAuthority(env, userId).revokeBrowserSession(caller, tokenHash);
}

/** The one authority on which of a user's sessions are live. */
function sessionAuthority<Id>(env: AuthStoreEnv<Id>, userId: string): SessionAuthority {
  return objectNamed(env.UserDO, userId);
}

function resolveIdentity<Id>(env: AuthStoreEnv<Id>, profile: OAuthProfile, now: number): Effect.Effect<AuthIdentity, KinuError> {
  return Effect.gen(function* () {
    const email = profile.email.trim().toLowerCase();

    if (!email) return yield* Effect.die(new Error('OAuth provider did not return an email address.'));

    if (!profile.providerSub) return yield* Effect.die(new Error('OAuth provider did not return a stable subject.'));

    const builtin = BUILTIN_METHODS.has(profile.provider);

    // Unverified: a built-in account keeps its own namespace.
    if (!profile.emailVerified && !builtin) {
      return yield* Effect.die(new Error('OAuth provider did not report this email address as verified.'));
    }

    const userId = yield* Effect.promise(async () => accountIdFor(env, email));

    const stored = yield* Effect.promise(async () => sessionAuthority(env, userId)
      .ensureProfile(await ownerCaller(env), email, profile.displayName ?? undefined));

    return {
      userId,
      email,
      sub: profile.providerSub,
      provider: profile.provider,
      displayName: profile.displayName ?? stored.displayName,
      authTime: now,
    };
  });
}

