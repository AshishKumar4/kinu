import { KINU_COOKIE_NAMES } from '../auth/session';
import { bearerOf, parseCliBearer } from '../cli/auth-store';

/**
 * Remove host-platform authority before an authenticated preview request
 * crosses into agent-controlled guest code. Guest-owned cookies, guest bearer
 * auth, and application headers remain available to the preview.
 *
 * What is stripped is DERIVED from the modules that mint it, never listed
 * here: the cookies are `auth/session.ts`'s registry of every cookie the app
 * sets, and a bearer is stripped exactly when `cli/auth-store.ts`'s own parse
 * would route it to a UserDO. A copy kept beside this function had drifted in
 * both directions. The device token is not a bearer format at all, so it has
 * no entry: the daemon presents it in the body of `/pc/connect-ticket`, and no
 * authenticator reads one from this header.
 */
export function sanitizePreviewRequestHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  const cookie = headers.get('cookie');
  if (cookie) {
    const guestCookies = cookie.split(';').map((part) => part.trim()).filter((part) => {
      const separator = part.indexOf('=');
      return separator > 0 && !KINU_COOKIE_NAMES.includes(part.slice(0, separator));
    });
    if (guestCookies.length > 0) headers.set('cookie', guestCookies.join('; '));
    else headers.delete('cookie');
  }
  const bearer = bearerOf(headers.get('authorization'));
  if (bearer !== null && parseCliBearer(bearer) !== null) headers.delete('authorization');
  headers.delete('proxy-authorization');
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith('x-kinu-')) headers.delete(name);
  }
  return headers;
}
