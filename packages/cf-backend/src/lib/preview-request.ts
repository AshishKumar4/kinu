import { KINU_COOKIE_FAMILIES, KINU_COOKIE_NAMES } from '../auth/cookies';
import { bearerOf, parseCliBearer } from '../cli/auth-store';

/**
 * Strip host-platform authority before a preview request reaches guest code; guest cookies/bearer/headers stay.
 * Stripped set is derived from `auth/session.ts` cookies and `cli/auth-store.ts` bearer parse, never listed here.
 */
export function sanitizePreviewRequestHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  const cookie = headers.get('cookie');

  if (cookie) {
    const guestCookies = cookie.split(';').map((part) => part.trim()).filter((part) => {
      const separator = part.indexOf('=');

      const name = part.slice(0, separator);

      return separator > 0 && !KINU_COOKIE_NAMES.includes(name) && !KINU_COOKIE_FAMILIES.some((family) => name.startsWith(`${family}_`));
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
