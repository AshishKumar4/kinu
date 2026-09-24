// Cookies are opaque HttpOnly session handles; KV stores only their hashes.

import * as v from 'valibot';
import {
  DEV_IDENTITY_ACCOUNT_HEADER, DEV_IDENTITY_HEADER, DEVICE_CONNECT_PATH, EVAL_ACCOUNTS, timingSafeEqual,
} from '@kinu.run/core';
import {
  SessionAuthorityUnavailableError, deriveUserId, verifySession,
  type AuthStoreEnv, type SessionAuthority,
} from './store';
import { isDeployPath } from '@kinu.run/core/deploy';
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

export class AuthError extends Error {
  constructor(public readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
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

    try {
      return decodeURIComponent(raw);
    } catch (malformed) {
      // Invalid percent-encoding is not a cookie we wrote: treat as absent.
      if (!(malformed instanceof URIError)) throw malformed;

      return null;
    }
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

export async function authenticateRequest<Id>(request: Request, env: AuthEnv<Id>): Promise<AuthIdentity> {
  const sessionToken = readSessionToken(request);

  if (sessionToken) {
    assertSessionBindings(env);

    try {
      const identity = await verifySession(env, sessionToken);

      if (identity) return identity;
    } catch (e) {
      if (!(e instanceof SessionAuthorityUnavailableError)) throw e;
      // Unreachable authority is not an expired cookie: 401 would force a
      // sign-in the same outage cannot complete.
      throw new AuthError(503, e.message, { cause: e });
    }

    throw new AuthError(401, 'Kinu session expired. Sign in again.');
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
      const email = evalAccountEmail(env.DEV_USER_EMAIL, request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER));

      return { userId: await deriveUserId(email), email, sub: 'dev', provider: 'dev', authTime: Date.now() };
    }
  }

  if (!env.AUTH_KV) {
    throw new AuthError(500, 'Browser auth is not configured (AUTH_KV binding missing)');
  }

  throw new AuthError(401, 'No Kinu session in request');
}

/** The dev identity's own address, or for a named eval account (`DEV_IDENTITY_ACCOUNT_HEADER`) its plus-address
 *  (`eval@x` → `eval+devices@x`): another user, so what that account holds never reaches the dev identity's
 *  workspaces. `devices` holds the machines the first-run tier attaches, apart from the account every tier's
 *  agent turns run on, whose device runtime would otherwise offer them. */
function evalAccountEmail(email: string, account: string | null): string {
  if (account === null) return email;
  const named = v.safeParse(v.picklist(EVAL_ACCOUNTS), account);

  if (!named.success) throw new AuthError(400, `Unknown eval account "${account}": one of ${EVAL_ACCOUNTS.join(', ')}`);
  const at = email.lastIndexOf('@');

  return `${email.slice(0, at)}+${named.output}${email.slice(at)}`;
}

function assertSessionBindings<Id>(env: AuthEnv<Id>): asserts env is AuthEnv<Id> & AuthStoreEnv<Id> {
  if (!env.AUTH_KV) throw new AuthError(500, 'AUTH_KV binding is not configured');

  if (!env.UserDO) throw new AuthError(500, 'UserDO binding is not configured');
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

export function isPublicPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;

  if (pathname === '/login' || pathname === '/logout') return true;

  if (pathname.startsWith('/auth/')) return true;

  if (pathname.startsWith('/api/auth/')) return true;

  // the tunnel uses its own auth
  if (pathname.startsWith(DEVICE_CONNECT_PATH)) return true;

  if (pathname.startsWith('/assets/')) return true;

  // Data (`/api/shared/blueprint/:id`) is signature-checked before the auth gate.
  if (pathname.startsWith('/shared/blueprint/')) return true;

  // The self-deploy door: authorized by the run key (deploy/routes.ts), not a session.
  if (isDeployPath(pathname)) return true;

  return false;
}
