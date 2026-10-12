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

function isRefusedIPv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — this network

  if (a === 10) return true; // 10.0.0.0/8 — RFC1918

  if (a === 127) return true; // 127.0.0.0/8 — loopback

  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, incl. metadata

  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — RFC1918

  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — RFC1918

  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT

  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 IETF assignments, 192.0.2.0/24 docs

  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking

  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return true; // documentation

  return a >= 224; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved and broadcast
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

/**
 * Refuses loopback, unspecified, link-local, site-local, ULA, multicast, discard and documentation addresses, and any
 * that carries a refused IPv4 a gateway would reach: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64
 * (64:ff9b::a.b.c.d; its local-use 64:ff9b:1::/48 whole), 6to4 (2002:aabb:ccdd::) and Teredo (server and client).
 */
function isRefusedIPv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (groups.slice(0, 7).every((g) => g === 0) && g7 <= 1) return true; // :: and ::1

  if (g0 >= 0xfe80 && g0 <= 0xfeff) return true; // fe80::/10 link-local, fec0::/10 site-local

  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true; // fc00::/7 ULA

  if (g0 >= 0xff00) return true; // ff00::/8 multicast

  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard

  if (g0 === 0x2001 && g1 === 0xdb8) return true; // 2001:db8::/32 documentation

  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64

  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isRefusedIPv4(embeddedIPv4(g6, g7));

  if (g0 === 0x2002) return isRefusedIPv4(embeddedIPv4(g1, g2));

  // Teredo carries its server, and its client with every bit inverted.
  if (g0 === 0x2001 && g1 === 0) return isRefusedIPv4(embeddedIPv4(g2, g3)) || isRefusedIPv4(embeddedIPv4(~g6 & 0xffff, ~g7 & 0xffff));
  const mapped = groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff;
  const compatible = groups.slice(0, 6).every((g) => g === 0);

  return (mapped || compatible) && isRefusedIPv4(embeddedIPv4(g6, g7));
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
