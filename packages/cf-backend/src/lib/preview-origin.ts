/**
 * Where previewed apps are served, and what they are allowed to do.
 *
 * A previewed app is HTML the agent wrote, and agents read repositories, web
 * pages and email — so it is hostile input. Served on the app's own origin it
 * runs *as* the app: it can call `/api/user/*` with the owner's session cookie,
 * read the owner's credentials, and reach into the parent frame.
 *
 * Sandbox-container previews therefore get a host of their own, one per
 * exposed port: `<port>-<sandbox>-<token>.<PREVIEW_HOST_SUFFIX>`. That is the
 * @cloudflare/sandbox SDK's native scheme — `exposePort` mints the URL and
 * `proxyToSandbox` routes it back — so Proteus derives no hostnames itself.
 * Everything under the suffix except the app's own host serves previews and
 * nothing else: no SPA, no login, no OAuth callback, so no session cookie is
 * ever minted there for hostile HTML to steal, and `__Host-`-prefixed cookies
 * are host-only so the app's session is never sent to a preview either.
 *
 * Two containment levels, because Proteus has two preview surfaces:
 *
 *   'own-host'  — sandbox containers, on their per-port hostname above. Each
 *                 preview is its own origin, isolated from the app *and* from
 *                 every other preview, so the document keeps that origin and
 *                 previewed apps work normally (storage, same-origin fetch).
 *
 *   'app-host'  — Nimbus session content under `/_nimbus/…`, which is fetched
 *                 with the owner's session (its tenant check needs it) and so
 *                 cannot move off the app's origin. Pinned to an opaque origin
 *                 instead: that is the only thing standing between it and the
 *                 owner's session.
 *
 * The pin is a response header, not just the iframe `sandbox` attribute: users
 * open preview URLs in new tabs, where the attribute does not exist. The
 * attribute and the header are built from the same token list so the two
 * cannot drift.
 */

/** What a previewed app may do, wherever it is served. */
const PREVIEW_SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-modals',
  'allow-downloads',
];

/**
 * Sandbox tokens for a preview on its own hostname — the `sandbox` iframe
 * attribute and the CSP `sandbox` directive's argument.
 *
 * `allow-same-origin` is present here and only here. It voids the sandbox for
 * same-origin content, which is safe exactly when "same origin" means one
 * sandbox's own port and nothing else: the app is a different host, and every
 * other preview is a different host too, because the port, the sandbox id and
 * the port's secret token are all in this one's hostname.
 */
export const PREVIEW_SANDBOX = [...PREVIEW_SANDBOX_TOKENS, 'allow-same-origin'].join(' ');

/**
 * Sandbox tokens for preview content served on the app's own origin. No
 * `allow-same-origin`: with it the document would run *as* the app.
 */
const APP_HOST_SANDBOX = PREVIEW_SANDBOX_TOKENS.join(' ');

interface PreviewHostEnv {
  PREVIEW_HOST_SUFFIX?: string;
  CLI_PUBLIC_ORIGIN?: string;
}

function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try { return new URL(origin).hostname.toLowerCase() || null; } catch { return null; }
}

/**
 * The zone previews are served under, or null when previews are not
 * configured. Requires a dot: a single-label suffix would claim a whole TLD
 * and take the app down with it.
 */
export function previewHostSuffix(env: PreviewHostEnv): string | null {
  const suffix = env.PREVIEW_HOST_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!suffix || !suffix.includes('.')) return null;
  return suffix === hostOf(env.CLI_PUBLIC_ORIGIN) ? null : suffix;
}

/**
 * True when this request arrived on preview territory: any host under the
 * suffix other than the app's own. The whole subtree is claimed, not just
 * well-formed preview hostnames — a request that lands here and does not
 * resolve to an exposed port gets a 404, never the app.
 */
export function isPreviewHostRequest(url: URL, env: PreviewHostEnv): boolean {
  const suffix = previewHostSuffix(env);
  if (!suffix) return false;
  const host = url.hostname.toLowerCase();
  if (host === hostOf(env.CLI_PUBLIC_ORIGIN)) return false;
  return host.endsWith(`.${suffix}`);
}

/**
 * Pin a preview response to the origin it is allowed to have, and stop the
 * container from writing cookies outside its own.
 *
 * Cookies: on the app's origin a container `Set-Cookie` could overwrite the
 * session, so all of them are dropped. On its own host a preview's cookies are
 * its own — host-only ones are kept, which is what makes a previewed SPA's
 * login work — but a `Domain=` cookie spans the whole suffix and would be sent
 * to every other preview, so those are dropped.
 *
 * `Referer` is muzzled because the port's secret token is part of the hostname
 * now: the browser's default policy sends the origin cross-origin, and the
 * origin is the credential.
 *
 * Container-supplied CSP headers are replaced rather than merged so the
 * sandbox directive is the one policy in effect. 101 responses are returned
 * untouched — a WebSocket handshake carries no document, and its headers are
 * immutable.
 */
export function containPreviewResponse(response: Response, origin: 'own-host' | 'app-host'): Response {
  if (response.status === 101) return response;
  const ownHost = origin === 'own-host';
  const keptCookies = ownHost
    ? response.headers.getSetCookie().filter(c => !/;\s*domain\s*=/i.test(c))
    : [];

  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const cookie of keptCookies) headers.append('set-cookie', cookie);
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.set('content-security-policy', `sandbox ${ownHost ? PREVIEW_SANDBOX : APP_HOST_SANDBOX}`);
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** `<port>-<sandbox-id>-<token>` — the SDK's preview hostname label. */
const PREVIEW_HOST_LABEL = /^\d{4,5}-[a-z0-9][a-z0-9-]*-[a-z0-9_]+$/i;

/**
 * Whether a URL is a preview URL this app is willing to frame: an absolute
 * https URL whose leading hostname label is a complete
 * `<port>-<sandbox>-<token>` triple. Host allow-listing is the CSP's job
 * (`frame-src`), because only the server knows the configured suffix; this
 * rejects the shapes that never come from Proteus at all.
 */
export function isPreviewUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const dot = url.hostname.indexOf('.');
  if (dot === -1) return false;
  return PREVIEW_HOST_LABEL.test(url.hostname.slice(0, dot));
}

/**
 * Pull a preview URL out of a tool result. Outputs are usually strings (e.g.
 * `https://8080-proteus-app-p8080_ab12cd34.example.com/`) but can also be
 * objects with a `url` field (exposeSandboxPort returns `{url}`).
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
