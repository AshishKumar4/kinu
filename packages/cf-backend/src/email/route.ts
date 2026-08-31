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

/** The raw-byte ceiling for one inbound message, before anything materialises
 *  it. Cloudflare Email Routing delivers messages up to 25 MiB
 *  (email.routing.message_bytes) whole to this Worker; an unauthorized sender
 *  must not be able to spend that much memory, plus whatever MIME parsing and
 *  attachment decoding amplifies it to, on the way to being dropped. Generous
 *  for the mail a person writes an agent, far under what the platform carries. */
export const INBOUND_EMAIL_MAX_BYTES = 2 * 1024 * 1024;

/** The structural slice of ForwardableEmailMessage this routing consumes —
 *  the mock seam for tests. */
export interface InboundEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  /** What the edge says the message weighs. A pre-filter, never the gate: the
   *  bytes are counted as they arrive. */
  readonly rawSize: number;
}

/** What the routing asks of the resolved agent — the RPC seam for tests. */
export interface EmailDeliveryTarget {
  /** Is this sender allowed to reach this agent's inbox at all?
   *
   *  Asked BEFORE the message is parsed, and answered by the same trust gate
   *  that admits it (owner address / `email_route` allowlist), so there is one
   *  rule and this is only the early half of it. `acceptEmailDelivery` re-asks
   *  it at admission, which is what keeps a stale yes from admitting anything. */
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

/**
 * Parse + route one inbound message to its agent. Returns the outcome for
 * logging/tests; the message is dropped in every non-admitted case.
 *
 * ORDER IS THE PROPERTY, cheapest refusal first: a recipient this deployment
 * does not serve, an auto-reply, a message over the byte ceiling, a sender the
 * receiving agent does not accept — and only then the MIME parse, which is the
 * expensive step an unauthorized sender used to be able to buy with one
 * platform-maximum message.
 */
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
  if (message.rawSize > INBOUND_EMAIL_MAX_BYTES) {
    return { outcome: 'dropped', agent: agentName, reason: oversizeReason(message.rawSize) };
  }
  const agent = await resolveAgent(agentName);
  const preauth = await agent.authorizeEmailSender(message.from);
  if (!preauth.authorized) {
    return { outcome: 'dropped', agent: agentName, reason: preauth.reason ?? 'sender not authorized for this agent' };
  }
  // message.raw is single-use — buffer before parsing, under the same ceiling
  // the declared size was pre-filtered against, because a declared size is the
  // sender's claim and the count is ours.
  const raw = await readRawBounded(message.raw, INBOUND_EMAIL_MAX_BYTES);
  if (raw === 'too_large') {
    return { outcome: 'dropped', agent: agentName, reason: oversizeReason(INBOUND_EMAIL_MAX_BYTES) };
  }
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

/**
 * The raw message, bounded, or `'too_large'` at the chunk carrying the first
 * byte past the limit — where the stream is CANCELLED rather than drained, so
 * the rest is never pulled and no oversized buffer is ever assembled.
 */
async function readRawBounded(
  raw: ReadableStream<Uint8Array>,
  limit: number,
): Promise<ArrayBuffer | 'too_large'> {
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const arrived = await reader.read();
    const value = arrived.value;
    if (arrived.done || value === undefined) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel('the inbound message is over its limit');
      return 'too_large';
    }
    chunks.push(value);
  }
  const bounded = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bounded.set(chunk, at);
    at += chunk.byteLength;
  }
  return bounded.buffer;
}
