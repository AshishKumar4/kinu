/**
 * Pure hostname classifier for destinations untrusted code must never reach. Shared by backend
 * egress (`cf-backend/src/egress/outbound.ts`) and `assertSafeUrl` so both refuse the same set.
 * A host is judged in its WHATWG-canonical form, which `egressHost` makes of any spelling a program
 * gives a socket and answers, so what is reached is what was judged; a name that resolves to a
 * private address is not caught here; see `web/url-safety.ts`.
 */

import { refusalOf, KinuError, type Refusal } from '../obs/error';

/** Cloud-metadata names and bare loopback; a trailing dot is stripped before lookup. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'localhost',
]);

/** Strict four-label decimal dotted quad, or null. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const labels = host.split('.');

  if (labels.length !== 4) return null;
  const octets: [number, number, number, number] = [0, 0, 0, 0];

  for (const [index, label] of labels.entries()) {
    if (!/^\d{1,3}$/.test(label)) return null;
    const value = Number(label);

    if (value > 255) return null;
    octets[index] = value;
  }

  return octets;
}

/**
 * The IPv4 ranges untrusted code must never reach, as [base, prefix length]: this network, RFC1918, CGNAT, loopback,
 * link-local (the metadata address among it), IETF protocol assignments, documentation, benchmarking, and everything
 * from 224 up (multicast, reserved, broadcast).
 */
const REFUSED_IPV4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 3],
];

function isRefusedIPv4([a, b, c, d]: [number, number, number, number]): boolean {
  const address = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;

  return REFUSED_IPV4.some(([base, bits]) => address >>> (32 - bits) === base >>> (32 - bits));
}

/** Expand a canonical compressed IPv6 literal to eight groups, or null. */
function expandIPv6(host: string): readonly number[] | null {
  const sections = host.split('::');

  if (sections.length > 2) return null;
  const head = sections[0] === '' ? [] : sections[0].split(':');
  const after = sections.at(1);
  const tail = after === undefined || after === '' ? [] : after.split(':');
  const pieces = [...head, ...tail];
  // A dotted IPv4 may end the address (`::ffff:127.0.0.1`, as written outside a URL): its two groups.
  const dotted = pieces.at(-1)?.includes('.') === true ? parseIPv4(pieces.at(-1) ?? '') : null;

  // Only the last group may be dotted: before a `::` (`1.2.3.4::`) it is no address.
  if (pieces.at(-1)?.includes('.') === true && (dotted === null || (sections.length === 2 && tail.length === 0))) return null;
  const hex = dotted === null ? pieces : pieces.slice(0, -1);

  // Each group is one to four hex digits, whole: `parseInt` would read `12zz` as 0x12.
  if (hex.some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) return null;

  const groups = [...hex.map((piece) => Number.parseInt(piece, 16)), ...(dotted === null ? [] : [dotted[0] * 256 + dotted[1], dotted[2] * 256 + dotted[3]])];

  if (sections.length === 1) return groups.length === 8 ? groups : null;

  // Zeros go between head and tail; prepending would turn `fe80::a` into `::a:fe80`.
  const missing = 8 - groups.length;

  if (missing < 1) return null;

  return [...groups.slice(0, head.length), ...Array.from({ length: missing }, () => 0), ...groups.slice(head.length)];
}

/** The IPv4 address two groups carry. */
function embeddedIPv4(high: number, low: number): [number, number, number, number] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** Whether `groups` start with the first `bits` bits of `prefix` (its groups, zeros after). */
function inPrefix(groups: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 16) {
    const take = Math.min(16, bits - bit);
    const shift = 16 - take;

    if (((groups[bit / 16] ?? 0) >> shift) !== ((prefix[bit / 16] ?? 0) >> shift)) return false;
  }

  return true;
}

/**
 * IPv6 ranges refused whole, as [groups, prefix length]: link-local and site-local (fe80::/9), ULA (fc00::/7),
 * multicast (ff00::/8), discard (100::/64), documentation (2001:db8::/32) and local-use NAT64 (64:ff9b:1::/48).
 */
const REFUSED_IPV6: readonly (readonly [readonly number[], number])[] = [
  [[0xfe80], 9], [[0xfc00], 7], [[0xff00], 8], [[0x100], 64], [[0x2001, 0xdb8], 32], [[0x64, 0xff9b, 1], 48],
];

/**
 * IPv6 ranges that carry an IPv4 a gateway reaches, judged by it, as [groups, prefix length, the groups holding it]:
 * NAT64 (64:ff9b::/96), 6to4 (2002::/16), mapped (::ffff:0:0/96) and compatible (::/96).
 */
const EMBEDDING_IPV6: readonly (readonly [readonly number[], number, number])[] = [
  [[0x64, 0xff9b], 96, 6], [[0x2002], 16, 1], [[0, 0, 0, 0, 0, 0xffff], 96, 6], [[], 96, 6],
];

/** Refuses loopback, unspecified and the ranges above, and any address carrying a refused IPv4 (Teredo's two included). */
function isRefusedIPv6(groups: readonly number[]): boolean {
  const at = (index: number): number => groups[index] ?? 0;

  if (groups.slice(0, 7).every((group) => group === 0) && at(7) <= 1) return true; // :: and ::1

  if (REFUSED_IPV6.some(([prefix, bits]) => inPrefix(groups, prefix, bits))) return true;

  // Teredo carries its server, and its client with every bit inverted.
  if (inPrefix(groups, [0x2001, 0], 32)) {
    return isRefusedIPv4(embeddedIPv4(at(2), at(3))) || isRefusedIPv4(embeddedIPv4(~at(6) & 0xffff, ~at(7) & 0xffff));
  }

  const carrying = EMBEDDING_IPV6.find(([prefix, bits]) => inPrefix(groups, prefix, bits));

  return carrying !== undefined && isRefusedIPv4(embeddedIPv4(at(carrying[2]), at(carrying[2] + 1)));
}

/**
 * `hostname` as untrusted code gave it to a socket or a TLS target, in the one form it is judged and reached by: its
 * WHATWG-canonical host (lowercase, punycode, IPv4 as a dotted quad, IPv6 compressed and bracketed), or the refusal.
 * An IPv4 written any other way (`0x7f.1`, `012.0.0.1`, `2130706433`) is refused rather than guessed at: resolvers
 * disagree on those spellings, so the address reached would not be the one judged.
 */
export function egressHost(hostname: string): { readonly host: string } | { readonly refusal: Refusal } {
  const written = hostname.toLowerCase().replace(/\.$/, '');
  const bare = written.startsWith('[') && written.endsWith(']') ? written.slice(1, -1) : written;
  const url = `http://${bare.includes(':') ? `[${bare}]` : bare}/`;
  const host = written === '' || !URL.canParse(url) ? null : new URL(url).hostname;

  if (host === null) return { refusal: refusalOf(new KinuError('denied', `blocked unparseable host: ${hostname}`)) };

  if (parseIPv4(host) !== null && host !== bare) {
    return { refusal: refusalOf(new KinuError('denied', `blocked non-canonical IPv4 literal: ${hostname} (${host})`)) };
  }

  const refusal = refusedHostname(host);

  return refusal === null ? { host } : { refusal };
}

/** Refusal payload when untrusted code must not reach `hostname`, a WHATWG-canonical host, else null. */
export function refusedHostname(hostname: string): Refusal | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (!host) return refusalOf(new KinuError('denied', 'the request names no host, so it cannot be judged'));

  const bare = host.startsWith('[') ? host.slice(1, -1) : host;

  if (BLOCKED_HOSTNAMES.has(bare)) {
    return refusalOf(new KinuError('denied', `blocked internal host: ${bare}`));
  }

  // `.localhost` is loopback (RFC 6761); `.internal` is ICANN's private-use TLD.
  if (host.endsWith('.localhost') || host.endsWith('.internal')) {
    return refusalOf(new KinuError('denied', `blocked internal host: ${host}`));
  }

  // A URL brackets an IPv6 literal; a socket's address and a TLS target do not. No hostname holds a colon.
  if (host.startsWith('[') || bare.includes(':')) {
    const groups = expandIPv6(bare);

    if (groups === null) {
      return refusalOf(new KinuError('denied', `blocked unparseable IPv6 literal: ${bare}`));
    }

    if (isRefusedIPv6(groups)) {
      return refusalOf(new KinuError('denied', `blocked private/internal IPv6 address: ${bare}`));
    }

    return null;
  }

  const ipv4 = parseIPv4(host);

  if (ipv4 !== null && isRefusedIPv4(ipv4)) {
    return refusalOf(new KinuError('denied', `blocked private/internal address: ${host}`));
  }

  // Short numeric forms never come from a WHATWG parser and expansions disagree: fail closed.
  if (ipv4 === null && /^\d+(\.\d+)*$/.test(host)) {
    return refusalOf(new KinuError('denied', `blocked unparseable IPv4 literal: ${host}`));
  }

  return null;
}
