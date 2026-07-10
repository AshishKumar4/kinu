/**
 * Per-variant idempotency-key derivation. The UNIQUE partial index on
 * `agent_log.dedupe_key` enforces "exactly once" per key. Variants that
 * don't need dedupe return null (chat, internal, file_changed,
 * reply_request).
 *
 * Pure function. The same input always produces the same key.
 */

import { createHash } from 'node:crypto';
import type { ProteusEvent } from './types.js';

/** Map an event to its dedupe key, or null if the variant is not deduped. */
export function dedupeKeyFor(event: ProteusEvent): string | null {
  switch (event.variant) {
    case 'webhook': {
      const p = event.payload;
      const bucket = Math.floor(event.received_at / (5 * 60 * 1000));
      const bodyHash = sha256Hex(stableStringify(p.body));
      return `webhook:${p.webhook_id}:${bodyHash}:${bucket}`;
    }

    case 'timer':
      return `timer:${event.payload.trigger_id}:${event.payload.scheduled_fire_at}`;

    case 'process_done':
      return `process_done:${event.payload.process_id}`;

    case 'peer_agent':
      // Receiver-side dedupe on (sender, sender-side outbox event id) — a
      // redelivered message is a no-op while repeated topics still admit.
      return `peer:${event.payload.from_agent_name}:${event.payload.sender_event_id}`;

    case 'mcp_chat':
    case 'mcp_third_party':
      return `mcp:${event.payload.client_id}:${event.payload.request_id}`;

    case 'chat':
    case 'internal':
    case 'file_changed':
    case 'reply_request':
      // No natural idempotency. The runtime trusts the originating layer.
      return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 24);
}

/** Deterministic JSON-like serializer (sorts object keys). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
