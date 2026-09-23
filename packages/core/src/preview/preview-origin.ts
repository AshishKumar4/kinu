import { parseWorkspacePreviewLabel } from './nimbus-preview-host';
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';

// Declared locally so this compiles with and without DOM libs; undefined server-side.
declare const document: {
  querySelector(selectors: string): { content: string } | null;
} | undefined;

// Previewed apps are hostile HTML, so each gets its own host under PREVIEW_HOST_SUFFIX, where no session
// cookie is ever minted. The CSP header and iframe attribute share these tokens (new tabs lack the attribute).
const PREVIEW_SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-forms',
  'allow-popups',
  'allow-modals',
  'allow-downloads',
];

/** `allow-same-origin` is safe only because every preview has a distinct hostname; cookie isolation
 *  also needs PREVIEW_HOST_SUFFIX to be a Public Suffix List boundary. */
export const PREVIEW_SANDBOX = [...PREVIEW_SANDBOX_TOKENS, 'allow-same-origin'].join(' ');

export interface PreviewSuffixEnv {
  PREVIEW_HOST_SUFFIX?: string;
}

export interface PreviewPortEnv {
  PREVIEW_HOST_PORT?: string;
}

/** The app's own origin is the one host under the suffix that is never preview territory. */
export interface PreviewHostEnv extends PreviewSuffixEnv {
  CLI_PUBLIC_ORIGIN?: string;
}

const PREVIEW_SUFFIX_META = 'kinu-preview-host-suffix';

export function hostOf(origin: string | undefined): string | null {
  if (!origin || !URL.canParse(origin)) return null;

  return new URL(origin).hostname.toLowerCase() || null;
}

/** Requires a dot: a single-label suffix would claim a whole TLD. */
export function previewHostSuffix(env: PreviewSuffixEnv): string | null {
  const suffix = env.PREVIEW_HOST_SUFFIX?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');

  if (!suffix || !suffix.includes('.')
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(suffix)
    || suffix.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    return null;
  }

  return suffix;
}

export function previewPortSuffix(env: PreviewPortEnv): string {
  const port = Number(env.PREVIEW_HOST_PORT);

  return validPort(env.PREVIEW_HOST_PORT) && port !== 443 ? `:${String(port)}` : '';
}

export function previewSuffixMetaName(): string {
  return PREVIEW_SUFFIX_META;
}

function browserPreviewHostSuffix(): string | null {
  if (!('document' in globalThis) || document === undefined) return null;
  const configured = document.querySelector(`meta[name="${PREVIEW_SUFFIX_META}"]`)?.content;

  return previewHostSuffix({ PREVIEW_HOST_SUFFIX: configured });
}

/** Claims the whole subtree, not just well-formed preview hosts, so strays get a 404, never the app. */
export function isPreviewHostRequest(url: URL, env: PreviewHostEnv): boolean {
  const suffix = previewHostSuffix(env);

  if (!suffix) return false;
  const host = url.hostname.toLowerCase();

  if (host === hostOf(env.CLI_PUBLIC_ORIGIN)) return false;

  return host.endsWith(`.${suffix}`);
}

/** Drops `Domain=` cookies (they would reach other previews), replaces CSP, and suppresses Referer because
 *  the hostname carries the port token. 101 responses have immutable headers and pass through. */
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

// Greedy middle matches the SDK's `extractSandboxRoute` split (first hyphen, last hyphen) for hyphenated ids.
const PREVIEW_HOST_LABEL = /^(\d{1,5})-([a-z0-9][a-z0-9-]*)-([a-z0-9_]+)$/i;

function validPort(value: string | undefined): boolean {
  const port = Number(value);

  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Shape check only; host allow-listing is the CSP `frame-src` job. */
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

  return (sandbox !== null && validPort(sandbox[1])) || parseWorkspacePreviewLabel(label) !== null;
}

/** Must segment exactly as `proxyToSandbox` does, so `getSandbox(ns, id, { normalizeId: true })` addresses
 *  the same object that answered the request. */
export interface SandboxPreviewLabel {
  readonly port: number;
  readonly sandboxId: string;
  readonly token: string;
}

export function sandboxPreviewLabelOf(url: URL, env: PreviewSuffixEnv): SandboxPreviewLabel | null {
  const suffix = previewHostSuffix(env);

  if (!suffix) return null;
  const host = url.hostname.toLowerCase();
  const suffixWithDot = `.${suffix}`;

  if (!host.endsWith(suffixWithDot)) return null;
  const label = host.slice(0, -suffixWithDot.length);

  if (label.includes('.')) return null;
  const parsed = PREVIEW_HOST_LABEL.exec(label);

  if (parsed === null || !validPort(parsed[1])) return null;
  const [, port, sandboxId, token] = parsed;

  if (port === undefined || sandboxId === undefined || token === undefined) return null;

  return { port: Number(port), sandboxId, token };
}

/** Tool output is agent-writable, so each candidate is validated with `isPreviewUrl`. */
export function extractPreviewUrl(
  output: JsonValue | undefined,
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
