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


/**
 * A personal part's frame, `/s/:workspace/:slate/parts/:part` (APP_ROUTES.liveSlatePart): the one app page a slate's own
 * page frames, from its preview host, under the app page at the top (docs/SLATE-SHARING-NIMBUS.md §3).
 */
const PART_FRAME = /^\/s\/[^/]+\/[^/]+\/parts\/[^/]+$/u;

/**
 * `previewOrigin` (`https://*.<PREVIEW_HOST_SUFFIX>`) is the only framable host; null falls back to `'self'`. `framedBy`
 * replaces `frame-ancestors 'none'` for the one page a preview host frames.
 */
function appDocumentCsp(url: URL, previewOrigin: string | null, framedBy: string | null): string {
  const frameSrc = previewOrigin ? `'self' ${previewOrigin}` : "'self'";

  return [
    ...BASE_CSP.map((directive) => (framedBy !== null && directive === "frame-ancestors 'none'" ? `frame-ancestors ${framedBy}` : directive)),
    `connect-src 'self' wss://${url.host}`,
    "img-src 'self' data: blob: https:",
    // Fonts are files of this origin: the build inlines none (vite.config.ts `assetsInlineLimit`).
    "font-src 'self'",
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
  // X-Frame-Options names no host, so a page preview hosts may frame carries none; its CSP names them. CSP checks every
  // ancestor, and the app's own page is the top above the slate's.
  const partFramedBy = previewOrigin !== null && PART_FRAME.test(url.pathname) ? `'self' ${previewOrigin}` : null;

  for (const [key, value] of Object.entries(BASE_HEADERS)) headers.set(key, value);
  // How long the shell is kept is the shell's (`cachePolicy`, app-shell.ts).

  if (desktopClient) headers.set('x-frame-options', 'SAMEORIGIN');

  if (partFramedBy !== null) headers.delete('x-frame-options');
  headers.set('content-security-policy', desktopClient ? desktopClientCsp(url) : appDocumentCsp(url, previewOrigin, partFramedBy));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
