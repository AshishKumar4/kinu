/**
 * Pure hostname classifier for destinations untrusted code must never reach. Shared by backend
 * egress (`cf-backend/src/egress/outbound.ts`) and `assertSafeUrl` so both refuse the same set.
 * Literal-based on WHATWG-canonical hostnames; a name that resolves to a private address is not
 * caught here; see `web/url-safety.ts`.
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

function isRefusedIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — this network

  if (a === 10) return true; // 10.0.0.0/8 — RFC1918

  if (a === 127) return true; // 127.0.0.0/8 — loopback

  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local, incl. metadata

  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — RFC1918

  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — RFC1918

  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT

  return false;
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

/** Refuses loopback, unspecified, link-local, ULA, and IPv4-mapped/compatible by embedded IPv4. */
function isRefusedIPv6(groups: readonly number[]): boolean {
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  if (groups.every((g) => g === 0)) return true; // ::

  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return true; // fe80::/10

  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return true; // fc00::/7 ULA
  // Embedded IPv4: mapped (::ffff:a.b.c.d) or compatible (::a.b.c.d).
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((g) => g === 0);

  if (mapped || compatible) {
    const high = groups[6];
    const low = groups[7];

    return isRefusedIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }

  return false;
}

/** Refusal payload when untrusted code must not reach `hostname`, else null. */
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
