// Cookies are opaque HttpOnly session handles; KV stores only their hashes.

import { Cause, Data, Effect } from 'effect';
import { settle, settleSync } from '@kinu.run/core/obs';
import {
  DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, EVAL_ACCOUNTS, EVAL_TRIAL_ACCOUNTS, parseEvalAccount, timingSafeEqual,
} from '@kinu.run/core';
import {
  SessionAuthorityUnavailableError, deriveUserId, verifySession,
  type AuthStoreEnv, type SessionAuthority,
} from './store';
import type { KvStore } from '@kinu.run/agent-utils';
import type { ObjectNamespace } from '@kinu.run/core';
import type { OwnerCapabilityEnv } from '@kinu.run/core';
import type { AccessTokenScope } from '@kinu.run/core';

export const SESSION_COOKIE_NAME = '__Host-kinu_session';

/** Binds one OAuth sign-in to the browser that started it; without it a
 *  callback URL is bearer authority (login CSRF). */
export const OAUTH_STATE_COOKIE_NAME = '__Host-kinu_oauth_state';

/** Same binding for the deploy door (`deploy/routes.ts`): the digest of the
 *  OAuth `state`, so `/deploy/callback` proves it is the starting browser. */
export const DEPLOY_STATE_COOKIE_NAME = '__Host-kinu_deploy_state';

/** CSRF cookie for the CLI approval page's POST (`cli/routes.ts`). */
export const CLI_APPROVAL_CSRF_COOKIE_NAME = 'kinu_cli_auth_csrf';

/** Share-origin viewer cookie, set after a ticket exchange. */
export const VIEWER_COOKIE_NAME = '__Host-kinu_viewer';

/** Every cookie this app sets. The preview edge (`lib/preview-request.ts`)
 *  strips exactly this set before guest code; register new cookies here only. */
export const KINU_COOKIE_NAMES: readonly string[] = [
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  CLI_APPROVAL_CSRF_COOKIE_NAME,
  DEPLOY_STATE_COOKIE_NAME,
  VIEWER_COOKIE_NAME,
];

export interface AuthIdentity {
  /** Stable Kinu user id. */
  userId: string;
  /** Verified email from the active identity provider. */
  email: string;
  /** Provider subject (`sub` or provider-specific stable user id). */
  sub: string;
  provider?: string;
  displayName?: string | null;
  /** App-session auth time in epoch ms, used for step-up checks. */
  authTime?: number;
  /** Cookie path only: tags workspace sockets so logout can reach them. */
  sessionTokenHash?: string;
  /** Connect tickets backed by a scoped `pta_…` token only. */
  cliScopes?: AccessTokenScope[];
  /** Connect tickets only; persisted on the socket so revocation survives hibernation. */
  cliBearer?: { tokenHash: string; generation: number };
}

const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** Step-up rule for webhook creation; the CLI passes its token mint time
 *  (minting requires live browser approval). */
export function isFreshAuthTime(authTimeMs: number | null | undefined, now = Date.now()): boolean {
  return authTimeMs !== null
    && authTimeMs !== undefined
    && authTimeMs > 0
    && now - authTimeMs <= STEP_UP_WINDOW_MS;
}

export class AuthError extends Data.TaggedError('AuthError')<{ readonly message: string; readonly cause?: unknown }> {
  constructor(public readonly status: number, message: string, options?: ErrorOptions) {
    super({ message, ...(options?.cause !== undefined && { cause: options.cause }) });
  }
}

export function readSessionToken(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE_NAME);
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');

  if (!cookie) return null;

  for (const part of cookie.split(';')) {
    const [candidate, ...rest] = part.trim().split('=');

    if (candidate !== name) continue;
    const raw = rest.join('=');

    if (!raw) return null;

    // Invalid percent-encoding is not a cookie we wrote: treat as absent.
    return settleSync(Effect.catchCause(
      Effect.sync((): string | null => decodeURIComponent(raw)),
      (failed) => (Cause.squash(failed) instanceof URIError ? Effect.succeed(null) : Effect.failCause(failed)),
    ));
  }

  return null;
}

/** `Lax`, not `Strict`: the OAuth callback is a cross-site navigation that
 *  must carry the handoff cookie. A zero lifetime clears the cookie. */
export function setCookie(name: string, value: string, lifetimeMs: number): string {
  const maxAge = Math.max(0, Math.floor(lifetimeMs / 1000));

  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export interface AuthEnv<Id = DurableObjectId> extends OwnerCapabilityEnv {
  AUTH_KV?: KvStore;
  UserDO?: ObjectNamespace<Id, SessionAuthority>;
  DEV_USER_EMAIL?: string;
  /** Required to act as `DEV_USER_EMAIL` off loopback. */
  DEV_IDENTITY_SECRET?: string;
}

/** `[::1]` keeps its brackets because `URL.hostname` does. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];

export function authenticateRequest<Id>(request: Request, env: AuthEnv<Id>): Promise<AuthIdentity> {
  return settle(Effect.gen(function* () {
    const sessionToken = readSessionToken(request);

    if (sessionToken) {
      if (!hasSessionBindings(env)) {
        return yield* Effect.die(new AuthError(500, `${env.AUTH_KV ? 'UserDO' : 'AUTH_KV'} binding is not configured`));
      }

      const identity = yield* Effect.catchCause(Effect.promise(() => verifySession(env, sessionToken)), (failed) => {
        const e = Cause.squash(failed);

        if (!(e instanceof SessionAuthorityUnavailableError)) return Effect.failCause(failed);

        // Unreachable authority is not an expired cookie: 401 would force a
        // sign-in the same outage cannot complete.
        return Effect.die(new AuthError(503, e.message, { cause: e }));
      });

      if (identity) return identity;

      return yield* Effect.die(new AuthError(401, 'Kinu session expired. Sign in again.'));
    }

    // The dev identity requires possession, never mere absence of a cookie:
    // loopback, or the shared secret (none configured grants nothing).
    if (env.DEV_USER_EMAIL) {
      const presented = request.headers.get(DEV_IDENTITY_HEADER);

      const held = LOOPBACK_HOSTS.includes(new URL(request.url).hostname)
        || (env.DEV_IDENTITY_SECRET !== undefined
          && presented !== null
          && timingSafeEqual(presented, env.DEV_IDENTITY_SECRET));

      if (held) {
        const email = yield* evalAccountEmail(env.DEV_USER_EMAIL, request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER));

        return { userId: yield* Effect.promise(() => deriveUserId(email)), email, sub: 'dev', provider: 'dev', authTime: Date.now() } satisfies AuthIdentity;
      }
    }

    if (!env.AUTH_KV) {
      return yield* Effect.die(new AuthError(500, 'Browser auth is not configured (AUTH_KV binding missing)'));
    }

    return yield* Effect.die(new AuthError(401, 'No Kinu session in request'));
  }));
}

/** `eval@x` → `eval+devices@x`: a separate user, so its machines reach no other eval account's workspaces. */
function evalAccountEmail(email: string, account: string | null): Effect.Effect<string> {
  if (account === null) return Effect.succeed(email);
  const named = parseEvalAccount(account);

  if (named === null) {
    return Effect.die(new AuthError(400, `Unknown eval account "${account}": one of ${EVAL_ACCOUNTS.join(', ')}, or trial-1 to trial-${String(EVAL_TRIAL_ACCOUNTS)}`));
  }

  const at = email.lastIndexOf('@');

  return Effect.succeed(`${email.slice(0, at)}+${named}${email.slice(at)}`);
}

function hasSessionBindings<Id>(env: AuthEnv<Id>): env is AuthEnv<Id> & AuthStoreEnv<Id> {
  return Boolean(env.AUTH_KV) && Boolean(env.UserDO);
}

/** Methods a site can be made to issue cross-site without reading the reply. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** CSRF gate for cookie-authenticated requests: state changes and WebSocket
 *  upgrades (GETs that open live RPC) must carry a same-origin `Origin`. */
export function crossSiteRejection(request: Request): Response | null {
  if (!readSessionToken(request)) return null;
  const isUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';

  if (!isUpgrade && SAFE_METHODS.has(request.method)) return null;

  const expected = new URL(request.url).origin;
  const stated = request.headers.get('origin') ?? originOf(request.headers.get('referer'));

  if (stated === expected) return null;

  return new Response(
    JSON.stringify({ error: 'Cross-site request rejected', code: 'CROSS_SITE' }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}

function originOf(value: string | null): string | null {
  if (!value || !URL.canParse(value)) return null;

  return new URL(value).origin;
}
