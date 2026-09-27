/**
 * SSRF and secret-exfiltration guards for outbound web fetches. The destination judgment lives in
 * `safety/egress-destination.ts` and must not be duplicated here. {@link assertSafeUrl} judges scheme, hostname and
 * IP literal, failing closed on any parse error; {@link refusedResolution} judges the addresses a name resolves
 * to, where the backend can resolve (the CLI). A Worker cannot, and needs not: measured 2026-09-27 on a deployed
 * Worker, a fetch of a public name resolving to 127.0.0.1, 10/8, 192.168/16 or 169.254.169.254 answered the
 * platform's 403 `error code: 1002` and connected nowhere (docs/CRAFT-ARCHITECTURE.md, "Names that resolve inward").
 */

import { refusedHostname } from '../safety/egress-destination';

/** Mirrors hermes-agent/agent/redact.py. */
const SECRET_PREFIX_RE =
  /(sk-[A-Za-z0-9_-]{10,}|sk_[A-Za-z0-9_]{10,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/;

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'UnsafeUrlError';
  }
}

/** Throws {@link UnsafeUrlError} for a private/internal target, non-http(s) scheme, or smuggled secret. */
export function assertSafeUrl(url: string): URL {
  if (SECRET_PREFIX_RE.test(url) || SECRET_PREFIX_RE.test(safeDecode(url))) {
    throw new UnsafeUrlError(
      'URL contains what appears to be an API key or token: secrets must not be sent in URLs',
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch (error) {
    throw new UnsafeUrlError(`not a valid URL: ${url}`, { cause: error });
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();

  if (scheme !== 'http' && scheme !== 'https') {
    throw new UnsafeUrlError(`unsupported URL scheme: ${scheme || '<empty>'}`);
  }

  // `parsed.hostname` is the WHATWG-canonical form the classifier expects.
  const refusal = refusedHostname(parsed.hostname);

  if (refusal) throw new UnsafeUrlError(refusal.error);

  return parsed;
}

/** Every address a hostname resolves to, as the OS resolver answers it. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/** An address as the classifier reads it: WHATWG-canonical, IPv6 bracketed; null when it does not parse. */
function canonicalAddress(address: string): string | null {
  const url = `http://${address.includes(':') ? `[${address}]` : address}/`;

  return URL.canParse(url) ? new URL(url).hostname : null;
}

/**
 * Why `url`'s name may not be fetched, from the addresses it resolves to; null when every one may be. The fetch that
 * follows resolves again, so a name that changes its answer in between (DNS rebinding) is not caught here.
 */
export async function refusedResolution(url: URL, resolve: HostResolver): Promise<string | null> {
  const host = url.hostname;

  // An address literal was judged by assertSafeUrl and resolves to itself.
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;

  for (const address of await resolve(host)) {
    const canonical = canonicalAddress(address);
    const refusal = canonical === null ? `an unparseable address ${address}` : refusedHostname(canonical)?.error;

    if (refusal !== undefined) return `${host} resolves to ${address}: ${refusal}`;
  }

  return null;
}

/** Only an unsafe URL answers false; any other error is rethrown, never counted as a pass. */
export function isSafeUrl(url: string): boolean {
  try {
    assertSafeUrl(url);

    return true;
  } catch (error) {
    if (!(error instanceof UnsafeUrlError)) throw error;

    return false;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch (error) {
    // A malformed escape is expected here and outside classify's closed set.
    if (!(error instanceof URIError)) throw error;

    return s;
  }
}
