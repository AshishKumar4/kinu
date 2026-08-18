/**
 * Trust derivation — pure functions. Two distinct concepts:
 *
 *   - **event trust**:  `deriveEventTrust(ingress) → TrustLevel`. Run ONCE at
 *                       ingress, stamped on the `agent_log` row, immutable.
 *
 *   - **head trust**:   `meetTrust(events) → TrustLevel`. Recomputed per LLM
 *                       step as the meet (greatest lower bound) of the trust
 *                       of every event in the causal set. Never grants —
 *                       only restricts.
 *
 * Priority is also derived here from `(trust, variant)`. Default payload
 * visibility likewise. All three are functions of ingress + variant — never
 * read from payload, never asserted by caller.
 */

import {
  TRUST_ORDER,
  type TrustLevel, type Priority, type PayloadPolicy,
  type IngressDescriptor, type EventVariant,
  IngressRejectedError,
} from './types';

// ── Meet (greatest lower bound) ──────────────────────────────────

/** `merge(owner, external) = external`. A head consuming an owner Chat and
 *  an external Webhook runs at `external` trust, full stop. */
export function meetTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return TRUST_ORDER[a] < TRUST_ORDER[b] ? a : b;
}

/** Reduce over a non-empty set. Returns `self` for the empty case (vacuous
 *  truth — no events to restrict from), but call sites should never pass
 *  empty since "no events" implies no head. */
export function meetAll(trusts: ReadonlyArray<TrustLevel>): TrustLevel {
  if (trusts.length === 0) return 'self';
  let acc: TrustLevel = trusts[0];
  for (let i = 1; i < trusts.length; i++) acc = meetTrust(acc, trusts[i]);
  return acc;
}

/** True iff `have >= required` in the lattice. */
export function trustSatisfies(have: TrustLevel, required: TrustLevel): boolean {
  return TRUST_ORDER[have] >= TRUST_ORDER[required];
}

// ── Event trust at ingress (the only assignment site) ────────────

/**
 * Compute the trust level for a new event given its ingress descriptor.
 * This is the *only* place in the codebase where trust is assigned.
 *
 * Note: `self_emit` and `timer_alarm` are dynamic — they depend on the
 * trust of the head that emitted them or the trust recorded on the timer
 * trigger at creation time. Those come through the descriptor.
 *
 * Throws `IngressRejectedError` for combinations that are illegal at
 * the protocol level (e.g. cross-owner peer without a grant).
 */
export function deriveEventTrust(d: IngressDescriptor): TrustLevel {
  switch (d.ingress) {
    case 'chat_ws':
      return 'owner';

    case 'webhook_hmac':
    case 'webhook_bearer':
    case 'webhook_mtls':
      return 'authenticated';

    case 'timer_alarm':
      return d.trigger_creator_trust;

    case 'sandbox_cb':
    case 'process_watch':
    case 'file_watch':
      // Sandbox callback trust is `min(self, head_trust_at_launch)`.
      // This closes the "external head launches sandbox, sandbox output
      // launders to self-trust" hole.
      return meetTrust('self', d.launching_head_trust);

    case 'peer_async':
      if (d.same_owner) return 'authenticated';
      if (d.receiver_grant_present) return 'external';
      throw new IngressRejectedError('peer_async',
        'cross-owner peer message requires explicit receiver-side grant');

    case 'subordinate':
      // Parent workspace and its subordinate facets are always same-owner —
      // the same trust class as a same-owner peer message.
      return 'authenticated';

    case 'mcp_streamable':
      // mcp_chat = owner-auth; mcp_third_party = third-party auth.
      // Even when the operator minted the token for a third party, the
      // resulting calls are NEVER owner — third-party never gets owner.
      if (d.variant === 'mcp_chat') return 'owner';
      return 'authenticated';

    case 'email_inbound':
      // Email sender identity rests on Cloudflare Email Routing's edge
      // SPF/DKIM/DMARC checks upstream of the Worker — weaker than an
      // authenticated browser session, so even the owner's verified address
      // is capped at `authenticated` (never `owner`). Allowlisted
      // third-party senders run at `external`.
      return d.sender_class === 'owner' ? 'authenticated' : 'external';

    case 'self_emit':
      return meetTrust('self', d.emitting_head_trust);

    case 'reply_request':
      // Owner has just confirmed a question through the operator UI.
      return 'owner';
  }
}

// ── Priority derivation ──────────────────────────────────────────

/**
 * Priority is a function of (trust, variant). Never read from payload.
 * Illegal combinations (empty cells in the spec table) throw.
 */
export function derivePriority(trust: TrustLevel, variant: EventVariant): Priority {
  // Trust → variant → priority. Cells missing in the table are forbidden.
  const table = new Map<TrustLevel, ReadonlyMap<EventVariant, Priority>>([
    ['owner', new Map([
      ['chat', 'urgent'],
      ['process_done', 'normal'],
      ['timer', 'normal'],
      ['internal', 'normal'],
      ['reply_request', 'urgent'],
      ['file_changed', 'background'],
      ['mcp_chat', 'urgent'],
    ])],
    ['self', new Map([
      ['process_done', 'normal'],
      ['timer', 'normal'],
      ['file_changed', 'background'],
      ['internal', 'normal'],
    ])],
    ['authenticated', new Map([
      ['webhook', 'normal'],
      ['timer', 'normal'],
      ['peer_agent', 'normal'],
      // Assignments wake the subordinate promptly (peer-ask class); reports
      // roll into the orchestrator's next turn (mission-inbox class).
      ['subordinate_task', 'normal'],
      ['subordinate_report', 'background'],
      ['mcp_third_party', 'normal'],
      ['reply_request', 'normal'],
      ['internal', 'normal'],
      ['email', 'normal'],
    ])],
    ['external', new Map([
      ['webhook', 'background'],
      ['peer_agent', 'background'],
      ['mcp_third_party', 'background'],
      ['email', 'background'],
    ])],
  ]);
  const prio = table.get(trust)?.get(variant);
  if (!prio) {
    throw new IngressRejectedError(
      'invalid_combination',
      `trust=${trust} + variant=${variant} is not a permitted combination`,
    );
  }
  return prio;
}

// ── Default payload visibility ───────────────────────────────────

/** Default visibility per event trust. Operator UI can override per-trigger
 *  or per-event up to a maximum that respects the trust. */
export function deriveDefaultVisibility(trust: TrustLevel): PayloadPolicy {
  switch (trust) {
    case 'owner':
    case 'self':
      return 'full';
    case 'authenticated':
      return 'redact';
    case 'external':
      return 'hash';
  }
}

// ── Convenience: stamp all derived fields in one call ────────────

export interface DerivedFields {
  trust: TrustLevel;
  priority: Priority;
  payload_visibility: PayloadPolicy;
}

export function deriveFields(d: IngressDescriptor): DerivedFields {
  const trust = deriveEventTrust(d);
  const priority = derivePriority(trust, d.variant);
  // Email bodies ARE the turn input, and every email sender passed an
  // explicit owner grant (own address or the email_route allowlist) — the
  // per-trigger visibility override the spec allows. `redact` keeps content
  // readable while masking secret-shaped fields; execution stays gated by
  // trust regardless. Everything else keeps the per-trust default.
  const payload_visibility = d.ingress === 'email_inbound'
    ? 'redact'
    : deriveDefaultVisibility(trust);
  return { trust, priority, payload_visibility };
}
