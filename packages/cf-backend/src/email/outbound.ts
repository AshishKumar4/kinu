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

import type { EventLog, ReplyChannelStore } from '@proteus/core';
import type { EmailThreadAddr } from '../events/ingress/email.js';
import { agentEmailAddress } from './inbound.js';

/** What the dispatcher needs at send time. Resolved per dispatch so binding
 *  and display-name changes never go stale on a long-lived DO. */
export interface EmailSendContext {
  /** The `send_email` Workers binding, when configured. */
  email: SendEmail | undefined;
  /** Friendly From name (agent display name). */
  agentDisplayName: string;
}

function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Threading headers per RFC 5322: reply points In-Reply-To at the inbound
 *  Message-ID and appends it to the inherited References chain. */
export function threadingHeaders(addr: Pick<EmailThreadAddr, 'message_id' | 'references'>): Record<string, string> {
  if (!addr.message_id) return {};
  return {
    'In-Reply-To': addr.message_id,
    References: addr.references ? `${addr.references} ${addr.message_id}` : addr.message_id,
  };
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const content = (payload as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? payload ?? '');
}

/** The `email_thread` ReplyDispatcher registered on the ReplyChannelStore. */
export function createEmailThreadDispatcher(
  getContext: () => EmailSendContext,
): import('@proteus/core').ReplyDispatcher {
  return {
    async dispatch(channel, payload) {
      const ctx = getContext();
      if (!ctx.email) {
        return { delivered: false, detail: 'send_email binding (EMAIL) not configured' };
      }
      let addr: EmailThreadAddr;
      try {
        addr = JSON.parse(channel.holder_addr) as EmailThreadAddr;
      } catch {
        return { delivered: false, detail: 'malformed email_thread holder_addr' };
      }
      if (!addr.to || !addr.from) {
        return { delivered: false, detail: 'email_thread holder_addr missing addresses' };
      }
      const text = payloadText(payload);
      const headers = threadingHeaders(addr);
      try {
        await ctx.email.send({
          from: { email: addr.from, name: ctx.agentDisplayName },
          to: addr.to,
          subject: replySubject(addr.subject),
          text,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        return { delivered: true };
      } catch (err) {
        return { delivered: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * Reply every open email_thread channel bound to the events a drained turn
 * consumed. Called from onChatResponse with the drainTurnId the core stamped
 * on the injected user message. Each attempt lands a `reply_attempt` audit
 * row. Returns the number of delivered replies.
 */
export async function dispatchEmailRepliesForTurn(
  deps: { log: EventLog; replies: ReplyChannelStore },
  drainTurnId: string,
  replyText: string,
  now: number,
): Promise<number> {
  if (!replyText.trim()) return 0;
  const events = deps.log.query({ turn_id: drainTurnId, variant: 'email' });
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
  return delivered;
}

// ── Owner notifications ──────────────────────────────────────────

export interface OwnerEmailDeps {
  email: SendEmail | undefined;
  emailDomain: string | undefined;
  agentName: string;
  agentDisplayName: string;
  ownerEmail: string | null;
}

/** One-off notification to the owner (changelog digest, job completion).
 *  Silently skips (returns false) when the platform email pieces aren't
 *  configured — email is a capability, never a requirement. */
export async function sendOwnerEmail(
  deps: OwnerEmailDeps,
  note: { subject: string; text: string },
): Promise<boolean> {
  if (!deps.email || !deps.emailDomain || !deps.ownerEmail) return false;
  try {
    await deps.email.send({
      from: {
        email: agentEmailAddress(deps.agentName, deps.emailDomain),
        name: deps.agentDisplayName,
      },
      to: deps.ownerEmail,
      subject: `[${deps.agentDisplayName}] ${note.subject}`,
      text: note.text,
    });
    return true;
  } catch (err) {
    console.warn('[proteus-email] owner notification failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
