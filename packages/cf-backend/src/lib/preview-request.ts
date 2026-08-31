// Every cookie the Kinu app itself sets, and the one list of them. The names
// are owned by the modules that set them — `auth/session.ts` for the two
// authority cookies — and a cookie added there without an entry here reaches
// agent-controlled guest code.
const KINU_COOKIE_NAMES = new Set([
  '__Host-kinu_session',
  '__Host-kinu_oauth_state',
  '__Host-kinu_d1_bookmark',
]);

/** Remove host-platform authority before an authenticated preview request
 * crosses into agent-controlled guest code. Guest-owned cookies, bearer auth,
 * and application headers remain available to the preview. */
export function sanitizePreviewRequestHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  const cookie = headers.get('cookie');
  if (cookie) {
    const guestCookies = cookie.split(';').map((part) => part.trim()).filter((part) => {
      const separator = part.indexOf('=');
      return separator > 0 && !KINU_COOKIE_NAMES.has(part.slice(0, separator));
    });
    if (guestCookies.length > 0) headers.set('cookie', guestCookies.join('; '));
    else headers.delete('cookie');
  }
  const authorization = headers.get('authorization');
  if (authorization && /^Bearer\s+(?:pta|ptc|pdt)_/i.test(authorization)) headers.delete('authorization');
  headers.delete('proxy-authorization');
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith('x-kinu-')) headers.delete(name);
  }
  return headers;
}
