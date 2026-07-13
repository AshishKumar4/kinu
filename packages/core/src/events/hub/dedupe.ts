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

    case 'email': {
      // Message-ID is the natural idempotency key (Email Routing retries
      // deliver the same id). Mail without one falls back to a content hash
      // bucketed like webhooks.
      const p = event.payload;
      if (p.message_id) return `email:${p.message_id}`;
      const bucket = Math.floor(event.received_at / (5 * 60 * 1000));
      return `email:${sha256Hex(`${p.from}|${p.to}|${p.subject}|${p.body_text}`)}:${bucket}`;
    }

    case 'chat':
    case 'internal':
    case 'file_changed':
    case 'reply_request':
    case 'subordinate_task':
    case 'subordinate_report':
      // No natural idempotency. The runtime trusts the originating layer —
      // subordinate traffic is a one-shot same-machine facet RPC (no
      // redelivery loop to dedupe against).
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
