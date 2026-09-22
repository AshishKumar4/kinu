/**
 * Document security headers: public pages vs the SPA (own-origin WebSocket, preview-host frames).
 * `'unsafe-inline'` scripts are tolerated: the app has no HTML-injection sink.
 */

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

/** Non-HTML responses are returned untouched. */
export function withAppSecurityHeaders(
  response: Response,
  url: URL,
  previewOrigin: string | null,
): Response {
  if (!response.headers.get('content-type')?.includes('text/html')) return response;
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(BASE_HEADERS)) headers.set(key, value);
  headers.set('content-security-policy', appDocumentCsp(url, previewOrigin));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
