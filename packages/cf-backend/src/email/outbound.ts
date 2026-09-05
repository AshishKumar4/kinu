/**
 * Mission Inbox — outbound side, over the Workers `send_email` binding
 * (Cloudflare Email Sending). Four surfaces, one send path:
 *
 *   sendInboundEmailReceipt — the acknowledgement an accepted message gets
 *     straight away, before any turn runs.
 *   createEmailThreadDispatcher — the `email_thread` ReplyDispatcher: a
 *     drained turn's answer goes back onto the inbound mail's thread with
 *     correct In-Reply-To / References.
 *   dispatchEmailRepliesForTurn — called at turn completion with the drain
 *     turn id the core stamped on the injected message; replies every open
 *     email_thread channel of the events that turn consumed.
 *   sendOwnerEmail — standalone notification to the owner's verified email
 *     (Evolution Changelog digests, background-job completions).
 */

import {
  boundedMessageId, boundedReferences,
  JsonValueSchema,
  type EmailThreadAddr, type EventLog, type JsonValue, type ReplyChannelStore,
} from '@kinu.run/core';
import { agentEmailAddress } from './inbound';
import type { EmailOutbox, OutboundEmailMessage } from './outbox';
import { diagnostics, KinuError, renderThrownChain } from '@kinu.run/core/obs';
import * as v from 'valibot';

const EmailThreadAddrSchema = v.object({
  to: v.string(),
  from: v.string(),
  subject: v.string(),
  message_id: v.nullable(v.string()),
  references: v.nullable(v.string()),
});
const ReplyPayloadSchema = v.object({ content: v.optional(JsonValueSchema) });

export interface EmailThreadingHeaders {
  'In-Reply-To'?: string;
  References?: string;
}

/** What the dispatcher needs at send time. Resolved per dispatch so binding
 *  and display-name changes never go stale on a long-lived DO. */
export interface EmailSendContext {
  /** The `send_email` Workers binding, when configured. */
  email: SendEmail | undefined;
  /** Friendly From name (agent display name). */
  agentDisplayName: string;
  /** Write-ahead + idempotency for the send (SPEC §7.4). */
  outbox: EmailOutbox;
}

function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * Threading headers per RFC 5322 §3.6.4, bounded.
 *
 * The chain the reply carries is the inbound chain plus the message being
 * answered, and `boundedReferences` is what keeps that from growing past the
 * 998-octet line every receiver is allowed to reject. It never returns null
 * for a usable In-Reply-To, so the `??` is the compiler's question, not a
 * second policy.
 */
function threadingHeaders(addr: Pick<EmailThreadAddr, 'message_id' | 'references'>): EmailThreadingHeaders {
  const inReplyTo = boundedMessageId(addr.message_id, 'In-Reply-To');
  if (!inReplyTo) return {};
  return {
    'In-Reply-To': inReplyTo,
    References: boundedReferences(addr.references, inReplyTo) ?? inReplyTo,
  };
}

/**
 * One outbound message on an inbound thread — the shape a turn's answer and
 * the immediate receipt both take, so the From identity, the `Re:` rule and
 * the loop guard are decided once.
 *
 * RFC 3834: `Auto-Submitted: auto-replied` is what stops a vacation responder
 * or a peer agent bouncing this back into an endless thread — our own inbound
 * gate drops mail carrying it, and so do other conforming responders.
 */
function threadReply(
  addr: EmailThreadAddr, agentDisplayName: string, text: string,
): OutboundEmailMessage {
  return {
    from: { email: addr.from, name: agentDisplayName },
    to: addr.to,
    subject: replySubject(addr.subject),
    text,
    headers: { 'Auto-Submitted': 'auto-replied', ...threadingHeaders(addr) },
  };
}

/**
 * Tell the sender the message landed, now.
 *
 * Without this the only thing an accepted message produces is a turn, and a
 * turn can take minutes, can be queued behind others, and can end with nothing
 * to say — `dispatchEmailRepliesForTurn` sends no mail for an empty answer. So
 * the sender's evidence that Kinu has the message was, until the answer
 * arrived, nothing at all.
 *
 * IDEMPOTENT THROUGH THE OUTBOX, not through a new table. The key is the
 * admitted event's id, which the ingress dedupe makes stable across
 * redeliveries of the same Message-ID, so a re-delivered message resolves to
 * the same key and the outbox answers `deduped` without touching the binding.
 * The receipt therefore cannot become a storm, and it rides the same stable
 * outbound Message-ID as everything else this outbox sends.
 */
export async function sendInboundEmailReceipt(
  ctx: EmailSendContext,
  thread: EmailThreadAddr,
  eventId: string,
): Promise<boolean> {
  if (!ctx.email) return false;
  const result = await ctx.outbox.send(ctx.email, `receipt:${eventId}`, threadReply(
    thread,
    ctx.agentDisplayName,
    `${ctx.agentDisplayName} has your message.\nThe reply comes back on this thread.`,
  ), Date.now());
  if (result.status === 'failed') {
    diagnostics.failure(
      'email.receipt_failed',
      new KinuError('unavailable', result.error),
      { messageId: result.messageId },
    );
    return false;
  }
  return true;
}

function payloadText(payload: JsonValue): string {
  if (v.is(v.string(), payload)) return payload;
  const parsed = v.safeParse(ReplyPayloadSchema, payload);
  const content = parsed.success ? parsed.output.content : undefined;
  if (v.is(v.string(), content)) return content;
  return JSON.stringify(content ?? payload ?? '');
}

/** The `email_thread` ReplyDispatcher registered on the ReplyChannelStore. */
export function createEmailThreadDispatcher(
  getContext: () => EmailSendContext,
): import('@kinu.run/core').ReplyDispatcher {
  return {
    async dispatch(channel, payload) {
      const ctx = getContext();
      if (!ctx.email) {
        return { delivered: false, detail: 'send_email binding (EMAIL) not configured' };
      }
      let addr: EmailThreadAddr;
      try {
        addr = v.parse(EmailThreadAddrSchema, JSON.parse(channel.holder_addr));
      } catch (error) {
        return { delivered: false, detail: `malformed email_thread holder_addr: ${renderThrownChain({ cause: error })}` };
      }
      if (!addr.to || !addr.from) {
        return { delivered: false, detail: 'email_thread holder_addr missing addresses' };
      }
      // Idempotency key = the channel (one reply per channel); a lease re-drive
      // after a crash mid-send re-sends the SAME Message-ID, deduped downstream.
      const result = await ctx.outbox.send(
        ctx.email,
        `reply:${channel.id}`,
        threadReply(addr, ctx.agentDisplayName, payloadText(payload)),
        Date.now(),
      );
      if (result.status === 'failed') return { delivered: false, detail: result.error };
      return { delivered: true };
    },
  };
}

/**
 * Reply every open email_thread channel bound to the events a drained turn
 * consumed. Called from onChatResponse with the drainTurnId the core stamped
 * on the injected user message. Each attempt lands a `reply_attempt` audit
 * row. `pending` remains true while a retryable email channel is still open.
 */
export interface EmailReplyDispatchResult {
  delivered: number;
  pending: boolean;
}

export async function dispatchEmailRepliesForTurn(
  deps: { log: EventLog; replies: ReplyChannelStore },
  drainTurnId: string,
  replyText: string,
  now: number,
): Promise<EmailReplyDispatchResult> {
  const events = deps.log.query({ turn_id: drainTurnId, variant: 'email' });
  if (!replyText.trim()) {
    return {
      delivered: 0,
      pending: events.some((event) => deps.replies.findOpenByEvent(event.id, 'email_thread') !== null),
    };
  }
  let delivered = 0;
  for (const ev of events) {
    const channel = deps.replies.findOpenByEvent(ev.id);
    if (!channel || channel.kind !== 'email_thread') continue;
    const outcome = await deps.replies.reply(channel.id, replyText, now);
    deps.log.appendNonEventRow({
      kind: 'reply_attempt',
      turn_id: drainTurnId,
      step_idx: null,
      parent_id: ev.id,
      trace_id: ev.trace_id,
      payload: { channel_id: channel.id, kind: 'email_thread', outcome },
      now,
    });
    if (outcome.outcome === 'delivered') delivered++;
  }
  return {
    delivered,
    pending: events.some((event) => deps.replies.findOpenByEvent(event.id, 'email_thread') !== null),
  };
}

// ── Owner notifications ──────────────────────────────────────────

export interface OwnerEmailDeps {
  email: SendEmail | undefined;
  emailDomain: string | undefined;
  agentName: string;
  agentDisplayName: string;
  ownerEmail: string | null;
  /** Write-ahead + idempotency for the send (SPEC §7.4). */
  outbox: EmailOutbox;
}

/** One-off notification to the owner (changelog digest, job completion).
 *  Silently skips (returns false) when the platform email pieces aren't
 *  configured — email is a capability, never a requirement. `key` is the
 *  caller's stable idempotency key: a re-fire with the same key never
 *  double-sends. */
export async function sendOwnerEmail(
  deps: OwnerEmailDeps,
  note: { subject: string; text: string; key: string },
): Promise<boolean> {
  if (!deps.email || !deps.emailDomain || !deps.ownerEmail) return false;
  const result = await deps.outbox.send(deps.email, `owner:${note.key}`, {
    from: {
      email: agentEmailAddress(deps.agentName, deps.emailDomain),
      name: deps.agentDisplayName,
    },
    to: deps.ownerEmail,
    subject: `[${deps.agentDisplayName}] ${note.subject}`,
    text: note.text,
    headers: { 'Auto-Submitted': 'auto-generated' },
  }, Date.now());
  if (result.status === 'failed') {
    diagnostics.failure(
      'email.owner_notification_failed',
      new KinuError('unavailable', result.error),
      { workspace: deps.agentName, messageId: result.messageId },
    );
    return false;
  }
  return true;
}
