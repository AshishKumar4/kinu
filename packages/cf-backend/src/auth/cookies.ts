// The cookies this app sets, their names and attributes, and how one is read back: a leaf, so the preview edge and
// a browser test read the product's own cookie without the auth graph behind it. Hosted only, so locked in
// `capability-parity.lock.json`: each cookie is set by a cf route, and the local CLI's loopback origin has no session.

import { Cause, Effect } from 'effect';
import { settleSync } from '@kinu.run/core/obs';
import { VIEWER_COOKIE_NAME } from '../viewer-pass';

export const SESSION_COOKIE_NAME = '__Host-kinu_session';

/** Binds one OAuth sign-in to the browser that started it; without it a
 *  callback URL is bearer authority (login CSRF). Each handoff has its own cookie, this name and a digest of its state
 *  (`oauthStateCookieName`), so the sign-ins and connects one browser starts never replace each other's. */
const OAUTH_STATE_COOKIE_NAME = '__Host-kinu_oauth_state';

/** One handoff's binding cookie, named by the hex digest of its state. */
export function oauthStateCookieName(stateDigest: string): string {
  return `${OAUTH_STATE_COOKIE_NAME}_${stateDigest.slice(0, 16)}`;
}

/** Same binding for the deploy door (`deploy/routes.ts`): the digest of the
 *  OAuth `state`, so `/deploy/callback` proves it is the starting browser. */
export const DEPLOY_STATE_COOKIE_NAME = '__Host-kinu_deploy_state';

/** CSRF cookie for the CLI approval page's POST (`cli/routes.ts`). */
export const CLI_APPROVAL_CSRF_COOKIE_NAME = 'kinu_cli_auth_csrf';

/** Every cookie this app sets. The preview edge (`lib/preview-request.ts`)
 *  strips exactly this set before guest code; register new cookies here only. */
export const KINU_COOKIE_NAMES: readonly string[] = [
  SESSION_COOKIE_NAME,
  CLI_APPROVAL_CSRF_COOKIE_NAME,
  DEPLOY_STATE_COOKIE_NAME,
  VIEWER_COOKIE_NAME,
];

/** The cookies this app sets as `<family>_<digest>`, one per handoff (`oauthStateCookieName`): the preview edge strips
 *  each family whole. */
export const KINU_COOKIE_FAMILIES: readonly string[] = [OAUTH_STATE_COOKIE_NAME];

/**
 * The handoffs one browser may hold at once, each its own cookie for its lifetime. RFC 6265 §6.1 asks a browser to keep
 * at least 50 cookies per domain, and Chromium purges an eTLD+1 past 180 (net/cookies/cookie_monster.cc): beyond its
 * budget a new cookie can evict an older one, the session among them. This many leaves most of the 50 to the app's
 * own cookies (`KINU_COOKIE_NAMES`) and to a guest's; a start past it is refused, never one held replaced.
 */
export const OAUTH_HANDOFFS_HELD = 20;

/** How many handoff cookies (`KINU_COOKIE_FAMILIES`) `request` carries. */
export function heldHandoffs(request: Request): number {
  return (request.headers.get('cookie') ?? '').split(';')
    .filter((part) => KINU_COOKIE_FAMILIES.some((family) => part.trim().startsWith(`${family}_`))).length;
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

/** The cookie a sign-in answers with, whichever way the person signed in: it lives as long as the session. */
export function sessionCookie(session: { readonly token: string; readonly issuedAt: number; readonly expiresAt: number }): string {
  return setCookie(SESSION_COOKIE_NAME, session.token, session.expiresAt - session.issuedAt);
}
