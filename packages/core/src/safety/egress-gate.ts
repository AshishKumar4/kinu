/**
 * Egress gate: the container holds random placeholders, never secrets; trusted code substitutes on the way out
 * only toward the bound host, and scrubs secrets from anything coming back. Consent is per binding, not per request.
 */

import type { ApprovalGrant, ApprovalResult } from './approval-gate';

/** Version tag, so a stored binding from an older build is not mistaken for a secret. */
export const EGRESS_PLACEHOLDER_PREFIX = 'pxs1_';

/** Randomness per placeholder; sized against collisions between bindings, since placeholders are public to the container. */
export const EGRESS_PLACEHOLDER_BYTES = 32;

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

/** Rule name a binding's approval is recorded under, reusing the approval gate's `(rule, executor)` grant machinery. */
export function egressSecretRule(bindingId: string): string {
  return `egress-secret:${bindingId}`;
}

/** The binding id inside a rule name, or null when the rule is about something else. */
export function parseEgressSecretRule(rule: string): string | null {
  const id = rule.startsWith('egress-secret:') ? rule.slice('egress-secret:'.length) : '';

  return id.length > 0 ? id : null;
}

/** Executor egress grants are scoped to; the grant writer and the binding filter must agree on this string. */
export const EGRESS_EXECUTOR = 'sandbox';

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

/** Review shown when a secret is bound to a host. Always `gate`, bypassing `AGENT_OWN_EXECUTORS`; a standing grant still short-circuits it. */
export function reviewEgressBinding(
  binding: Pick<EgressSecretBinding, 'id' | 'label' | 'host'>,
): ApprovalResult {
  return {
    decision: 'gate',
    hits: [{
      decision: 'gate',
      rule: egressSecretRule(binding.id),
      explanation:
        `Lets the agent's container spend the secret "${binding.label}" on requests to `
        + `${binding.host}. The container never holds the secret itself — it holds a `
        + 'placeholder, substituted outside the container on the way out — but every '
        + `request it makes to ${binding.host} can carry the owner's credential.`,
    }],
  };
}

/** The approval card's action text; fills `ShellApprovalRequest.command`. */
export function egressBindingAction(
  binding: Pick<EgressSecretBinding, 'label' | 'host'>,
): string {
  return `bind secret "${binding.label}" for egress to ${binding.host}`;
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

/**
 * Plan one outbound request against approved `active` bindings. Unknown placeholders are refused; requests
 * without placeholders forward untouched. Bodies are not scanned: a placeholder there leaves unsubstituted.
 */
export function planEgress(
  facts: EgressRequestFacts,
  active: readonly EgressSecretBinding[],
): EgressPlan {
  const present = new Set(findEgressPlaceholders(facts.url));

  for (const [, value] of facts.headers) {
    for (const found of findEgressPlaceholders(value)) present.add(found);
  }

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

/** Scrub a byte stream without buffering it, holding at most the longest needle minus one byte; byte-level, since bodies need not be UTF-8. */
export function createScrubStream(
  replacements: readonly ScrubReplacement[],
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();

  const needles = replacements
    .filter((r) => r.find.length > 0)
    .map((r) => ({ find: encoder.encode(r.find), to: encoder.encode(r.replaceWith) }));

  if (needles.length === 0) return new TransformStream();
  const longest = Math.max(...needles.map((n) => n.find.length));

  let carry = new Uint8Array(0);

  const matchesAt = (buf: Uint8Array, at: number, needle: Uint8Array): boolean => {
    for (let i = 0; i < needle.length; i += 1) if (buf[at + i] !== needle[i]) return false;

    return true;
  };

  const straddles = (buf: Uint8Array, at: number): boolean => needles.some((n) => {
    const available = buf.length - at;

    if (available >= n.find.length) return false;

    for (let i = 0; i < available; i += 1) if (buf[at + i] !== n.find[i]) return false;

    return true;
  });

  const scan = (buf: Uint8Array, final: boolean): ScrubScan => {
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

      if (!final && straddles(buf, i)) break;
      i += 1;
    }

    if (i > plainFrom) out.push(buf.subarray(plainFrom, i));

    return { out, keep: final ? new Uint8Array(0) : buf.subarray(i) };
  };

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

    const { out, keep } = scan(buf, final);
    // Copied: `keep` may be a view over the caller's chunk.
    carry = keep.length > 0 ? new Uint8Array(keep) : new Uint8Array(0);

    for (const piece of out) if (piece.length > 0) controller.enqueue(new Uint8Array(piece));
  };

  return new TransformStream({
    transform(chunk, controller) {
      drain(chunk, false, controller);

      // The retained window never grows past one needle.
      if (carry.length > longest) throw new Error('scrub stream retained more than one needle');
    },
    flush(controller) {
      drain(new Uint8Array(0), true, controller);
    },
  });
}
