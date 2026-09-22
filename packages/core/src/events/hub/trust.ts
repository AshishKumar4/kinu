/** Event trust is assigned once at ingress; head trust is the meet over its causal set and only
 *  restricts. Priority and visibility derive from ingress + variant, never from payload. */

import {
  TRUST_ORDER,
  type TrustLevel, type Priority, type PayloadPolicy,
  type IngressDescriptor, type EventVariant,
  IngressRejectedError,
} from './types';

export function meetTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return TRUST_ORDER[a] < TRUST_ORDER[b] ? a : b;
}

/** `self` for the empty set (vacuous); callers should not pass it. */
export function meetAll(trusts: ReadonlyArray<TrustLevel>): TrustLevel {
  if (trusts.length === 0) return 'self';
  let acc: TrustLevel = trusts[0];

  for (let i = 1; i < trusts.length; i++) acc = meetTrust(acc, trusts[i]);

  return acc;
}

export function trustSatisfies(have: TrustLevel, required: TrustLevel): boolean {
  return TRUST_ORDER[have] >= TRUST_ORDER[required];
}

/** The only place trust is assigned. Throws `IngressRejectedError` for protocol-illegal ingress. */
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
      // Capped at the launching head's trust so sandbox output cannot launder to `self`.
      return meetTrust('self', d.launching_head_trust);

    case 'peer_async':
      if (d.same_owner) return 'authenticated';

      if (d.receiver_grant_present) return 'external';
      throw new IngressRejectedError('peer_async',
        'cross-owner peer message requires explicit receiver-side grant');

    case 'subordinate':
      return 'authenticated';

    case 'mcp_streamable':
      // Third-party MCP is never `owner`, even with an operator-minted token.
      if (d.variant === 'mcp_chat') return 'owner';

      return 'authenticated';

    case 'email_inbound':
      // Sender identity rests on Email Routing's edge SPF/DKIM/DMARC, so even the owner's address is
      // capped at `authenticated`.
      return d.sender_class === 'owner' ? 'authenticated' : 'external';

    case 'self_emit':
      return meetTrust('self', d.emitting_head_trust);

    case 'reply_request':
      return 'owner';
  }
}

/** Combinations missing from the table throw. */
export function derivePriority(trust: TrustLevel, variant: EventVariant): Priority {
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

export interface DerivedFields {
  trust: TrustLevel;
  priority: Priority;
  payload_visibility: PayloadPolicy;
}

export function deriveFields(d: IngressDescriptor): DerivedFields {
  const trust = deriveEventTrust(d);
  const priority = derivePriority(trust, d.variant);

  // Email senders all passed an explicit owner grant, so bodies stay readable as `redact`.
  const payload_visibility = d.ingress === 'email_inbound'
    ? 'redact'
    : deriveDefaultVisibility(trust);

  return { trust, priority, payload_visibility };
}
