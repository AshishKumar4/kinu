// Browser authentication for Kinu.
//
// Primary path: app-owned OAuth/OIDC sessions in KV. Browser cookies are
// opaque, HttpOnly session handles; KV stores only hashes.
//
// Local/staging dev: `env.DEV_USER_EMAIL` names ONE identity a caller may act
// as without signing in. It says which identity, never that anyone may have it
// — see `authenticateRequest`. Production must leave that variable unset.

import { DEVICE_CONNECT_PATH, timingSafeEqual } from '@kinu.run/core';
import {
  SessionAuthorityUnavailableError, deriveUserId, verifySession, type AuthStoreEnv,
} from './store';
import type { KvStore } from '../lib/kv';
import type { UserDO } from '../user/user-do';
import type { OwnerCapabilityEnv } from '../user/workspace-capability';
import type { AccessTokenScope } from '../cli/access-token-store';

export const SESSION_COOKIE_NAME = '__Host-kinu_session';

/** The handoff cookie that binds ONE OAuth sign-in to the browser that started
 *  it. `__Host-` and HttpOnly so no subdomain and no script can plant a value
 *  the callback would accept, random so nothing can guess one, and paired with
 *  a server-side state record that holds only its hash. Without it a callback
 *  URL is bearer authority: an attacker completes a sign-in in their own
 *  browser, hands the resulting `?code=&state=` link to a victim, and the
 *  victim's browser is signed in as the attacker. */
export const OAUTH_STATE_COOKIE_NAME = '__Host-kinu_oauth_state';

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
  /** Present only for connect-ticket identities backed by a scoped `pta_…`
   *  access token — the agent websocket pins the connection to these scopes.
   *  Absent for browser sessions and interactive CLI session tokens. */
  cliScopes?: AccessTokenScope[];
  /** Present only for connect-ticket identities: the bearer the upgrade
   *  authenticated, and the account authorization generation it was admitted
   *  under. The agent websocket persists this on the connection, so a
   *  revocation can still name the socket after hibernation. */
  cliBearer?: { tokenHash: string; generation: number };
}

/** Step-up (fresh-auth) window for sensitive operations — creating webhook
 *  ingress endpoints requires an interactive sign-in within this window. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** Single step-up rule for every webhook-creation path: web sessions check
 *  the session auth time; the CLI checks its token mint time (minting
 *  requires a live browser approval, so it is the CLI's interactive-auth
 *  timestamp). */
export function isFreshAuthTime(authTimeMs: number | null | undefined, now = Date.now()): boolean {
  return authTimeMs !== null
    && authTimeMs !== undefined
    && authTimeMs > 0
    && now - authTimeMs <= STEP_UP_WINDOW_MS;
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
  }
}

export function readSessionToken(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE_NAME);
}

/** One cookie by name, or null when the request carries no such cookie.
 *
 *  Values are written percent-encoded, so they are decoded back here — and a
 *  value that is not valid percent-encoding is not one this app wrote, which
 *  is an absent cookie rather than a thrown request. */
export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [candidate, ...rest] = part.trim().split('=');
    if (candidate !== name) continue;
    const raw = rest.join('=');
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch (malformed) {
      // A cookie this app did not write can carry anything, and a broken
      // percent escape is the one failure that reaches here: that value is not
      // one of ours, so there is no cookie of ours in the request. Anything
      // else is not a cookie problem and is not this function's to answer.
      if (!(malformed instanceof URIError)) throw malformed;
      return null;
    }
  }
  return null;
}

export interface AuthEnv extends OwnerCapabilityEnv {
  AUTH_KV?: KvStore;
  /** Where a session cookie's authority lives: the row that says the session
   *  is still live sits in the signing-in user's own Durable Object. */
  UserDO?: DurableObjectNamespace<UserDO>;
  DEV_USER_EMAIL?: string;
  /** The shared secret a caller presents to act as `DEV_USER_EMAIL` on a
   *  deployment that is not a developer's own machine. */
  DEV_IDENTITY_SECRET?: string;
}

/**
 * How a caller proves it may act as `DEV_USER_EMAIL`.
 *
 * A HEADER rather than a cookie, deliberately: a browser attaches cookies to
 * every request to an origin, including ones another page caused, so a
 * cookie-carried dev identity would be an ambient credential on the one
 * deployment that has no real sign-in behind it. A header is never ambient.
 */
const DEV_IDENTITY_HEADER = 'x-kinu-dev-identity';

/** Hosts that can only be a developer's own machine. `[::1]` keeps its brackets
 *  because `URL.hostname` does. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];

/** Resolve the caller identity for a request.
 *
 *   - production: verify app session, return identity, or throw AuthError
 *   - dev (DEV_USER_EMAIL set): synthesize identity, no JWT required
 *   - mis-configured: throw 500
 */
export async function authenticateRequest(request: Request, env: AuthEnv): Promise<AuthIdentity> {
  const sessionToken = readSessionToken(request);
  if (sessionToken) {
    assertSessionBindings(env);
    try {
      const identity = await verifySession(env, sessionToken);
      if (identity) return identity;
    } catch (e) {
      if (!(e instanceof SessionAuthorityUnavailableError)) throw e;
      // Unreachable authority is not an expired cookie: 401 here would send a
      // signed-in user into a sign-in the same outage cannot complete.
      throw new AuthError(503, e.message, { cause: e });
    }
    throw new AuthError(401, 'Kinu session expired. Sign in again.');
  }

  // A synthesized identity is a signed-in user without a sign-in, so what
  // enables it must be POSSESSION, never the absence of a cookie. Staging
  // publishes `DEV_USER_EMAIL` on a public route: gated on absence, every
  // unauthenticated request that reached it arrived as the eval service account
  // holding ordinary user, workspace, MCP and feedback authority.
  //
  // Two ways to hold it, and no third. A developer's own machine is already
  // the whole trust boundary, so localhost needs no secret and local dev is
  // unchanged. Everywhere else the caller presents the shared secret, and a
  // deployment that configures no secret grants nothing.
  if (env.DEV_USER_EMAIL) {
    const presented = request.headers.get(DEV_IDENTITY_HEADER);
    const held = LOOPBACK_HOSTS.includes(new URL(request.url).hostname)
      || (env.DEV_IDENTITY_SECRET !== undefined
        && presented !== null
        && timingSafeEqual(presented, env.DEV_IDENTITY_SECRET));
    if (held) {
      return {
        userId: await deriveUserId(env.DEV_USER_EMAIL),
        email: env.DEV_USER_EMAIL,
        sub: 'dev',
        provider: 'dev',
        authTime: Date.now(),
      };
    }
  }

  if (!env.AUTH_KV) {
    throw new AuthError(500, 'Browser auth is not configured (AUTH_KV binding missing)');
  }
  throw new AuthError(401, 'No Kinu session in request');
}

/** The bindings a cookie carries no authority without. Checked only on the
 *  cookie path: the dev identity reaches neither. */
function assertSessionBindings(env: AuthEnv): asserts env is AuthEnv & AuthStoreEnv {
  if (!env.AUTH_KV) throw new AuthError(500, 'AUTH_KV binding is not configured');
  if (!env.UserDO) throw new AuthError(500, 'UserDO binding is not configured');
}

/** Methods a site can be made to issue cross-site without reading the reply. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF gate for cookie-authenticated requests.
 *
 * The session cookie is ambient: the browser attaches it to any request to this
 * origin, including ones another page caused. Every state-changing request that
 * arrives with it must therefore prove it was issued by this app, and the proof
 * is the `Origin` header — set by the browser, not settable by script.
 * WebSocket upgrades are included: they are GETs, but they open a live RPC
 * channel to the agent and browsers always send `Origin` on the handshake.
 *
 * Requests authenticated some other way (CLI bearer token, connect ticket)
 * carry no ambient credential and are not gated — an attacker's page cannot
 * make the browser attach a token it does not have.
 *
 * Returns a denial, or null when the request may proceed.
 */
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

/** Public routes on the app's own host that bypass auth. (Preview hosts are
 *  not here: they are served on the preview host, which never reaches this.) */
export function isPublicPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname === '/login' || pathname === '/logout') return true;
  if (pathname.startsWith('/auth/')) return true;
  if (pathname.startsWith('/api/auth/')) return true;
  // covers /pc/connect and /pc/connect-ticket — the tunnel uses its own auth
  if (pathname.startsWith(DEVICE_CONNECT_PATH)) return true;
  if (pathname.startsWith('/assets/')) return true;    // hashed static bundles
  return false;
}
