// The cookies this app sets, their names and attributes, and how one is read back: a leaf, so the preview edge and
// a browser test read the product's own cookie without the auth graph behind it.

import { Cause, Effect } from 'effect';
import { settleSync } from '@kinu.run/core/obs';
import { VIEWER_COOKIE_NAME } from '../viewer-pass';

export const SESSION_COOKIE_NAME = '__Host-kinu_session';

/** Binds one OAuth sign-in to the browser that started it; without it a
 *  callback URL is bearer authority (login CSRF). */
export const OAUTH_STATE_COOKIE_NAME = '__Host-kinu_oauth_state';

/** Same binding for the deploy door (`deploy/routes.ts`): the digest of the
 *  OAuth `state`, so `/deploy/callback` proves it is the starting browser. */
export const DEPLOY_STATE_COOKIE_NAME = '__Host-kinu_deploy_state';

/** CSRF cookie for the CLI approval page's POST (`cli/routes.ts`). */
export const CLI_APPROVAL_CSRF_COOKIE_NAME = 'kinu_cli_auth_csrf';

/** Every cookie this app sets. The preview edge (`lib/preview-request.ts`)
 *  strips exactly this set before guest code; register new cookies here only. */
export const KINU_COOKIE_NAMES: readonly string[] = [
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  CLI_APPROVAL_CSRF_COOKIE_NAME,
  DEPLOY_STATE_COOKIE_NAME,
  VIEWER_COOKIE_NAME,
];

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
