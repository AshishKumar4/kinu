/**
 * SSRF + secret-exfiltration guards for outbound web fetches.
 *
 * A malicious prompt, page, or skill can try to make the agent fetch internal
 * resources (cloud metadata at 169.254.169.254, localhost services, private
 * hosts) or smuggle a stored credential out inside a URL. Both network paths
 * (search-result expansion, fetch) run every target through `assertSafeUrl`
 * before a single byte leaves the runtime.
 *
 * ── What is this module's own, and what is not ───────────────────
 * Its own: the scheme restriction, the secret-prefix exfiltration test, and
 * `UnsafeUrlError` — the throwing shape the web provider catches. NOT its
 * own: whether a host is a destination untrusted code must never reach. That
 * is one judgment for the whole project and it lives in
 * `safety/egress-destination.ts`, which the backend's egress hop also calls.
 *
 * This module used to answer it a second time, with its own `parseIPv4` and
 * its own copy of the RFC1918 table, and the copies had drifted: the IPv6
 * test here was a string-prefix compare, so `[::ffff:10.0.0.1]` — the mapped
 * spelling of an RFC1918 address — passed the agent's guard while the
 * backend's refused it. Delegating removes the second answer, so a range
 * added to the classifier binds the agent's own fetches too.
 *
 * Ported from hermes-agent/tools/url_safety.py, adapted for the Workers/Bun
 * runtime: there is NO DNS resolution here (Workers has no `dns`/socket
 * primitive and resolution would be a TOCTOU vector anyway), so the check is
 * scheme + hostname + IP-literal based. A hostname that resolves to a private
 * IP at the edge is not caught at pre-flight — Cloudflare's egress already
 * blocks RFC1918 from Workers `fetch`, so the literal/metadata guard is the
 * meaningful pre-flight layer. Fails closed on any parse error.
 */

import { refusedHostname } from '../safety/egress-destination';

/** API-key / token prefixes — if a target URL contains one, it is almost
 *  certainly an exfiltration attempt. Mirrors hermes-agent/agent/redact.py. */
const SECRET_PREFIX_RE =
  /(sk-[A-Za-z0-9_-]{10,}|sk_[A-Za-z0-9_]{10,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/;

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'UnsafeUrlError';
  }
}

/** Throws {@link UnsafeUrlError} when `url` targets a private/internal address,
 *  uses a non-http(s) scheme, or smuggles a secret. Returns the parsed URL. */
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

  // The one destination judgment. `parsed.hostname` is the WHATWG-canonical
  // form the classifier documents as its input, brackets and all. Its refusal
  // payload carries the rendered cause chain, which is exactly the prose this
  // module's error type wants as its reason.
  const refusal = refusedHostname(parsed.hostname);
  if (refusal) throw new UnsafeUrlError(refusal.error);

  return parsed;
}

/** True when the URL is safe — non-throwing form for filtering lists. Only an
 *  unsafe URL answers false: anything else `assertSafeUrl` could raise is a bug
 *  in this module, and swallowing it would mark a broken check as a pass. */
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
    // decodeURIComponent fails only on a malformed escape — expected here, and
    // unnamed by classify's closed set, so the expected failure is named locally.
    if (!(error instanceof URIError)) throw error;
    return s;
  }
}
