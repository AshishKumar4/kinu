/**
 * Mission Inbox inbound routing, pure of platform imports (handler.ts binds `resolveAgent`).
 * Unauthorized or unroutable mail is dropped, never rejected: rejection would be an existence oracle.
 */

import { readBounded } from '@kinu.run/core';
import { Effect } from 'effect';
import { KinuError, settle } from '@kinu.run/core/obs';
import { agentNameFromRecipient, isAutoReplyEmail, parseInboundMime } from './inbound';

/** Cloudflare Email Routing delivers up to 25 MiB (email.routing.message_bytes) whole; an unauthorized
 *  sender must not spend that much memory, plus MIME amplification, on the way to being dropped. */
const INBOUND_EMAIL_MAX_BYTES = 2 * 1024 * 1024;

export interface InboundEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  /** A pre-filter, never the gate: the bytes are counted as they arrive. */
  readonly rawSize: number;
}

export interface EmailDeliveryTarget {
  /** Asked before parsing by the same trust gate that admits the message; `acceptEmailDelivery`
   *  re-asks at admission so a stale yes admits nothing. */
  authorizeEmailSender(from: string): Promise<{ authorized: boolean; reason?: string }>;
  acceptEmailDelivery(opts: {
    from: string;
    to: string;
    subject: string;
    body_text: string;
    message_id: string | null;
    in_reply_to: string | null;
    references: string | null;
    attachments: Array<{ filename: string; content_type: string; size: number }>;
    now: number;
  }): Promise<{ admitted: boolean; duplicate?: boolean; reason?: string }>;
}

/** Cheapest refusal first (recipient, auto-reply, size, sender), then the expensive MIME parse, so an
 *  unauthorized sender cannot spend it. The message is dropped in every non-admitted case. */
export async function routeInboundEmail(
  message: InboundEmailMessage,
  emailDomain: string | undefined,
  resolveAgent: (name: string) => Promise<EmailDeliveryTarget>,
  now: number = Date.now(),
): Promise<{ outcome: 'admitted' | 'duplicate' | 'dropped'; agent?: string; reason?: string }> {
  const agentName = agentNameFromRecipient(message.to, emailDomain);

  if (!agentName) {
    return { outcome: 'dropped', reason: `unroutable recipient ${message.to}` };
  }

  // RFC 3834: Kinu replies on-thread, so admitting a responder would loop.
  if (isAutoReplyEmail(message.headers)) {
    return { outcome: 'dropped', agent: agentName, reason: 'auto-reply (RFC 3834)' };
  }

  if (message.rawSize > INBOUND_EMAIL_MAX_BYTES) {
    return { outcome: 'dropped', agent: agentName, reason: oversizeReason(message.rawSize) };
  }

  const agent = await resolveAgent(agentName);
  const preauth = await agent.authorizeEmailSender(message.from);

  if (!preauth.authorized) {
    return { outcome: 'dropped', agent: agentName, reason: preauth.reason ?? 'sender not authorized for this agent' };
  }

  // message.raw is single-use; the declared size is the sender's claim, the count is ours.
  // Cancelled at the chunk past the limit, so no oversized buffer is ever assembled.
  const raw = await readBounded(message.raw, INBOUND_EMAIL_MAX_BYTES);

  if (raw === 'too_large') {
    return { outcome: 'dropped', agent: agentName, reason: oversizeReason(INBOUND_EMAIL_MAX_BYTES) };
  }

  // A stream that broke mid-read fails the delivery, so Email Routing tries it again.
  if (raw instanceof KinuError) return await settle(Effect.fail(raw));
  const parsed = await parseInboundMime(raw);

  const result = await agent.acceptEmailDelivery({
    from: message.from,
    to: message.to,
    subject: parsed.subject,
    body_text: parsed.body_text,
    message_id: parsed.message_id ?? message.headers.get('message-id'),
    in_reply_to: parsed.in_reply_to,
    references: parsed.references,
    attachments: parsed.attachments,
    now,
  });

  if (!result.admitted) return { outcome: 'dropped', agent: agentName, reason: result.reason };

  return { outcome: result.duplicate ? 'duplicate' : 'admitted', agent: agentName };
}

function oversizeReason(bytes: number): string {
  return `message over the ${String(Math.floor(INBOUND_EMAIL_MAX_BYTES / (1024 * 1024)))} MiB inbound limit (${String(bytes)} bytes)`;
}
