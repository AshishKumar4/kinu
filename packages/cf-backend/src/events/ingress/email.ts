/**
 * Email ingress — inbound mail (Cloudflare Email Routing → Worker `email()`
 * handler) → EmailEvent via EventLog.publish.
 *
 * The Worker-level handler parses the MIME message, resolves the receiving
 * agent from the recipient address, and invokes the agent's
 * `acceptEmailDelivery` RPC, which runs this adapter inside the DO (direct
 * SQL, atomic publish). The trust gate — enforced HERE, before publish:
 *
 *   sender == owner's verified login email      → admitted (`sender_class: owner`,
 *                                                  trust `authenticated`)
 *   sender ∈ active email_route allowlist        → admitted (`sender_class:
 *                                                  allowlisted`, trust `external`)
 *   anyone else                                  → dropped; no event row exists
 *
 * Every admitted email opens an `email_thread` ReplyChannel carrying the
 * threading fields, so the turn's answer goes back as a real reply on the
 * same thread (In-Reply-To / References).
 */

import type {
  EventLog, ReplyChannelStore, EmailPayload, EmailAttachmentMeta, EventId,
} from '@proteus/core';
import { normalizeEmailAddress } from '../../email/inbound.js';

/** Threading envelope stored in the reply channel's holder_addr (JSON). */
export interface EmailThreadAddr {
  /** Reply recipient — the inbound envelope sender. */
  to: string;
  /** Reply sender — the exact agent address the mail arrived at. */
  from: string;
  subject: string;
  /** Inbound Message-ID → outbound In-Reply-To. */
  message_id: string | null;
  /** Inbound References chain, extended with message_id on send. */
  references: string | null;
}

export interface EmailIngressDeps {
  log: EventLog;
  replies: ReplyChannelStore;
  /** Owner's verified login email (UserDO profile), or null when unknown. */
  owner_email: string | null;
  /** Active email_route allowlist (normalized happens here). */
  allowlist: ReadonlyArray<string>;
  /** Per-agent inbound budget. Returns false when spent. */
  tryConsumeRateLimit(now: number): boolean;
}

export interface IncomingEmail {
  from: string;
  to: string;
  subject: string;
  body_text: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  attachments: EmailAttachmentMeta[];
  now: number;
}

export type EmailIngressResult =
  | {
      admitted: true;
      event_id: EventId;
      /** True when dedupe matched an earlier delivery of the same message. */
      duplicate: boolean;
      sender_class: 'owner' | 'allowlisted';
    }
  | { admitted: false; reason: string };

/** Gate + publish an inbound email. Runs inside the agent DO. */
export function acceptInboundEmail(
  deps: EmailIngressDeps,
  msg: IncomingEmail,
): EmailIngressResult {
  // Sender identity is the envelope from as delivered by Cloudflare Email
  // Routing, whose edge enforces SPF/DKIM/DMARC before the Worker ever runs —
  // that upstream reliance is why even the owner's mail caps at trust
  // `authenticated` (see events/hub/trust.ts).
  const sender = normalizeEmailAddress(msg.from);
  const owner = deps.owner_email ? normalizeEmailAddress(deps.owner_email) : null;
  const sender_class: 'owner' | 'allowlisted' | null =
    owner && sender === owner
      ? 'owner'
      : deps.allowlist.some((a) => normalizeEmailAddress(a) === sender)
        ? 'allowlisted'
        : null;
  if (!sender_class) {
    return { admitted: false, reason: 'sender not authorized for this agent' };
  }
  if (!deps.tryConsumeRateLimit(msg.now)) {
    return { admitted: false, reason: 'inbound email rate limit exceeded' };
  }

  const payload: EmailPayload = {
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    body_text: msg.body_text,
    message_id: msg.message_id,
    in_reply_to: msg.in_reply_to,
    references: msg.references,
    attachments: msg.attachments,
  };

  const reply_channel_id = deps.replies.open({
    event_id: 'pending',           // bound to the real event id after publish
    kind: 'email_thread',
    holder_addr: JSON.stringify({
      to: msg.from,
      from: msg.to,
      subject: msg.subject,
      message_id: msg.message_id,
      references: msg.references,
    } satisfies EmailThreadAddr),
    payload_policy: 'full',
  }, msg.now);

  const { id, admitted } = deps.log.publish({
    descriptor: { ingress: 'email_inbound', variant: 'email', payload, sender_class },
    now: msg.now,
    reply_channel: reply_channel_id ? { id: reply_channel_id, kind: 'email_thread' } : undefined,
  });

  if (reply_channel_id) {
    if (admitted) {
      deps.replies.bindEvent(reply_channel_id, id);
    } else {
      // Retried delivery of an already-admitted message: the original event
      // already carries its thread channel.
      deps.replies.abort(reply_channel_id, msg.now, 'duplicate email delivery');
    }
  }

  return { admitted: true, event_id: id, duplicate: !admitted, sender_class };
}
