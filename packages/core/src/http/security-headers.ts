/**
 * Document security headers: public pages vs the SPA (own-origin WebSocket, preview-host frames).
 * `'unsafe-inline'` scripts are tolerated: the app has no HTML-injection sink.
 */

import { DESKTOP_CLIENT_ROOT } from './desktop-client';

const BASE_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

/** Cache policy for anything derived from a signed-in identity (applied by `json()` and here). */
export const PRIVATE_NO_STORE = 'private, no-store';

const BASE_HEADERS = {
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
};

const PUBLIC_PAGE_CSP = [
  ...BASE_CSP,
  "connect-src 'self'",
  "img-src 'self' data:",
  // Standalone pages frame nothing.
  "frame-src 'none'",
].join('; ');

export function publicHtmlHeaders() {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': PRIVATE_NO_STORE,
    ...BASE_HEADERS,
    'content-security-policy': PUBLIC_PAGE_CSP,
  };
}


/** `previewOrigin` (`https://*.<PREVIEW_HOST_SUFFIX>`) is the only framable host; null falls back to `'self'`. */
function appDocumentCsp(url: URL, previewOrigin: string | null): string {
  const frameSrc = previewOrigin ? `'self' ${previewOrigin}` : "'self'";

  return [
    ...BASE_CSP,
    `connect-src 'self' wss://${url.host}`,
    "img-src 'self' data: blob: https:",
    // `data:`: Vite inlines small KaTeX fonts as data URLs.
    "font-src 'self' data:",
    `frame-src ${frameSrc}`,
  ].join('; ');
}

/** Framed by the app alone; its socket's host, port and path are settings a user can edit, so only this
 *  origin is reachable whatever they say. */
function desktopClientCsp(url: URL): string {
  return [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    `connect-src 'self' ${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`,
    "img-src 'self' data:",
    "frame-src 'none'",
  ].join('; ');
}

/** Non-HTML responses are returned untouched. */
export function withAppSecurityHeaders(
  response: Response,
  url: URL,
  previewOrigin: string | null,
): Response {
  if (!response.headers.get('content-type')?.includes('text/html')) return response;
  const headers = new Headers(response.headers);

  const desktopClient = url.pathname.startsWith(DESKTOP_CLIENT_ROOT);

  for (const [key, value] of Object.entries(BASE_HEADERS)) headers.set(key, value);

  if (desktopClient) headers.set('x-frame-options', 'SAMEORIGIN');
  headers.set('content-security-policy', desktopClient ? desktopClientCsp(url) : appDocumentCsp(url, previewOrigin));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
