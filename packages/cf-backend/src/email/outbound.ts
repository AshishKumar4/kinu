/**
 * Mission Inbox — outbound side, over the Workers `send_email` binding
 * (Cloudflare Email Sending). Three surfaces, one send path:
 *
 *   createEmailThreadDispatcher — the `email_thread` ReplyDispatcher: a
 *     drained turn's answer goes back onto the inbound mail's thread with
 *     correct In-Reply-To / References.
 *   dispatchEmailRepliesForTurn — called at turn completion with the drain
 *     turn id the core stamped on the injected message; replies every open
 *     email_thread channel of the events that turn consumed.
 *   sendOwnerEmail — standalone notification to the owner's verified email
 *     (Evolution Changelog digests, background-job completions).
 */

import { JsonValueSchema, type EmailThreadAddr, type EventLog, type JsonValue, type ReplyChannelStore } from '@kinu/core';
import { agentEmailAddress } from './inbound';
import type { EmailOutbox } from './outbox';
import { diagnostics, KinuError } from '@kinu/core/obs';
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

/** Threading headers per RFC 5322: reply points In-Reply-To at the inbound
 *  Message-ID and appends it to the inherited References chain. */
export function threadingHeaders(addr: Pick<EmailThreadAddr, 'message_id' | 'references'>): EmailThreadingHeaders {
  if (!addr.message_id) return {};
  return {
    'In-Reply-To': addr.message_id,
    References: addr.references ? `${addr.references} ${addr.message_id}` : addr.message_id,
  };
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
): import('@kinu/core').ReplyDispatcher {
  return {
    async dispatch(channel, payload) {
      const ctx = getContext();
      if (!ctx.email) {
        return { delivered: false, detail: 'send_email binding (EMAIL) not configured' };
      }
      let addr: EmailThreadAddr;
      try {
        addr = v.parse(EmailThreadAddrSchema, JSON.parse(channel.holder_addr));
      } catch {
        return { delivered: false, detail: 'malformed email_thread holder_addr' };
      }
      if (!addr.to || !addr.from) {
        return { delivered: false, detail: 'email_thread holder_addr missing addresses' };
      }
      const text = payloadText(payload);
      // RFC 3834: mark our reply auto-replied so peers (and our own inbound
      // guard) don't bounce it back into an infinite thread loop.
      const headers = { 'Auto-Submitted': 'auto-replied', ...threadingHeaders(addr) };
      // Idempotency key = the channel (one reply per channel); a lease re-drive
      // after a crash mid-send re-sends the SAME Message-ID, deduped downstream.
      const result = await ctx.outbox.send(ctx.email, `reply:${channel.id}`, {
        from: { email: addr.from, name: ctx.agentDisplayName },
        to: addr.to,
        subject: replySubject(addr.subject),
        text,
        headers,
      }, Date.now());
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
