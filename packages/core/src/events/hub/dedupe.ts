/** Per-variant dedupe keys; the unique index on `agent_log.dedupe_key` enforces once-per-key. */

import { sha256Hex, stableStringify } from '../../safety/argument-digest';
import type { IngressDescriptor, KinuEvent, ReadableKinuEvent } from './types';
import { decodeJsonValue } from '../../utils/json';

export function subordinateReportDedupeKey(sequenceId: string): string {
  return `subordinate_report:${sequenceId}`;
}

export function dedupeKeyFor(event: KinuEvent): string | null {
  if (event.payload_visibility !== 'full' && event.payload_visibility !== 'redact') {
    return event.dedupe_key;
  }

  return dedupeReadableEvent(event);
}

/** Admission-time dedupe runs before visibility replaces the payload. */
export function dedupeKeyForDescriptor(
  descriptor: IngressDescriptor,
  receivedAt: number,
): string | null {
  return dedupeReadableEvent({ ...descriptor, received_at: receivedAt });
}

function dedupeReadableEvent(
  event: ReadableKinuEvent | (IngressDescriptor & { received_at: number }),
): string | null {
  switch (event.variant) {
    case 'webhook': {
      const p = event.payload;
      const bucket = Math.floor(event.received_at / (5 * 60 * 1000));
      const bodyHash = sha256Hex(stableStringify(decodeJsonValue({ value: p.body })), 24);

      return `webhook:${p.webhook_id}:${bodyHash}:${bucket}`;
    }

    case 'timer':
      return `timer:${event.payload.trigger_id}:${event.payload.scheduled_fire_at}`;

    case 'process_done':
      return `process_done:${event.payload.process_id}`;

    case 'peer_agent':
      return `peer:${event.payload.from_agent_name}:${event.payload.sender_event_id}`;

    case 'mcp_chat':
    case 'mcp_third_party':
      return `mcp:${event.payload.client_id}:${event.payload.request_id}`;

    case 'email': {
      // Email Routing retries reuse the Message-ID; mail without one falls back to a bucketed hash.
      const p = event.payload;

      if (p.message_id) return `email:${p.message_id}`;
      const bucket = Math.floor(event.received_at / (5 * 60 * 1000));

      return `email:${sha256Hex(`${p.from}|${p.to}|${p.subject}|${p.body_text}`, 24)}:${bucket}`;
    }

    case 'subordinate_report':
      return subordinateReportDedupeKey(event.payload.sequence_id);

    case 'subordinate_task':
      return event.payload.creation_id === undefined ? null : `subordinate-birth:${event.payload.creation_id}`;

    case 'chat':
    case 'internal':
    case 'file_changed':
    case 'reply_request':
      return null;
  }
}
