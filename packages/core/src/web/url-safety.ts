/**
 * SSRF + secret-exfiltration guards for outbound web fetches.
 *
 * A malicious prompt, page, or skill can try to make the agent fetch internal
 * resources (cloud metadata at 169.254.169.254, localhost services, private
 * hosts) or smuggle a stored credential out inside a URL. Both network paths
 * (search-result expansion, fetch) run every target through `assertSafeUrl`
 * before a single byte leaves the runtime.
 *
 * Ported from hermes-agent/tools/url_safety.py, adapted for the Workers/Bun
 * runtime: there is NO DNS resolution here (Workers has no `dns`/socket
 * primitive and resolution would be a TOCTOU vector anyway), so the check is
 * scheme + hostname + IP-literal based. A hostname that resolves to a private
 * IP at the edge is not caught at pre-flight — Cloudflare's egress already
 * blocks RFC1918 from Workers `fetch`, so the literal/metadata guard is the
 * meaningful pre-flight layer. Fails closed on any parse error.
 */

/** Cloud-metadata + internal hostnames blocked unconditionally. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'localhost',
]);

/** API-key / token prefixes — if a target URL contains one, it is almost
 *  certainly an exfiltration attempt. Mirrors hermes-agent/agent/redact.py. */
const SECRET_PREFIX_RE =
  /(sk-[A-Za-z0-9_-]{10,}|sk_[A-Za-z0-9_]{10,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/;

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'UnsafeUrlError';
  }
}

/** Parse an IPv4 dotted-quad into its four octets, or null. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const first = m[1];
  const second = m[2];
  const third = m[3];
  const fourth = m[4];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return null;
  const octets: [number, number, number, number] = [
    Number(first), Number(second), Number(third), Number(fourth),
  ];
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** Private / link-local / loopback / CGNAT IPv4 ranges that must never be a
 *  fetch target from the agent. */
function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true; // 0.0.0.0/8
  return false;
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
  } catch {
    throw new UnsafeUrlError(`not a valid URL: ${url}`);
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UnsafeUrlError(`unsupported URL scheme: ${scheme || '<empty>'}`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new UnsafeUrlError('URL has no hostname');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError(`blocked internal hostname: ${hostname}`);
  }
  if (hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    throw new UnsafeUrlError(`blocked internal hostname: ${hostname}`);
  }

  const ipv4 = parseIPv4(hostname);
  if (ipv4 && isPrivateIPv4(ipv4)) {
    throw new UnsafeUrlError(`blocked private/internal address: ${hostname}`);
  }
  // Bracketed IPv6 literals: block loopback (::1) and any link-local (fe80::).
  if (parsed.hostname.startsWith('[')) {
    const v6 = parsed.hostname.slice(1, -1).toLowerCase();
    if (v6 === '::1' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) {
      throw new UnsafeUrlError(`blocked private/internal IPv6 address: ${v6}`);
    }
    if (v6.includes('169.254.') || v6.includes('::ffff:127.')) {
      throw new UnsafeUrlError(`blocked private/internal IPv6 address: ${v6}`);
    }
  }

  return parsed;
}

/** True when the URL is safe — non-throwing form for filtering lists. */
export function isSafeUrl(url: string): boolean {
  try {
    assertSafeUrl(url);
    return true;
  } catch {
    return false;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
