// Cookies are opaque HttpOnly session handles; KV stores only their hashes.

import { Cause, Data, Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import {
  DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, EVAL_ACCOUNTS, EVAL_TRIAL_ACCOUNTS, err, json, parseEvalAccount, timingSafeEqual,
} from '@kinu.run/core';
import {
  SessionAuthorityUnavailableError, accountIdFor, verifySession,
  type AuthStoreEnv, type SessionAuthority,
} from './store';
import { readCookie, SESSION_COOKIE_NAME } from './cookies';
import type { KvStore } from '@kinu.run/agent-utils';
import type { ObjectNamespace } from '@kinu.run/core';
import type { OwnerCapabilityEnv } from '@kinu.run/core';
import type { SignInDeclarationEnv } from '@kinu.run/core/identity';
import type { AccessTokenScope } from '@kinu.run/core';


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



/** The sign-in declaration names which account the eval identity's address is. */
export interface AuthEnv<Id = DurableObjectId> extends OwnerCapabilityEnv, SignInDeclarationEnv {
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

    const devEmail = yield* devIdentityEmail(request, env);

    if (devEmail !== null) {
      return { userId: yield* Effect.promise(() => accountIdFor(env, devEmail)), email: devEmail, sub: 'dev', provider: 'dev', authTime: Date.now() } satisfies AuthIdentity;
    }

    if (!env.AUTH_KV) {
      return yield* Effect.die(new AuthError(500, 'Browser auth is not configured (AUTH_KV binding missing)'));
    }

    return yield* Effect.die(new AuthError(401, 'No Kinu session in request'));
  }));
}

/**
 * The dev identity's email when `request` holds it, else null. It requires possession, never mere absence of a cookie:
 * loopback, or the shared secret in DEV_IDENTITY_HEADER (none configured grants nothing), with DEV_IDENTITY_ACCOUNT_HEADER
 * naming an eval account. The secret is accepted in that header and nowhere else, never as a cookie, deliberately. A
 * browser holds the identity the way a person does: it exchanges the header once, on the app's origin, for a session
 * cookie (`POST /api/auth/dev-session`, gated by this same check), which the browser scopes to that origin, socket
 * handshakes included. A header set on a whole page goes to every origin the page reaches.
 */
export function devIdentityEmail(request: Request, env: Pick<AuthEnv, 'DEV_USER_EMAIL' | 'DEV_IDENTITY_SECRET'>): Effect.Effect<string | null> {
  if (env.DEV_USER_EMAIL === undefined || env.DEV_USER_EMAIL === '') return Effect.succeed(null);
  const presented = request.headers.get(DEV_IDENTITY_HEADER);

  const held = LOOPBACK_HOSTS.includes(new URL(request.url).hostname)
    || (env.DEV_IDENTITY_SECRET !== undefined
      && presented !== null
      && timingSafeEqual(presented, env.DEV_IDENTITY_SECRET));

  return held ? evalAccountEmail(env.DEV_USER_EMAIL, request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER)) : Effect.succeed(null);
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

  return json({ body: { error: 'Cross-site request rejected', code: 'CROSS_SITE' } }, { status: 403 });
}

/**
 * The one session gate every signed-in surface passes: who asks, then the cross-site rule. No one signed in is refused
 * in `err()`'s rendering, except a page a browser asked for, which is sent to sign-in and back.
 */
export function sessionGate<Id>(request: Request, env: AuthEnv<Id>): Effect.Effect<AuthIdentity | Response> {
  return Effect.gen(function* () {
    const identity = yield* Effect.catchCause(Effect.promise(() => authenticateRequest(request, env)), (failed) => {
      const refused = Cause.squash(failed);

      return refused instanceof AuthError ? Effect.succeed(authRefusal(request, refused)) : Effect.failCause(failed);
    });

    if (identity instanceof Response) return identity;

    return crossSiteRejection(request) ?? identity;
  });
}

function authRefusal(request: Request, refused: AuthError): Response {
  if (refused.status !== 401 || !wantsPage(request)) return err(refused.status, refused.message);
  const url = new URL(request.url);
  const login = new URL('/login', url.origin);

  login.searchParams.set('return_to', url.pathname + url.search + url.hash);

  return new Response(null, { status: 302, headers: { location: login.toString(), 'cache-control': 'no-store' } });
}

/** A browser navigating to a page; the agent transport never is one. */
function wantsPage(request: Request): boolean {
  if (new URL(request.url).pathname.startsWith('/agents/')) return false;
  const accept = request.headers.get('accept') ?? '';

  return request.method === 'GET' && (accept.includes('text/html') || accept.includes('*/*'));
}

function originOf(value: string | null): string | null {
  if (!value || !URL.canParse(value)) return null;

  return new URL(value).origin;
}
