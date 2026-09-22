/**
 * Mission Inbox, outbound side, over the Workers `send_email` binding (Cloudflare Email Sending):
 * receipts, `email_thread` turn replies, and owner notifications share one send path.
 */

import {
  boundedMessageId, boundedReferences,
  JsonValueSchema,
  type EmailThreadAddr, type EventLog, type JsonValue, type ReplyChannelStore,
} from '@kinu.run/core';
import { agentEmailAddress } from './inbound';
import type { EmailOutbox, OutboundEmailMessage } from '@kinu.run/core';
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

/** Resolved per dispatch so binding and display-name changes never go stale on a long-lived DO. */
export interface EmailSendContext {
  email: SendEmail | undefined;
  agentDisplayName: string;
  /** Write-ahead + idempotency for the send (SPEC §7.4). */
  outbox: EmailOutbox;
}

function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** RFC 5322 §3.6.4 threading; `boundedReferences` keeps the chain under the 998-octet line limit
 *  receivers may enforce. */
function threadingHeaders(addr: Pick<EmailThreadAddr, 'message_id' | 'references'>): EmailThreadingHeaders {
  const inReplyTo = boundedMessageId(addr.message_id, 'In-Reply-To');

  if (!inReplyTo) return {};

  return {
    'In-Reply-To': inReplyTo,
    References: boundedReferences(addr.references, inReplyTo) ?? inReplyTo,
  };
}

/** Shared by turn answers and receipts. RFC 3834 `Auto-Submitted: auto-replied` stops responders
 *  bouncing this into an endless thread. */
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
 * Immediate acknowledgement, since a turn may be slow or produce no reply. Idempotent through the outbox:
 * keyed by the admitted event id, which ingress dedupe keeps stable across redeliveries.
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

      // One reply per channel; a lease re-drive after a mid-send crash re-sends the same Message-ID, deduped downstream.
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

/** `pending` stays true while a retryable email channel is still open. */
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

export interface OwnerEmailDeps {
  email: SendEmail | undefined;
  emailDomain: string | undefined;
  agentName: string;
  agentDisplayName: string;
  ownerEmail: string | null;
  /** Write-ahead + idempotency for the send (SPEC §7.4). */
  outbox: EmailOutbox;
}

/** Returns false when email is not configured (a capability, never a requirement). `key` is a stable
 *  idempotency key: a re-fire never double-sends. */
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
