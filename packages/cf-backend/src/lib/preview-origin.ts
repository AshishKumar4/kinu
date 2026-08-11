/**
 * Where previewed apps are served, and what they are allowed to do.
 *
 * A previewed app is HTML the agent wrote, and agents read repositories, web
 * pages and email — so it is hostile input. Served on the app's own origin it
 * runs *as* the app: it can call `/api/user/*` with the owner's session cookie,
 * read the owner's credentials, and reach into the parent frame. Two rules,
 * enforced here rather than trusted to configuration:
 *
 *   1. Previews live on their own host. `/_preview/*` is served only there, and
 *      when that host differs from the app's own host the Worker serves nothing
 *      else on it — no SPA, no login, no OAuth callback. Nothing ever sets a
 *      session cookie on the preview origin, so there is no session there to
 *      steal. `__Host-`-prefixed cookies are host-only, so the app's session is
 *      never sent to it either.
 *
 *   2. The document is pinned to an opaque origin regardless. Every preview
 *      response carries `Content-Security-Policy: sandbox …` without
 *      `allow-same-origin`, which applies whether the page is framed or opened
 *      directly in a tab — the iframe `sandbox` attribute alone does not, since
 *      users open preview URLs in new tabs. The iframe attribute and the header
 *      are built from the same token list so the two can never drift.
 */

/**
 * What a previewed app may do. `allow-same-origin` is deliberately absent: with
 * it the sandbox is void for same-origin content, and even on a dedicated
 * preview host every sandbox shares that one origin, so one preview could read
 * another's cookies and storage. Previews therefore run opaque-origin: no
 * cookies, no localStorage/IndexedDB, no service worker, and fetches back to
 * their own server are cross-origin (CORS applies).
 */
const PREVIEW_SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-modals',
  'allow-downloads',
];

/** The `sandbox` iframe attribute and the CSP `sandbox` directive's argument. */
export const PREVIEW_SANDBOX = PREVIEW_SANDBOX_TOKENS.join(' ');

/** Path prefix for sandbox-container previews. */
export const PREVIEW_PATH_PREFIX = '/_preview/';

interface PreviewOriginEnv {
  PREVIEW_HOSTNAME?: string;
  CLI_PUBLIC_ORIGIN?: string;
}

function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try { return new URL(origin).host || null; } catch { return null; }
}

/**
 * The preview host when it is a genuinely separate origin from the app — the
 * configuration this module's first rule depends on. Null means previews share
 * the app's origin (or one of the two hosts is unset), in which case previews
 * are still served, but only ever opaque-origin under rule 2.
 */
export function isolatedPreviewHost(env: PreviewOriginEnv): string | null {
  const preview = env.PREVIEW_HOSTNAME?.trim();
  const app = hostOf(env.CLI_PUBLIC_ORIGIN);
  if (!preview || !app) return null;
  return preview.toLowerCase() === app.toLowerCase() ? null : preview;
}

/** True when this request arrived on the isolated preview host, which serves
 *  previews and nothing else. */
export function isPreviewHostRequest(url: URL, env: PreviewOriginEnv): boolean {
  const isolated = isolatedPreviewHost(env);
  return isolated !== null && url.host.toLowerCase() === isolated.toLowerCase();
}

/**
 * Pin a preview response to an opaque origin and drop the container's ability
 * to write cookies on the preview origin.
 *
 * `Set-Cookie` passthrough matters even with rule 1 in place: on the shared
 * preview origin one sandbox could plant a cookie every other sandbox then
 * sends, and without rule 1 a container could overwrite the app's own session
 * cookie. Container-supplied CSP headers are replaced rather than merged so the
 * sandbox directive is the one policy in effect.
 *
 * 101 responses are returned untouched — a WebSocket handshake carries no
 * document, and its headers are immutable.
 */
export function containPreviewResponse(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.set('content-security-policy', `sandbox ${PREVIEW_SANDBOX}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** `/_preview/<port>/<sandbox-id>/<token>` plus any inner path. */
const PREVIEW_ROUTE_PATH = /^\/_preview\/\d{4,5}\/[a-z0-9_-]{1,128}\/[a-z0-9_]{1,63}(\/|$)/i;

/**
 * Whether a URL is a preview URL this app is willing to frame: an absolute
 * https URL whose path is a complete `/_preview/<port>/<sandbox>/<token>/…`
 * route. Host allow-listing is the CSP's job (`frame-src`), because only the
 * server knows the configured preview host; this rejects the shapes that never
 * come from Proteus at all.
 */
export function isPreviewUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return PREVIEW_ROUTE_PATH.test(url.pathname);
}

/**
 * Pull a preview URL out of a tool result. Outputs are usually strings (e.g.
 * `https://…/_preview/8080/…/`) but can also be objects with a `url` field
 * (exposeSandboxPort returns `{url}`).
 *
 * The text being scanned is agent-writable — a command's stdout is a tool result
 * too — so candidates are parsed and checked against `isPreviewUrl` rather than
 * pattern-matched out of the surrounding prose.
 */
export function extractPreviewUrl(output: unknown): string | null {
  const scan = (text: string): string | null =>
    (text.match(/https:\/\/[^\s"'<>\\)]+/gi) ?? []).find(isPreviewUrl) ?? null;

  if (typeof output === 'string') return scan(output);
  if (output && typeof output === 'object') {
    const url = (output as { url?: unknown }).url;
    if (typeof url === 'string') return scan(url);
    try { return scan(JSON.stringify(output)); } catch { return null; }
  }
  return null;
}
