/**
 * Document security headers.
 *
 * Two policies, one base. Public pages (landing, CLI install/approval, OAuth
 * result pages) are self-contained HTML. The app is the SPA: it opens a
 * WebSocket to its own origin and frames previews served from the preview host,
 * so it needs those two exceptions and nothing more.
 *
 * `'unsafe-inline'` in `script-src` covers the theme bootstrap in index.html and
 * the small inline handlers on the standalone pages. It is not load-bearing for
 * XSS defence here — the app has no HTML-injection sink (no
 * `dangerouslySetInnerHTML`, and react-markdown escapes raw HTML) — the value of
 * these headers is `frame-ancestors`, `frame-src`, `base-uri` and `form-action`.
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
    'cache-control': 'private, no-store',
    ...BASE_HEADERS,
    'content-security-policy': PUBLIC_PAGE_CSP,
  };
}

const LANDING_PAGE_CSP = PUBLIC_PAGE_CSP
  .replace(
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com",
  )
  .replace("img-src 'self' data:", "img-src 'self' data: blob:")
  .concat("; font-src 'self' data: blob:");

/** The supplied standalone landing expands its bundled local assets to blobs. */
export function landingHtmlHeaders() {
  return {
    ...publicHtmlHeaders(),
    'content-security-policy': LANDING_PAGE_CSP,
  };
}

/**
 * CSP for the authenticated SPA.
 *
 * `previewOrigin` is the wildcard the preview hosts live under
 * (`https://*.<PREVIEW_HOST_SUFFIX>`). Naming it explicitly is the
 * browser-enforced half of the preview-origin rule: whatever URL the agent
 * manages to get in front of the app, only a preview host can be framed. Null
 * (previews unconfigured) falls back to `'self'`.
 */
export function appDocumentCsp(url: URL, previewOrigin: string | null): string {
  const frameSrc = previewOrigin ? `'self' ${previewOrigin}` : "'self'";
  return [
    ...BASE_CSP,
    // The chat transport is a WebSocket to this same host. CSP 3 folds ws/wss
    // into 'self', but naming it costs nothing and removes the doubt.
    `connect-src 'self' wss://${url.host}`,
    // Agent output and message attachments carry remote image URLs; images
    // execute nothing.
    "img-src 'self' data: blob: https:",
    // KaTeX's maths fonts, pulled in by `index.css`. Every one of them is over
    // Vite's 4096-byte inline threshold and ships as a hashed asset — except
    // KaTeX_Size3-Regular.woff2 at 3624 bytes, which Vite emits INLINE as
    // `data:font/woff2;base64,…`. With `font-src` unset, `default-src 'self'`
    // applied and the browser refused exactly that one font. `data:` rather
    // than raising the inline threshold: a font is not script, and the app must
    // not depend on a bundler's size cut-off staying on one side of a limit.
    "font-src 'self' data:",
    `frame-src ${frameSrc}`,
  ].join('; ');
}

/**
 * Attach the app document policy to an HTML response. Non-HTML responses
 * (hashed bundles, JSON) are returned untouched — they carry no document.
 */
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
