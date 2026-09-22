/**
 * SSRF and secret-exfiltration guards for outbound web fetches. The destination judgment lives in
 * `safety/egress-destination.ts` and must not be duplicated here. No DNS resolution (TOCTOU; none on Workers):
 * checks are scheme + hostname + IP literal, failing closed on any parse error.
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
      'URL contains what appears to be an API key or token — secrets must not be sent in URLs',
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
