/**
 * The destination classifier — whether a request's destination is one
 * untrusted code must never reach, as a pure judgment over a hostname.
 *
 * ── The one classifier, and its two enforcement points ───────────
 * Two of them existed. This module judged BACKEND egress
 * (`cf-backend/src/egress/outbound.ts`) while `web/url-safety.ts` judged the
 * agent's OWN fetches, each with its own hand-rolled `parseIPv4` and its own
 * copy of the seven-rule RFC1918 table — and they had drifted, so a fix to
 * one was not a fix to the other: `[::ffff:10.0.0.1]` was refused here and
 * reachable from the web tool, whose IPv6 test was a string-prefix compare.
 * There is now one judgment. `assertSafeUrl` keeps what is genuinely its own
 * (scheme, the secret-exfiltration test, its error type) and calls
 * `refusedHostname` for the host, so both enforcement points refuse exactly
 * the same set.
 *
 * ── Why the judgment is provider-independent ─────────────────────
 * Every input is a standard: the hostname arrives WHATWG-canonical (the URL
 * parser every JS runtime shares), the ranges are IETF address families
 * (RFC1918, RFC4193 ULA, RFC3927 link-local, RFC6598 CGNAT, loopback, the
 * RFC6761 `.localhost` domain, ICANN's private-use `.internal` TLD), and the
 * cloud-metadata names are internet conventions, not platform facts. No
 * transport primitive — Worker, proxy, DNS — appears here. Backends whose
 * egress crosses this module therefore satisfy capability parity: the
 * security policy compiles in core, and each backend owns only the
 * ENFORCEMENT (which request, at which hop, what the refusal becomes on its
 * wire).
 *
 * ── The DNS residual, stated plainly ─────────────────────────────
 * A hostname that RESOLVES to a private address cannot be checked here —
 * resolution is a runtime act this pure module has no access to. The
 * classification is literal-based: dotted-quad IPv4, bracketed IPv6, and the
 * reserved names. A backend with an edge that filters RFC1918 (Workers fetch
 * does) bounds the residual; a backend without one must state its own bound.
 * The residual is real and this module does not claim otherwise.
 *
 * ── What the parser's canonical form already removes ─────────────
 * The WHATWG URL parser canonicalizes the hostname before this code sees it,
 * and its forms collapse the classic obfuscations (each MEASURED under Bun):
 *
 *   `127.1`            → `127.0.0.1`     (fewer than four labels)
 *   `0x7f000001`       → `127.0.0.1`     (hex integer form)
 *   `2130706433`       → `127.0.0.1`     (decimal integer form)
 *   `0177.0.0.1`       → `127.0.0.1`     (legacy octal interpreted)
 *   `[::FFFF:127.0.0.1]` → `[::ffff:7f00:1]` (mapped form, lowercased/compressed)
 *   `[feBF::1]`        → `[febf::1]`     (case)
 *   zone syntax (`fe80::1%eth0`) → the parser THROWS, so no zone form passes
 *
 * So the checks below run on one strict canonical shape per family: dotted
 * quad, or bracketed lowercase compressed IPv6. A bracketed literal that does
 * not re-parse as IPv6 fails closed. A short numeric form (`169.254`, `10.1`)
 * cannot reach the checks from a WHATWG URL — the parser expands the legal
 * ones (measured: `10.1` → `10.0.0.1`, caught by the range checks after
 * expansion) — and one arriving anyway is refused rather than expanded,
 * because permissive expansions disagree about what it addresses.
 *
 * ── How a refusal is shaped ───────────────────────────────────────
 * The answer is the project's refusal payload — `{ reason: ErrorCode, error }`
 * projected by `refusalOf` from a `KinuError` — never a bare string. The
 * enforcing backend turns it into its own wire answer and its own diagnostic,
 * so the classification travels in the shape every reader already parses.
 */

import { refusalOf, KinuError, type Refusal } from '../obs/error';

/**
 * Hostnames refused unconditionally: the cloud-metadata authorities and the
 * bare loopback name. `*.localhost` is refused by suffix below; a trailing
 * dot is stripped first because the URL parser keeps it and the two spellings
 * address the same host.
 */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'localhost',
]);

/**
 * Parse a canonical dotted-quad into its four octets, or null when the
 * hostname is not exactly four decimal labels in 0..255. The URL parser has
 * already collapsed the shorter/hex/integer spellings, so this is the strict
 * remainder.
 */
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
 * Whether an IPv4 literal addresses a destination untrusted code must never
 * reach: loopback, RFC1918, link-local (including the 169.254.169.254 cloud
 * metadata address), CGNAT 100.64/10, and this-network 0.0.0.0/8 (which some
 * stacks treat as "this host").
 */
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

/**
 * Expand a canonical lowercase compressed IPv6 literal into its eight 16-bit
 * groups, or null when it is not parseable. Handles `::` once, anywhere.
 *
 * The parser has already lowercased and compressed, but it does not expand,
 * and the classifications below (prefix compares, the mapped suffix) need the
 * groups.
 */
function expandIPv6(host: string): readonly number[] | null {
  const sections = host.split('::');
  if (sections.length > 2) return null;
  const head = sections[0] === '' ? [] : sections[0]!.split(':');
  const tail = sections.length === 2
    ? (sections[1] === '' ? [] : sections[1]!.split(':'))
    : [];
  if (sections.length === 1 && head.length !== 8) return null;
  const pieces = [...head, ...tail];
  if (pieces.length > 8) return null;
  const groups = pieces.map((piece) => Number.parseInt(piece, 16));
  if (groups.some((group) => Number.isNaN(group))) return null;
  if (sections.length === 2) {
    // `::` fills IN PLACE: the head groups keep their positions at the front
    // and the zeros go between head and tail. Prepending them would move the
    // head to the tail and turn `fe80::a` into `::a:fe80` — a different
    // address in a public family, which a prefix check would then miss.
    const missing = 8 - pieces.length;
    if (missing < 1) return null;
    return [...groups.slice(0, head.length), ...Array.from({ length: missing }, () => 0), ...groups.slice(head.length)];
  }
  return groups;
}

/**
 * Whether an IPv6 literal addresses a refused destination. Group form:
 * canonical, lowercase, expanded to eight groups.
 *
 * Refused families:
 *   ::1          loopback
 *   ::           unspecified
 *   fe80::/10    link-local
 *   fc00::/7     unique-local (RFC4193 ULA — private fabric addresses)
 *   ::ffff:0:0/96  IPv4-mapped — classified by the embedded IPv4, which the
 *                  canonical form has already compressed to `::ffff:7f00:1`
 *                  style groups, so the last two groups ARE the IPv4 address
 *   ::/96        IPv4-compatible (deprecated) — same embedded-IPv4 rule
 */
function isRefusedIPv6(groups: readonly number[]): boolean {
  // `::1` expands to seven zero groups then 1 — the LAST group carries it.
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups[0]! >= 0xfe80 && groups[0]! <= 0xfebf) return true; // fe80::/10
  if (groups[0]! >= 0xfc00 && groups[0]! <= 0xfdff) return true; // fc00::/7 ULA
  // Embedded IPv4: ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible). The
  // first six groups are zero (mapped keeps group 5 = 0xffff), the last two
  // groups are the IPv4 address in 16-bit pieces.
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((g) => g === 0);
  if (mapped || compatible) {
    // The two tail groups are the embedded IPv4 in 16-bit pieces; both carry
    // one octet pair, so the four octets are split out of them exactly.
    const high = groups[6]!;
    const low = groups[7]!;
    return isRefusedIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return false;
}

/**
 * Judge one WHATWG-canonical hostname — the module's only entry point. Answers
 * the project's refusal payload when untrusted code must not reach it, and null
 * when it may.
 *
 * A hostname rather than a URL, because the hostname is the whole input: a
 * URL-shaped wrapper over this call added a second name for one judgment and
 * hid nothing. Callers holding a URL pass `url.hostname`.
 *
 * The DNS residual is NOT closed here and is not claimed to be: a hostname
 * that RESOLVES to a private address cannot be checked without resolution,
 * which this module deliberately has none of. See the module comment.
 */
export function refusedHostname(hostname: string): Refusal | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return refusalOf(new KinuError('denied', 'the request names no host, so it cannot be judged'));

  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (BLOCKED_HOSTNAMES.has(bare)) {
    return refusalOf(new KinuError('denied', `blocked internal host: ${bare}`));
  }
  // `foo.localhost` resolves to loopback on every conforming stack (RFC 6761).
  // `.internal` is ICANN's reserved private-use TLD (delegated to no registry,
  // resolvable only inside a private network) and is what the cloud-metadata
  // authorities already sit under, so a name there addresses someone's
  // internal fabric by definition. Carried over from the web guard, which
  // refused this suffix when the two classifiers were separate.
  if (host.endsWith('.localhost') || host.endsWith('.internal')) {
    return refusalOf(new KinuError('denied', `blocked internal host: ${host}`));
  }

  if (host.startsWith('[')) {
    // Fail closed: a bracketed literal that does not re-parse as IPv6 is not
    // judged, so it does not leave.
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
  // A numeric form that is not a full dotted quad never leaves as a name. The
  // WHATWG parser expands the legal ones before this code runs (measured:
  // `127.1`, `2130706433`, `0x7f000001` all arrive as `127.0.0.1`), so one
  // arriving short did not come from a URL parser — and permissive expansions
  // disagree about what it addresses (`169.254` is `169.254.0.0` to one and
  // `0.0.169.254` to another). Fail closed rather than guess.
  if (ipv4 === null && /^\d+(\.\d+)*$/.test(host)) {
    return refusalOf(new KinuError('denied', `blocked unparseable IPv4 literal: ${host}`));
  }
  return null;
}
