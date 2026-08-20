/**
 * Mission Inbox — inbound routing, pure of platform imports. The Worker
 * `email()` entry (handler.ts) binds `resolveAgent` to getAgentByName; tests
 * mock at this seam (raw message in, RPC target out).
 *
 * Unauthorized or unroutable mail is DROPPED (returning without forward /
 * reject drops the message) — rejecting would turn agent addresses into an
 * existence oracle for probes.
 */

import { agentNameFromRecipient, isAutoReplyEmail, parseInboundMime } from './inbound';

/** The structural slice of ForwardableEmailMessage this routing consumes —
 *  the mock seam for tests. */
export interface InboundEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
}

/** What the routing asks of the resolved agent — the RPC seam for tests. */
export interface EmailDeliveryTarget {
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

/** Parse + route one inbound message to its agent. Returns the outcome for
 *  logging/tests; the message is dropped in every non-admitted case. */
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
  // Drop auto-replies (RFC 3834) before waking a turn: Kinu replies
  // on-thread, so admitting a vacation responder or peer agent would loop.
  if (isAutoReplyEmail(message.headers)) {
    return { outcome: 'dropped', agent: agentName, reason: 'auto-reply (RFC 3834)' };
  }
  // message.raw is single-use — buffer before parsing.
  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await parseInboundMime(raw);
  const agent = await resolveAgent(agentName);
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
