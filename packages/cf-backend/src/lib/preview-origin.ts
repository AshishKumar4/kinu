import { parseNimbusPreviewLabel } from './nimbus-preview-host';
import * as v from 'valibot';

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
 * `proxyToSandbox` routes it back — so Kinu derives no hostnames itself.
 * Everything under the suffix except the app's own host serves previews and
 * nothing else: no SPA, no login, no OAuth callback, so no session cookie is
 * ever minted there for hostile HTML to steal, and `__Host-`-prefixed cookies
 * are host-only so the app's session is never sent to a preview either.
 *
 * Nimbus uses the same trust boundary with its own capability-host shape.
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
 * same-origin content, which is why every preview gets a distinct hostname:
 * the app, its localStorage, and every other preview are different origins.
 * Cookie-site isolation additionally requires PREVIEW_HOST_SUFFIX itself to be
 * a Public Suffix List boundary; see the deployment configuration prerequisite.
 */
export const PREVIEW_SANDBOX = [...PREVIEW_SANDBOX_TOKENS, 'allow-same-origin'].join(' ');

interface PreviewHostEnv {
  PREVIEW_HOST_SUFFIX?: string;
  CLI_PUBLIC_ORIGIN?: string;
}

const PREVIEW_SUFFIX_META = 'proteus-preview-host-suffix';

/** The host an origin var names, lowercased, or null when it names none. */
export function hostOf(origin: string | undefined): string | null {
  if (!origin || !URL.canParse(origin)) return null;
  return new URL(origin).hostname.toLowerCase() || null;
}

/**
 * The zone previews are served under, or null when previews are not
 * configured. Requires a dot: a single-label suffix would claim a whole TLD
 * and take the app down with it.
 */
export function previewHostSuffix(env: PreviewHostEnv): string | null {
  const suffix = env.PREVIEW_HOST_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!suffix || !suffix.includes('.')
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(suffix)
    || suffix.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    return null;
  }
  return suffix;
}

export function previewSuffixMetaName(): string {
  return PREVIEW_SUFFIX_META;
}

function browserPreviewHostSuffix(): string | null {
  if (globalThis.document === undefined) return null;
  const configured = globalThis.document.querySelector<HTMLMetaElement>(`meta[name="${PREVIEW_SUFFIX_META}"]`)?.content;
  return previewHostSuffix({ PREVIEW_HOST_SUFFIX: configured });
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
 * Pin a preview response to its isolated origin and reject server-supplied
 * Domain cookies.
 *
 * Host-only cookies are kept, which is what makes a previewed SPA's login
 * work. A `Domain=` cookie would span the whole suffix and reach other
 * previews, so it is dropped. This cannot intercept JavaScript's
 * `document.cookie`; complete cookie isolation also needs a PSL-backed suffix.
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
export function containPreviewResponse(response: Response): Response {
  if (response.status === 101) return response;
  const keptCookies = response.headers.getSetCookie().filter(c => !/;\s*domain\s*=/i.test(c));

  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const cookie of keptCookies) headers.append('set-cookie', cookie);
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.set('content-security-policy', `sandbox ${PREVIEW_SANDBOX}`);
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** `<port>-<sandbox-id>-<token>` — the SDK's preview hostname label. */
const PREVIEW_HOST_LABEL = /^(\d{1,5})-[a-z0-9][a-z0-9-]*-[a-z0-9_]+$/i;

function validPort(value: string | undefined): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Whether a URL is a preview URL this app is willing to frame: an absolute
 * https URL whose leading hostname label is a complete
 * `<port>-<sandbox>-<token>` triple. Host allow-listing is the CSP's job
 * (`frame-src`), because only the server knows the configured suffix; this
 * rejects the shapes that never come from Kinu at all.
 */
export function isPreviewUrl(value: string, configuredSuffix: string | null = browserPreviewHostSuffix()): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:') return false;
  const suffix = previewHostSuffix({ PREVIEW_HOST_SUFFIX: configuredSuffix ?? undefined });
  if (!suffix) return false;
  const host = url.hostname.toLowerCase();
  const suffixWithDot = `.${suffix}`;
  if (!host.endsWith(suffixWithDot)) return false;
  const label = host.slice(0, -suffixWithDot.length);
  if (!label || label.includes('.')) return false;
  const sandbox = PREVIEW_HOST_LABEL.exec(label);
  return (sandbox !== null && validPort(sandbox[1])) || parseNimbusPreviewLabel(label) !== null;
}

/**
 * Pull a preview URL out of a tool result. Outputs are usually strings (e.g.
 * `https://8080-proteus-app-p8080_ab12cd34.example.com/`) but can also be
 * objects with a `url` field.
 *
 * The text being scanned is agent-writable — a command's stdout is a tool result
 * too — so candidates are parsed and checked against `isPreviewUrl` rather than
 * pattern-matched out of the surrounding prose.
 */
export function extractPreviewUrl<Output>(
  output: Output,
  configuredSuffix: string | null = browserPreviewHostSuffix(),
): string | null {
  const scan = (text: string): string | null =>
    (text.match(/https?:\/\/[^\s"'<>\\)]+/gi) ?? [])
      .find((url) => isPreviewUrl(url, configuredSuffix)) ?? null;

  if (v.is(v.string(), output)) return scan(output);
  const withUrl = v.safeParse(v.object({ url: v.string() }), output);
  if (withUrl.success) return scan(withUrl.output.url);
  const serialized = JSON.stringify(output);
  return serialized === undefined ? null : scan(serialized);
}
