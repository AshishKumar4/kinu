// Trust derivation + lattice meet — pure functions.
// Verifies the (ingress, variant) → trust table and the fan-in semantics.
import { describe, test, expect } from 'bun:test';
import {
  meetTrust, meetAll, trustSatisfies,
  deriveEventTrust, derivePriority, deriveDefaultVisibility, deriveFields,
  IngressRejectedError,
  type IngressDescriptor, type TrustLevel,
} from '../src/events/hub/index.ts';

describe('meetTrust', () => {
  test('returns the lower-trust side', () => {
    expect(meetTrust('owner', 'external')).toBe('external');
    expect(meetTrust('self', 'owner')).toBe('owner');
    expect(meetTrust('authenticated', 'external')).toBe('external');
    expect(meetTrust('owner', 'owner')).toBe('owner');
  });
  test('is commutative', () => {
    const pairs: Array<[TrustLevel, TrustLevel]> = [
      ['owner', 'external'], ['self', 'authenticated'], ['external', 'self'],
    ];
    for (const [a, b] of pairs) expect(meetTrust(a, b)).toBe(meetTrust(b, a));
  });
  test('meetAll reduces to min across the chain', () => {
    expect(meetAll(['owner', 'self', 'authenticated'])).toBe('authenticated');
    expect(meetAll(['external', 'owner', 'self'])).toBe('external');
    expect(meetAll(['owner'])).toBe('owner');
    expect(meetAll([])).toBe('self');           // vacuous
  });
});

describe('trustSatisfies', () => {
  test('owner satisfies authenticated and below', () => {
    expect(trustSatisfies('owner', 'authenticated')).toBe(true);
    expect(trustSatisfies('owner', 'external')).toBe(true);
    expect(trustSatisfies('authenticated', 'owner')).toBe(false);
  });
});

describe('deriveEventTrust', () => {
  test('chat_ws → owner', () => {
    const d: IngressDescriptor = {
      ingress: 'chat_ws', variant: 'chat',
      payload: { text: 'hi' }, operator_user_id: 'u', session_id: 's',
    };
    expect(deriveEventTrust(d)).toBe('owner');
  });
  test('webhook_hmac → authenticated', () => {
    const d: IngressDescriptor = {
      ingress: 'webhook_hmac', variant: 'webhook',
      payload: { webhook_id: 'w', http_method: 'POST', http_headers: {}, body: {}, delivery_id: 'd' },
      auth_outcome: 'verified', webhook_id: 'w',
    };
    expect(deriveEventTrust(d)).toBe('authenticated');
  });
  test('timer_alarm inherits creator trust', () => {
    const d: IngressDescriptor = {
      ingress: 'timer_alarm', variant: 'timer',
      payload: { trigger_id: 't', scheduled_fire_at: 0 },
      trigger_creator_trust: 'authenticated',
    };
    expect(deriveEventTrust(d)).toBe('authenticated');
  });
  test('sandbox_cb collapses to min(self, head_trust) — external head launches sandbox', () => {
    const d: IngressDescriptor = {
      ingress: 'sandbox_cb', variant: 'process_done',
      payload: { process_id: 'p', command: 'ls', exit_code: 0, stdout_excerpt: '', stderr_excerpt: '', duration_ms: 0 },
      launching_head_trust: 'external',
    };
    expect(deriveEventTrust(d)).toBe('external');
  });
  test('sandbox_cb stays self when owner head launches sandbox', () => {
    const d: IngressDescriptor = {
      ingress: 'sandbox_cb', variant: 'process_done',
      payload: { process_id: 'p', command: 'ls', exit_code: 0, stdout_excerpt: '', stderr_excerpt: '', duration_ms: 0 },
      launching_head_trust: 'owner',
    };
    expect(deriveEventTrust(d)).toBe('owner');
  });
  test('peer_async same-owner → authenticated', () => {
    const d: IngressDescriptor = {
      ingress: 'peer_async', variant: 'peer_agent',
      payload: { from_agent_name: 'a', from_user_id: 'u', topic: 't', body: {}, sender_event_id: 'ox1' },
      same_owner: true, receiver_grant_present: false,
    };
    expect(deriveEventTrust(d)).toBe('authenticated');
  });
  test('peer_async cross-owner with grant → external', () => {
    const d: IngressDescriptor = {
      ingress: 'peer_async', variant: 'peer_agent',
      payload: { from_agent_name: 'a', from_user_id: 'u', topic: 't', body: {}, sender_event_id: 'ox1' },
      same_owner: false, receiver_grant_present: true,
    };
    expect(deriveEventTrust(d)).toBe('external');
  });
  test('peer_async cross-owner without grant rejects at ingress', () => {
    const d: IngressDescriptor = {
      ingress: 'peer_async', variant: 'peer_agent',
      payload: { from_agent_name: 'a', from_user_id: 'u', topic: 't', body: {}, sender_event_id: 'ox1' },
      same_owner: false, receiver_grant_present: false,
    };
    expect(() => deriveEventTrust(d)).toThrow(IngressRejectedError);
  });
  test('mcp_chat (operator) → owner', () => {
    const d: IngressDescriptor = {
      ingress: 'mcp_streamable', variant: 'mcp_chat',
      payload: { client_id: 'c', method: 'm', arguments: {}, request_id: 'r' },
    };
    expect(deriveEventTrust(d)).toBe('owner');
  });
  test('mcp_third_party never becomes owner', () => {
    const d: IngressDescriptor = {
      ingress: 'mcp_streamable', variant: 'mcp_third_party',
      payload: { client_id: 'c', client_label: 'x', method: 'm', arguments: {}, request_id: 'r' },
    };
    expect(deriveEventTrust(d)).toBe('authenticated');
  });
});

describe('derivePriority', () => {
  test('owner chat is urgent', () => {
    expect(derivePriority('owner', 'chat')).toBe('urgent');
  });
  test('external webhook is background', () => {
    expect(derivePriority('external', 'webhook')).toBe('background');
  });
  test('authenticated webhook is normal', () => {
    expect(derivePriority('authenticated', 'webhook')).toBe('normal');
  });
  test('forbidden combo throws', () => {
    expect(() => derivePriority('external', 'chat')).toThrow();
    expect(() => derivePriority('owner', 'webhook')).toThrow();
  });
});

describe('deriveDefaultVisibility', () => {
  test('owner → full, self → full', () => {
    expect(deriveDefaultVisibility('owner')).toBe('full');
    expect(deriveDefaultVisibility('self')).toBe('full');
  });
  test('authenticated → redact', () => {
    expect(deriveDefaultVisibility('authenticated')).toBe('redact');
  });
  test('external → hash', () => {
    expect(deriveDefaultVisibility('external')).toBe('hash');
  });
});

describe('deriveFields', () => {
  test('webhook hmac derives all three fields atomically', () => {
    const f = deriveFields({
      ingress: 'webhook_hmac', variant: 'webhook',
      payload: { webhook_id: 'w', http_method: 'POST', http_headers: {}, body: {}, delivery_id: 'd' },
      auth_outcome: 'verified', webhook_id: 'w',
    });
    expect(f.trust).toBe('authenticated');
    expect(f.priority).toBe('normal');
    expect(f.payload_visibility).toBe('redact');
  });
});
