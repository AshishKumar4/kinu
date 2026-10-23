/**
 * Egress gate: a workspace holds random placeholders, never secrets; trusted code substitutes on the way out
 * only toward the secret's hosts, over TLS, and scrubs secrets from anything coming back. Consent is the owner's grant
 * of a secret to a workspace, read by the vault on every request, never per request.
 */

import { Effect } from 'effect';
import * as v from 'valibot';
import { settleSync } from '../obs/effect';

/** Marks a placeholder, so a scan finds one inside any URL or header value and never mistakes a secret for one. */
export const EGRESS_PLACEHOLDER_PREFIX = 'pxs1_';

/** A secret's name: a variable name in every shell and a property in every program, at most 128 characters. */
export function isSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
}

/** Exported for the vault's mint, whose output length the scanner below is the contract over. */
export const PLACEHOLDER_BODY_LENGTH = 43;

/** Finds a placeholder inside a larger string. Non-global so no `lastIndex` state is shared between scans. */
const PLACEHOLDER_BODY = `[A-Za-z0-9_-]{${PLACEHOLDER_BODY_LENGTH}}`;

const PLACEHOLDER_EXACT = new RegExp(`^${EGRESS_PLACEHOLDER_PREFIX}${PLACEHOLDER_BODY}$`);

export function isEgressPlaceholder(value: string): boolean {
  return PLACEHOLDER_EXACT.test(value);
}

/** Every placeholder appearing in `text`, in order, deduplicated. */
export function findEgressPlaceholders(text: string): string[] {
  const scanner = new RegExp(`${EGRESS_PLACEHOLDER_PREFIX}${PLACEHOLDER_BODY}`, 'g');
  const seen = new Set<string>();

  for (const match of text.matchAll(scanner)) seen.add(match[0]);

  return [...seen];
}

/** One secret granted to the asking workspace, without its value, so a binding is safe to log, list, or send. */
export interface EgressSecretBinding {
  /** The owner's name for it, and the variable it appears as. */
  readonly name: string;
  /** Hostnames or `*` globs ({@link egressHostMatches}) it may be sent to. */
  readonly hosts: readonly string[];
  readonly position: SecretPosition;
  readonly placeholder: string;
  /**
   * A connection's credential that a tool sends unasked to every host (Nimbus's git sends `GIT_TOKEN` as Basic with
   * each request): at a host it may not reach, its `Authorization` header is left off and the request goes on, so an
   * anonymous read there still works. An owner's secret sent there is refused.
   */
  readonly elsewhere?: 'withheld';
}

/**
 * Where in a request a secret may be sent: the one place its API reads a credential from, and nowhere an allowed host
 * could store or echo it (a URL path names a stored key; a custom header gets logged). The `Authorization` header by
 * default, a Basic credential in it included; else one named header (`X-API-Key`), or one named query parameter
 * (Google's `?key=`).
 */
export const SecretPositionSchema = v.variant('kind', [
  v.object({ kind: v.literal('authorization') }),
  v.object({ kind: v.literal('header'), name: v.string() }),
  v.object({ kind: v.literal('query'), name: v.string() }),
]);

export type SecretPosition = v.InferOutput<typeof SecretPositionSchema>;

/** Where it goes, in a sentence's words: "the Authorization header", "the X-API-Key header", "the key query parameter". */
export function positionWords(position: SecretPosition): string {
  if (position.kind === 'authorization') return 'the Authorization header';

  return position.kind === 'header' ? `the ${position.name} header` : `the ${position.name} query parameter`;
}

/** The header a position names, lower-cased as a request's header names are compared; null for a query parameter. */
function positionHeader(position: SecretPosition): string | null {
  if (position.kind === 'query') return null;

  return position.kind === 'authorization' ? 'authorization' : position.name.toLowerCase();
}

/** Where `placeholder` appears outside `position`, in words, or null when it is only there. */
function strayPosition(facts: EgressRequestFacts, placeholder: string, position: SecretPosition): string | null {
  const url = URL.parse(facts.url);

  if (url === null) return 'an unparsed URL';

  if (position.kind === 'query') url.searchParams.delete(position.name);

  if (url.href.includes(placeholder)) return position.kind === 'query' ? 'the URL outside that parameter' : 'the URL';

  for (const [name, value] of facts.headers) {
    if (name.toLowerCase() === positionHeader(position)) continue;

    if ((basicCredential(value)?.decoded ?? value).includes(placeholder)) return `the ${name} header`;
  }

  return null;
}

/** Case-insensitive host match; `*` spans any run, pattern anchored at both ends to block suffix tricks. */
export function egressHostMatches(pattern: string, host: string): boolean {
  const target = host.trim().toLowerCase();
  const glob = pattern.trim().toLowerCase();

  if (glob.length === 0 || target.length === 0) return false;

  if (!glob.includes('*')) return glob === target;
  const escaped = glob.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  return new RegExp(`^${escaped.join('.*')}$`).test(target);
}

/** What the adapter observed about one outbound request; bodies are absent (see {@link planEgress}). */
export interface EgressRequestFacts {
  readonly host: string;
  /** Full URL, scanned because an API may take its credential as a query parameter. */
  readonly url: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
}

/** One placeholder to replace; the adapter fetches the secret by `name`, so a plan is safe to log. */
interface EgressSubstitution {
  readonly name: string;
  readonly placeholder: string;
}

export type EgressPlan =
  | { readonly kind: 'forward'; readonly substitutions: readonly EgressSubstitution[]; readonly withholdAuthorization?: true }
  | { readonly kind: 'refuse'; readonly status: number; readonly reason: string };

const BASIC_CREDENTIAL = /^(Basic\s+)((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)\s*$/i;

/**
 * `user:password` of a Basic credential, which `curl -u` and git over https send base64-encoded, where no scan of the
 * header text would see a placeholder; null for any other value.
 */
function basicCredential(value: string): { readonly scheme: string; readonly decoded: string } | null {
  const match = BASIC_CREDENTIAL.exec(value);

  if (match === null) return null;
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));

  return { scheme: match[1], decoded: new TextDecoder().decode(bytes) };
}

function basicValue(scheme: string, decoded: string): string {
  return `${scheme}${btoa(Array.from(new TextEncoder().encode(decoded), (byte) => String.fromCharCode(byte)).join(''))}`;
}

/** The placeholders a request names, in its URL or any header value (a Basic credential decoded): a request naming none
 *  is sent on as it is. */
export function egressPlaceholdersIn(facts: EgressRequestFacts): Set<string> {
  const present = new Set(findEgressPlaceholders(facts.url));

  for (const [, value] of facts.headers) {
    for (const found of findEgressPlaceholders(basicCredential(value)?.decoded ?? value)) present.add(found);
  }

  return present;
}

/** A URL as it leaves, and the pairs that scrub each way a URL can spell what was substituted into it. */
export interface RevealedUrl {
  readonly url: string;
  readonly scrub: readonly ScrubReplacement[];
}

/**
 * How `value` is spelled once sent as a query value, and again as an answer may echo it: as the URL parser itself
 * serializes the request (which encodes an apostrophe that `encodeURIComponent` leaves), as a form serializes it
 * (which encodes `~` and writes `+` for a space), as `encodeURIComponent` does, and each with its hex in lower case.
 * Derived from the serializers, never listed by hand.
 */
function urlSpellings(value: string): string[] {
  const sent = new URL(`https://spelling.invalid/?k=${encodeURIComponent(value)}`).search.slice('?k='.length);
  const form = new URLSearchParams([['k', value]]).toString().slice('k='.length);

  return [...new Set([sent, form, encodeURIComponent(value)].flatMap((spelling) => [spelling, spelling.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase())]))];
}

/** A query value as a form decodes it: `+` is a space. */
function decodeQueryValue(raw: string): string {
  return decodeURIComponent(raw.replaceAll('+', ' '));
}

/**
 * `url` with each placeholder in a query value replaced by its secret, the value decoded first and encoded again, so a
 * secret holding `&`, `#`, `+`, `%` or a space is one parameter's value and never a second parameter or a fragment; every
 * other byte of the URL is left as the program wrote it. The gate admits a placeholder in a URL only as its secret's
 * query parameter (`strayPosition`). The pairs scrub the encoded spellings from an answer that echoes the URL: the
 * percent form (either case of hex) and the form's `+` for a space.
 */
export function revealUrl(url: string, reveal: readonly ScrubReplacement[]): RevealedUrl {
  const at = url.indexOf('?');

  if (at === -1) return { url, scrub: [] };
  const end = url.indexOf('#', at);
  const query = url.slice(at + 1, end === -1 ? undefined : end);
  const scrub = new Map<string, string>();

  const pairs = query.split('&').map((pair) => {
    const equals = pair.indexOf('=');

    if (equals === -1 || findEgressPlaceholders(pair.slice(equals + 1)).length === 0) return pair;
    const decoded = decodeQueryValue(pair.slice(equals + 1));

    for (const { find: placeholder, replaceWith: secret } of reveal) {
      if (!decoded.includes(placeholder)) continue;

      for (const spelling of urlSpellings(secret)) {
        if (spelling !== secret) scrub.set(spelling, placeholder);
      }
    }

    return `${pair.slice(0, equals)}=${encodeURIComponent(scrubText(decoded, reveal))}`;
  });

  return {
    url: `${url.slice(0, at + 1)}${pairs.join('&')}${end === -1 ? '' : url.slice(end)}`,
    scrub: [...scrub].map(([find, replaceWith]) => ({ find, replaceWith })),
  };
}

/** A header value as it leaves, and, for a Basic credential, the pair that scrubs its encoded form from the answer. */
export interface RevealedHeader {
  readonly value: string;
  readonly scrub?: ScrubReplacement;
}

/**
 * A header value with each placeholder replaced (inside a Basic credential too), and the pair that scrubs the
 * encoded form back out of a response: an upstream that echoes the header must not hand the program its decodable secret.
 */
export function revealHeader(value: string, reveal: readonly ScrubReplacement[]): RevealedHeader {
  const basic = basicCredential(value);

  if (basic === null) return { value: scrubText(value, reveal) };
  const decoded = scrubText(basic.decoded, reveal);

  if (decoded === basic.decoded) return { value };
  const revealed = basicValue(basic.scheme, decoded);

  return { value: revealed, scrub: { find: revealed.slice(basic.scheme.length), replaceWith: basicValue('', basic.decoded) } };
}

/**
 * Plan one outbound request against the secrets granted to its workspace. A secret travels only over TLS, so its hosts
 * name who reads it and nobody between does. Unknown placeholders are refused; requests without placeholders forward
 * untouched. Bodies are not scanned: a placeholder there leaves unsubstituted, since a host may store or publish a body.
 */
export function planEgress(
  facts: EgressRequestFacts,
  granted: readonly EgressSecretBinding[],
): EgressPlan {
  const present = egressPlaceholdersIn(facts);

  if (present.size === 0) return { kind: 'forward', substitutions: [] };
  const byPlaceholder = new Map(granted.map((b) => [b.placeholder, b]));
  const withheld = new Set([...present].filter((placeholder) => withheldElsewhere(facts, byPlaceholder.get(placeholder), present)));

  // Only connections' credentials, each left off here: nothing is substituted, so the request goes on, over any scheme.
  if (withheld.size === present.size) return { kind: 'forward', substitutions: [], withholdAuthorization: true };

  const scheme = URL.parse(facts.url)?.protocol;

  if (scheme !== 'https:' && scheme !== 'wss:') {
    return {
      kind: 'refuse',
      status: 403,
      reason: `This request carries a secret placeholder over ${scheme ?? 'an unparsed URL'}. A secret is sent only over `
        + `https:// (wss:// for a WebSocket), never unencrypted. Send it to https://${facts.host} instead.`,
    };
  }

  const substitutions: EgressSubstitution[] = [];

  for (const placeholder of present) {
    if (withheld.has(placeholder)) continue;
    const binding = byPlaceholder.get(placeholder);

    if (!binding) {
      return {
        kind: 'refuse',
        status: 403,
        // Names the placeholder (the container has it), never the secret.
        reason: 'This request carries a secret placeholder that is not granted to this workspace. The secret was '
          + 'deleted, or the owner has not allowed it here (Settings > Secrets).',
      };
    }

    if (!binding.hosts.some((host) => egressHostMatches(host, facts.host))) {
      return {
        kind: 'refuse',
        status: 403,
        reason: `The secret ${binding.name} may be sent to ${binding.hosts.join(', ')}, and this request goes to `
          + `${facts.host}. A placeholder is only substituted at the hosts the owner set for its secret.`,
      };
    }

    const stray = strayPosition(facts, placeholder, binding.position);

    if (stray !== null) {
      return {
        kind: 'refuse',
        status: 403,
        reason: `The secret ${binding.name} may be sent only in ${positionWords(binding.position)}, and this request also `
          + `has it in ${stray}. A secret goes only where its API reads a credential, never where a host could store or echo it.`,
      };
    }

    substitutions.push({ name: binding.name, placeholder });
  }

  return withheld.size > 0 ? { kind: 'forward', substitutions, withholdAuthorization: true } : { kind: 'forward', substitutions };
}

/**
 * A connection's credential at a host it may not reach, alone in the `Authorization` header, which is left off. Beside
 * another placeholder there it is not, so that one is never dropped unsaid: the request is refused, as any would be.
 */
function withheldElsewhere(facts: EgressRequestFacts, binding: EgressSecretBinding | undefined, present: ReadonlySet<string>): boolean {
  if (binding?.elsewhere !== 'withheld' || binding.hosts.some((host) => egressHostMatches(host, facts.host))) return false;

  if (strayPosition(facts, binding.placeholder, { kind: 'authorization' }) !== null) return false;
  const authorization = facts.headers.filter(([name]) => name.toLowerCase() === 'authorization').map(([, value]) => basicCredential(value)?.decoded ?? value);

  return [...present].every((other) => other === binding.placeholder || !authorization.some((value) => value.includes(other)));
}

/** Literal to find and its replacement; used only to put the placeholder back over the secret. */
export interface ScrubReplacement {
  readonly find: string;
  readonly replaceWith: string;
}

/** The WebSocket close frame's limit on a reason (RFC 6455 §5.5: a 125-byte payload, two of them the code). */
const CLOSE_REASON_BYTES = 123;

/** `reason` cut to whole code points within a close frame's limit: a scrubbed reason may outgrow the server's own. */
export function closeReason(reason: string): string {
  const encoder = new TextEncoder();
  let kept = '';

  for (const point of reason) {
    if (encoder.encode(kept + point).byteLength > CLOSE_REASON_BYTES) break;
    kept += point;
  }

  return kept;
}

/** Replace every occurrence in a small string (header value, status message). */
export function scrubText(text: string, replacements: readonly ScrubReplacement[]): string {
  let out = text;

  for (const { find, replaceWith } of replacements) {
    if (find.length > 0) out = out.split(find).join(replaceWith);
  }

  return out;
}

/** One streaming-scrubber pass: bytes safe to emit, and the tail held because a needle may start in it. */
interface ScrubScan {
  readonly out: Uint8Array[];
  readonly keep: Uint8Array;
}

/** A replacement as bytes; scrubbing is byte-level, since bodies and frames need not be UTF-8. */
interface ScrubNeedle {
  readonly find: Uint8Array;
  readonly to: Uint8Array;
}

function scrubNeedles(replacements: readonly ScrubReplacement[]): ScrubNeedle[] {
  const encoder = new TextEncoder();

  return replacements.filter((r) => r.find.length > 0).map((r) => ({ find: encoder.encode(r.find), to: encoder.encode(r.replaceWith) }));
}

function matchesAt(buf: Uint8Array, at: number, needle: Uint8Array): boolean {
  for (let i = 0; i < needle.length; i += 1) if (buf[at + i] !== needle[i]) return false;

  return true;
}

/** Scrub `buf`; unless `final`, stop where a needle may start past its end and hand that tail back. */
function scanScrub(buf: Uint8Array, needles: readonly ScrubNeedle[], final: boolean): ScrubScan {
  const straddles = (at: number): boolean => needles.some((n) => {
    const available = buf.length - at;

    if (available >= n.find.length) return false;

    for (let i = 0; i < available; i += 1) if (buf[at + i] !== n.find[i]) return false;

    return true;
  });

  const out: Uint8Array[] = [];
  let plainFrom = 0;
  let i = 0;

  while (i < buf.length) {
    const hit = needles.find((n) => i + n.find.length <= buf.length && matchesAt(buf, i, n.find));

    if (hit) {
      if (i > plainFrom) out.push(buf.subarray(plainFrom, i));
      out.push(hit.to);
      i += hit.find.length;
      plainFrom = i;
      continue;
    }

    if (!final && straddles(i)) break;
    i += 1;
  }

  if (i > plainFrom) out.push(buf.subarray(plainFrom, i));

  return { out, keep: final ? new Uint8Array(0) : buf.subarray(i) };
}

/** Replace every occurrence in a whole message (a WebSocket frame's payload), byte for byte. */
export function scrubBytes(bytes: Uint8Array, replacements: readonly ScrubReplacement[]): Uint8Array {
  const needles = scrubNeedles(replacements);

  if (needles.length === 0) return bytes;
  const { out } = scanScrub(bytes, needles, true);
  const joined = new Uint8Array(out.reduce((total, piece) => total + piece.length, 0));
  let at = 0;

  for (const piece of out) {
    joined.set(piece, at);
    at += piece.length;
  }

  return joined;
}

/** Scrub a byte stream without buffering it, holding at most the longest needle minus one byte; byte-level, since bodies need not be UTF-8. */
export function createScrubStream(
  replacements: readonly ScrubReplacement[],
): TransformStream<Uint8Array, Uint8Array> {
  const needles = scrubNeedles(replacements);

  if (needles.length === 0) return new TransformStream();
  const longest = Math.max(...needles.map((n) => n.find.length));

  let carry = new Uint8Array(0);

  const drain = (
    chunk: Uint8Array,
    final: boolean,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    let buf: Uint8Array;

    if (carry.length === 0) {
      buf = chunk;
    } else {
      buf = new Uint8Array(carry.length + chunk.length);
      buf.set(carry, 0);
      buf.set(chunk, carry.length);
    }

    const { out, keep } = scanScrub(buf, needles, final);
    // Copied: `keep` may be a view over the caller's chunk.
    carry = keep.length > 0 ? new Uint8Array(keep) : new Uint8Array(0);

    for (const piece of out) if (piece.length > 0) controller.enqueue(new Uint8Array(piece));
  };

  return new TransformStream({
    transform(chunk, controller) {
      return settleSync(Effect.gen(function* () {
        drain(chunk, false, controller);

        // The retained window never grows past one needle.
        if (carry.length > longest) return yield* Effect.die(new Error('scrub stream retained more than one needle'));
      }));
    },
    flush(controller) {
      drain(new Uint8Array(0), true, controller);
    },
  });
}
