/**
 * Egress gate — which outbound request may carry which of the owner's secrets,
 * and what the machine making the request is allowed to learn about them.
 *
 * The shape of the problem. An agent's container needs credentials to do real
 * work, and the container is where untrusted code runs. Putting the secret in
 * the container's environment means every process in it, every `env` dump, and
 * every crash report holds the owner's key forever. So the container never
 * receives one. It receives a PLACEHOLDER — an opaque, high-entropy token that
 * stands in for the secret at the exact position the upstream API wants the
 * credential — and the substitution happens outside the container, on the way
 * out, in trusted code.
 *
 * Three properties this file exists to keep, in the order they matter:
 *
 *   1. A placeholder tells you nothing about its secret. It is generated from
 *      fresh randomness, never derived from the secret by hash, prefix,
 *      truncation or any other transform. {@link EGRESS_PLACEHOLDER_BYTES} is
 *      the entropy; the value the container can read is only ever this.
 *
 *   2. A secret leaves only toward the host it was bound to. A placeholder is
 *      not a bearer instrument: possessing it does not spend it. Every
 *      substitution re-checks the destination against the binding, so a
 *      container that lifts a placeholder out of one request and posts it to a
 *      host of its choosing gets a refusal, not a credential. This is the
 *      property that makes placeholders safe to leave lying around inside the
 *      container, and it is why {@link planEgress} refuses rather than
 *      passing the request through unsubstituted.
 *
 *   3. The substitution never comes back. Upstreams echo credentials — in
 *      error bodies quoting the request, in `Location` headers carrying a
 *      token as a query parameter, in `WWW-Authenticate` challenges. Anything
 *      the container can read is scrubbed on the way back
 *      ({@link scrubText}, {@link createScrubStream}), so a round trip cannot
 *      be used to ask the proxy what the secret is.
 *
 * What is NOT here. Approval is not a per-request question — a request that
 * blocked for minutes waiting for the owner is a hung build, and asking once
 * per request would train the owner to stop reading. The owner is asked once,
 * when a secret is BOUND to a host, through the one approval ladder in
 * `approval-gate.ts` ({@link reviewEgressBinding} supplies the review,
 * `decideApproval` runs the ladder). Bindings reaching {@link planEgress} are
 * already approved; this file's job at request time is to enforce the
 * destination, not to re-litigate consent.
 *
 * Also not here: transport. Nothing in this file knows what a container, a
 * Durable Object or an HTTP proxy is. The backend adapter supplies the
 * request facts and applies the plan.
 */

import type { ApprovalGrant, ApprovalResult } from './approval-gate.js';

// ── Placeholders ─────────────────────────────────────────────────

/** Version tag, so a stored binding written by an older build is recognisable
 *  rather than mistaken for a secret. */
export const EGRESS_PLACEHOLDER_PREFIX = 'pxs1_';

/** Randomness behind one placeholder. 32 bytes is not a guess about how long
 *  an attacker gets: a placeholder is public to the container by design, so
 *  the only thing this size has to defeat is a COLLISION with another
 *  binding's placeholder, which is what would let one secret be spent where
 *  another was authorised. */
export const EGRESS_PLACEHOLDER_BYTES = 32;

/** 32 bytes, base64url, unpadded. */
const PLACEHOLDER_BODY_LENGTH = 43;

/** Scanner for placeholders sitting anywhere inside a larger string — a URL,
 *  a header value. Non-global on purpose: callers that need every match build
 *  their own global copy, so no state is shared between scans. */
const PLACEHOLDER_BODY = `[A-Za-z0-9_-]{${PLACEHOLDER_BODY_LENGTH}}`;

/** Exactly one placeholder and nothing else. */
const PLACEHOLDER_EXACT = new RegExp(`^${EGRESS_PLACEHOLDER_PREFIX}${PLACEHOLDER_BODY}$`);

/** True for a string that is entirely one placeholder. */
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

// ── Bindings ─────────────────────────────────────────────────────

/**
 * One secret, bound to one destination — everything about it EXCEPT the
 * secret.
 *
 * This is the shape that may be logged, listed in a UI, returned over RPC and
 * handed to the container. The secret itself never enters this type, so there
 * is no code path that accidentally serialises one by serialising a binding.
 */
export interface EgressSecretBinding {
  /** Stable id. Also the vocabulary the owner's grant is written in — see
   *  {@link egressSecretRule}. */
  readonly id: string;
  /** What the owner called it, for the approval card and the UI. */
  readonly label: string;
  /** The destination this secret may be spent on. A hostname, or a `*` glob
   *  ({@link egressHostMatches}). The whole point of the binding: a secret
   *  with no host is a secret with no limit. */
  readonly host: string;
  /** The opaque stand-in the container holds. */
  readonly placeholder: string;
}

/** The rule name a binding's approval is recorded under. Reusing the approval
 *  gate's `(rule, executor)` vocabulary means a standing grant for an egress
 *  secret is stored, formatted, parsed, listed, revoked and inherited by
 *  exactly the machinery that already does all of that for shell rules — and
 *  it means the owner's grant list reads as one list. */
export function egressSecretRule(bindingId: string): string {
  return `egress-secret:${bindingId}`;
}

/** The binding id inside a rule name, or null when the rule is about something
 *  else. */
export function parseEgressSecretRule(rule: string): string | null {
  const id = rule.startsWith('egress-secret:') ? rule.slice('egress-secret:'.length) : '';
  return id.length > 0 ? id : null;
}

/**
 * The executor an egress grant is scoped to.
 *
 * `sandbox` because the container is where the request originates, and the
 * approval gate's unit of trust is (rule, executor). Naming it once here means
 * the side that WRITES a grant and the side that FILTERS bindings by it cannot
 * disagree about the string — a mismatch would present as an approved secret
 * that never gets injected, with nothing failing.
 */
export const EGRESS_EXECUTOR = 'sandbox';

/**
 * The bindings a workspace holding `grants` may actually spend.
 *
 * This is the one place consent is turned into a binding list, so the outbound
 * handler is configured with exactly what the owner approved and nothing else.
 * A binding in the vault with no matching grant is invisible to the container:
 * it never learns the placeholder, so it cannot even try.
 */
export function grantedEgressBindings(
  vault: readonly EgressSecretBinding[],
  grants: readonly ApprovalGrant[],
): EgressSecretBinding[] {
  const approved = new Set(
    grants.filter((g) => g.executor === EGRESS_EXECUTOR).map((g) => g.rule),
  );
  return vault.filter((b) => approved.has(egressSecretRule(b.id)));
}

/**
 * Match a host against a binding's pattern. `*` spans any run of characters,
 * every other character is literal, and comparison is case-insensitive
 * because hostnames are.
 *
 * A pattern is anchored at both ends: `api.example.com` does not match
 * `api.example.com.attacker.test`, which is the suffix trick that turns a
 * host check into decoration.
 */
export function egressHostMatches(pattern: string, host: string): boolean {
  const target = host.trim().toLowerCase();
  const glob = pattern.trim().toLowerCase();
  if (glob.length === 0 || target.length === 0) return false;
  if (!glob.includes('*')) return glob === target;
  const escaped = glob.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(target);
}

// ── Approval ─────────────────────────────────────────────────────

/**
 * The review the owner is shown when a secret is bound to a host.
 *
 * Always `gate`, never `allow`. An egress carrying a credential is the
 * archetypal `reaches_out` harm in `approval-gate.ts`'s vocabulary: the effect
 * leaves the executor, so it does not get safer for having been typed on a
 * disposable box. The gate's `AGENT_OWN_EXECUTORS` shortcut — which lets the
 * agent do as it likes on its own container — deliberately does not reach
 * this decision, and that is expressed by constructing the hit here rather
 * than by adding a row to the shell rule table: there is no command line to
 * pattern-match, and a rule that fires on every egress regardless of text is
 * not a pattern.
 *
 * A standing grant still short-circuits it, through the ordinary
 * `afterGrants` path in `decideApproval`. Asking twice for the same binding is
 * the thing the grant exists to prevent.
 */
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

/** The human-readable action an egress binding's approval card names. Shaped
 *  to read as an action because that is the slot it fills in
 *  `ShellApprovalRequest.command`. */
export function egressBindingAction(
  binding: Pick<EgressSecretBinding, 'label' | 'host'>,
): string {
  return `bind secret "${binding.label}" for egress to ${binding.host}`;
}

// ── Request-time plan ────────────────────────────────────────────

/** What the adapter observed about one outbound request. Bodies are absent on
 *  purpose — see {@link planEgress}. */
export interface EgressRequestFacts {
  /** Destination host, already parsed out of the URL by the adapter. */
  readonly host: string;
  /** The full request URL, scanned for placeholders because an API may want
   *  its credential in a query parameter. */
  readonly url: string;
  /** Header name/value pairs as the container sent them. */
  readonly headers: readonly (readonly [name: string, value: string])[];
}

/** One placeholder to replace, and what to replace it with. The secret is
 *  fetched by the adapter against `bindingId`; it is not carried here, so a
 *  plan can be logged. */
export interface EgressSubstitution {
  readonly bindingId: string;
  readonly placeholder: string;
}

export type EgressPlan =
  | { readonly kind: 'forward'; readonly substitutions: readonly EgressSubstitution[] }
  | { readonly kind: 'refuse'; readonly status: number; readonly reason: string };

/**
 * Decide what happens to one outbound request.
 *
 * `active` is the set of bindings the owner has already approved and not
 * revoked. Anything not in it is unknown, and an unknown placeholder is
 * refused rather than forwarded: the container asked for a credential that no
 * longer exists, and a request that silently goes out with a dummy in the
 * Authorization header produces a confusing upstream 401 instead of the true
 * reason.
 *
 * A request with NO placeholder in it is ordinary traffic and forwards
 * untouched. Whether it may leave at all is a host-policy question the
 * adapter answers with the container's allow/deny lists, not a secret
 * question.
 *
 * REQUEST BODIES ARE NOT SCANNED, and this is a deliberate limit rather than
 * an oversight. Scanning one means buffering it, and the agent uploads
 * artefacts. The consequence is exact and safe: a placeholder placed in a
 * request body is never substituted, so the request leaves carrying the dummy
 * and the upstream rejects it. The failure is visible and no secret moves.
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
        // Naming the placeholder is safe — the container already has it — and
        // naming the SECRET would not be, so this says neither more nor less
        // than the container can already see.
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

// ── Scrubbing what comes back ────────────────────────────────────

/** A literal to find and what to put in its place. Used one way only: find
 *  the real secret, put the placeholder back. */
export interface ScrubReplacement {
  readonly find: string;
  readonly replaceWith: string;
}

/** Replace every occurrence, in a string small enough to hold — a header
 *  value, a status message. */
export function scrubText(text: string, replacements: readonly ScrubReplacement[]): string {
  let out = text;
  for (const { find, replaceWith } of replacements) {
    if (find.length > 0) out = out.split(find).join(replaceWith);
  }
  return out;
}

/** One pass of the streaming scrubber: bytes it is safe to emit now, and the
 *  tail that must be held because a needle could still start inside it. */
interface ScrubScan {
  readonly out: Uint8Array[];
  readonly keep: Uint8Array;
}

/**
 * Replace every occurrence in a stream, without buffering the stream.
 *
 * Response bodies are the one place a secret can come back at arbitrary size:
 * an upstream that quotes the offending request into a 400 has just written
 * the owner's credential into something the container will read. Buffering to
 * scrub it would mean holding every artefact download in memory, so this
 * scans as bytes flow and retains only what a partial match at a chunk
 * boundary could need — at most the longest needle minus one byte.
 *
 * Byte-level rather than decoded text: bodies are not all UTF-8, and decoding
 * an image to scrub it would corrupt it.
 */
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
  /** Could a needle START here and finish in bytes we have not seen yet? */
  const straddles = (buf: Uint8Array, at: number): boolean => needles.some((n) => {
    const available = buf.length - at;
    if (available >= n.find.length) return false;
    for (let i = 0; i < available; i += 1) if (buf[at + i] !== n.find[i]) return false;
    return true;
  });

  /** Scan `buf`, returning bytes safe to emit and bytes that must be held. */
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
    // Copied, not referenced: `keep` is a view over `buf`, and `buf` is the
    // caller's chunk when there was no carry.
    carry = keep.length > 0 ? new Uint8Array(keep) : new Uint8Array(0);
    for (const piece of out) if (piece.length > 0) controller.enqueue(new Uint8Array(piece));
  };

  return new TransformStream({
    transform(chunk, controller) {
      drain(chunk, false, controller);
      // A pathological stream of single bytes that all look like a prefix
      // cannot grow the retained window past one needle.
      if (carry.length > longest) throw new Error('scrub stream retained more than one needle');
    },
    flush(controller) {
      drain(new Uint8Array(0), true, controller);
    },
  });
}
