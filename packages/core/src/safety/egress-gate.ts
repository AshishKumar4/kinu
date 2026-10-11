/**
 * Egress gate: the container holds random placeholders, never secrets; trusted code substitutes on the way out
 * only toward the bound host, and scrubs secrets from anything coming back. Consent is per binding, not per request.
 */

import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import type { ApprovalGrant } from './approval-gate';

/** Version tag, so a stored binding from an older build is not mistaken for a secret. */
export const EGRESS_PLACEHOLDER_PREFIX = 'pxs1_';

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

/** One secret bound to one destination, without the secret, so a binding is safe to log, list, or send. */
export interface EgressSecretBinding {
  /** Stable id; also the vocabulary of the owner's grant ({@link egressSecretRule}). */
  readonly id: string;
  readonly label: string;
  /** Hostname or `*` glob ({@link egressHostMatches}) this secret may be spent on. */
  readonly host: string;
  readonly placeholder: string;
}

const EGRESS_SECRET_RULE_PREFIX = 'egress-secret:';

/** Rule name a binding's approval is recorded under, reusing the approval gate's `(rule, executor)` grant machinery. */
export function egressSecretRule(bindingId: string): string {
  return `${EGRESS_SECRET_RULE_PREFIX}${bindingId}`;
}

/** Executor egress grants are scoped to; the grant writer and the binding filter must agree on this string. */
const EGRESS_EXECUTOR = 'sandbox';

/** The grants that let an egress spend a vault secret: what it carries, so the vault can be read when a request asks. */
export function egressGrants(grants: readonly ApprovalGrant[]): ApprovalGrant[] {
  return grants
    .filter((g) => g.executor === EGRESS_EXECUTOR && g.rule.startsWith(EGRESS_SECRET_RULE_PREFIX))
    .map((g) => ({ rule: g.rule, executor: g.executor }));
}

/** Bindings `grants` allow; a vaulted binding without a grant is invisible to the container. */
export function grantedEgressBindings(
  vault: readonly EgressSecretBinding[],
  grants: readonly ApprovalGrant[],
): EgressSecretBinding[] {
  const approved = new Set(
    grants.filter((g) => g.executor === EGRESS_EXECUTOR).map((g) => g.rule),
  );

  return vault.filter((b) => approved.has(egressSecretRule(b.id)));
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

/** One placeholder to replace; the adapter fetches the secret by `bindingId`, so a plan is safe to log. */
export interface EgressSubstitution {
  readonly bindingId: string;
  readonly placeholder: string;
}

export type EgressPlan =
  | { readonly kind: 'forward'; readonly substitutions: readonly EgressSubstitution[] }
  | { readonly kind: 'refuse'; readonly status: number; readonly reason: string };

/** The placeholders a request names, in its URL or any header value: a request naming none is sent on as it is. */
export function egressPlaceholdersIn(facts: EgressRequestFacts): Set<string> {
  const present = new Set(findEgressPlaceholders(facts.url));

  for (const [, value] of facts.headers) {
    for (const found of findEgressPlaceholders(value)) present.add(found);
  }

  return present;
}

/**
 * Plan one outbound request against approved `active` bindings. Unknown placeholders are refused; requests
 * without placeholders forward untouched. Bodies are not scanned: a placeholder there leaves unsubstituted.
 */
export function planEgress(
  facts: EgressRequestFacts,
  active: readonly EgressSecretBinding[],
): EgressPlan {
  const present = egressPlaceholdersIn(facts);

  if (present.size === 0) return { kind: 'forward', substitutions: [] };

  const byPlaceholder = new Map(active.map((b) => [b.placeholder, b]));
  const substitutions: EgressSubstitution[] = [];

  for (const placeholder of present) {
    const binding = byPlaceholder.get(placeholder);

    if (!binding) {
      return {
        kind: 'refuse',
        status: 403,
        // Names the placeholder (the container has it), never the secret.
        reason: 'This request carries a secret placeholder that is not bound to any '
          + 'approved secret. It was revoked, or it was never granted.',
      };
    }

    if (!egressHostMatches(binding.host, facts.host)) {
      return {
        kind: 'refuse',
        status: 403,
        reason: `The secret "${binding.label}" is bound to ${binding.host} and this `
          + `request goes to ${facts.host}. A placeholder is only substituted at the `
          + 'destination its secret was approved for.',
      };
    }

    substitutions.push({ bindingId: binding.id, placeholder });
  }

  return { kind: 'forward', substitutions };
}

/** Literal to find and its replacement; used only to put the placeholder back over the secret. */
export interface ScrubReplacement {
  readonly find: string;
  readonly replaceWith: string;
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
