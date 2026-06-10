// Browser authentication for Proteus.
//
// Primary path: app-owned OAuth/OIDC sessions stored in D1. Browser cookies
// are opaque, HttpOnly session handles; D1 stores only hashes.
//
// Local/staging dev: if `env.DEV_USER_EMAIL` is set, we synthesize an identity
// from that email. Production must leave that variable unset.

import { readD1Bookmark, verifySession } from './d1-store.js';
import { sha256Hex } from '../lib/crypto.js';

export const SESSION_COOKIE_NAME = '__Host-proteus_session';

export interface AuthIdentity {
  /** Stable Proteus user id. */
  userId: string;
  /** Verified email from the active identity provider. */
  email: string;
  /** Provider subject (`sub` or provider-specific stable user id). */
  sub: string;
  provider?: string;
  displayName?: string | null;
  /** App-session auth time in epoch ms, used for step-up checks. */
  authTime?: number;
  /** Latest D1 session bookmark for sequentially consistent replica reads. */
  d1Bookmark?: string | null;
}

/** Step-up (fresh-auth) window for sensitive operations — creating webhook
 *  ingress endpoints requires an interactive sign-in within this window. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** Single step-up rule for every webhook-creation path: web sessions check
 *  the session auth time; the CLI checks its token mint time (minting
 *  requires a live browser approval, so it is the CLI's interactive-auth
 *  timestamp). */
export function isFreshAuthTime(authTimeMs: number | null | undefined, now = Date.now()): boolean {
  return typeof authTimeMs === 'number' && authTimeMs > 0 && now - authTimeMs <= STEP_UP_WINDOW_MS;
}

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Deterministic dev user id: sha256(email) truncated to 32 hex chars. */
export async function deriveUserId(email: string): Promise<string> {
  return (await sha256Hex(email.trim().toLowerCase())).slice(0, 32);
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(rest.join('=') || '');
  }
  return null;
}

export interface AuthEnv {
  AUTH_DB?: D1Database;
  DEV_USER_EMAIL?: string;
}

/** Resolve the caller identity for a request.
 *
 *   - production: verify app session, return identity, or throw AuthError
 *   - dev (DEV_USER_EMAIL set): synthesize identity, no JWT required
 *   - mis-configured: throw 500
 */
export async function authenticateRequest(request: Request, env: AuthEnv): Promise<AuthIdentity> {
  const sessionToken = readSessionToken(request);
  if (sessionToken) {
    if (!env.AUTH_DB) throw new AuthError(500, 'AUTH_DB binding is not configured');
    const verified = await verifySession(env.AUTH_DB, sessionToken, readD1Bookmark(request));
    const identity = verified.identity;
    if (identity) return identity;
    throw new AuthError(401, 'Proteus session expired. Sign in again.');
  }

  if (env.DEV_USER_EMAIL) {
    return {
      userId: await deriveUserId(env.DEV_USER_EMAIL),
      email: env.DEV_USER_EMAIL,
      sub: 'dev',
      provider: 'dev',
      authTime: Date.now(),
    };
  }

  if (!env.AUTH_DB) {
    throw new AuthError(500, 'Browser auth is not configured (AUTH_DB binding missing)');
  }
  throw new AuthError(401, 'No Proteus session in request');
}

/** Public routes that bypass auth. Health check + sandbox preview proxy
 *  (which has its own token-in-URL auth). */
export function isPublicPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname === '/login' || pathname === '/logout') return true;
  if (pathname.startsWith('/auth/')) return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/_preview/')) return true;
  if (pathname.startsWith('/pc/connect')) return true; // reverse-WS tunnel uses its own auth
  if (pathname.startsWith('/assets/')) return true;    // hashed static bundles
  return false;
}
