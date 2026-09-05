/**
 * Email ingress — inbound mail becomes a durable event, and the owner's
 * away-channel notifications decide whether to send.
 *
 * The backend in front of this owns the mail transport: parsing MIME,
 * resolving which agent an address belongs to, and putting bytes on the wire.
 * The gate is here, and it runs before anything is stored:
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

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { ReplyChannelStore } from '../hub/reply-channel';
import type { TriggerRegistry } from '../hub/triggers';
import type { EmailAttachmentMeta, EmailPayload, EventId } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import type { SqlExec, VFS } from '../../types/primitives';
import type { MissingCapability } from '../../prompting/volatile-context';
import { argumentDigest } from '../../safety/argument-digest';
import { tryConsumeWebhookRateLimit } from './rate-limit';
import { diagnostics, toKinuError } from '../../obs/index';

/**
 * Inbound-email budget per agent (all senders combined). Email is a wake
 * channel, not a data plane — mail beyond this is dropped at the gate. The drop
 * is announced to the agent: a reply storm or a list subscription otherwise
 * makes it silently deaf while it believes it has seen its inbox.
 */
export const EMAIL_INBOUND_RATE_PER_MIN = 30;
const EmailAllowlistSchema = v.object({ allow: v.optional(v.array(v.string())) });

/** All senders share one rate-limit window; the key is not a trigger id. */
const EMAIL_INBOUND_RATE_KEY = 'email:inbound';

/** Lowercase, trim, and strip a single `Name <addr>` / `<addr>` wrapper. */
export function normalizeEmailAddress(raw: string): string {
  const angled = raw.match(/<([^<>]+)>\s*$/);
  return (angled ? angled[1] : raw).trim().toLowerCase();
}

/**
 * The inbox gate as live turn state, while it is still refusing mail.
 *
 * A rate-limited delivery leaves no trace the agent can read: the sender gets
 * nothing, nothing is stored, and the agent goes on believing it has seen its
 * inbox. The durable `email_inbound_rate_limited` event records that it
 * happened; this says it is happening NOW and until when — and returns null
 * once the window has reset, so a turn is never told about a deafness that has
 * already ended.
 */
export function inboundEmailDropNotice(
  limitPerMin: number, windowResetsAt: number, now: number,
): MissingCapability | null {
  if (now >= windowResetsAt) return null;
  return {
    source: 'inbound email',
    reason:
      `dropping mail right now — more than ${limitPerMin} messages arrived within one minute and the gate `
      + `refuses the rest until ${new Date(windowResetsAt).toISOString()}. Mail sent in this window did not `
      + `reach you and was not stored: you have NOT seen your inbox.`,
  };
}

/**
 * RFC 5322 §2.1.1: a line of a message, not counting the CRLF, is at most 998
 * octets, and a receiver is not obliged to accept more. That is the whole
 * budget for a header field including its name, so each bound below subtracts
 * its own field name. Nothing here is a Kinu number.
 */
const RFC5322_LINE_OCTETS = 998;

/** A msg-id per RFC 5322 §3.6.4: angle-bracketed, no whitespace inside, and
 *  printable US-ASCII, which is all this application ever needs to recognise. */
const MSG_ID = /^<[\x21-\x3D\x3F-\x7E]+>$/;

/**
 * One inbound Message-ID, or null when the sender's is unusable.
 *
 * Null rather than a repair: a truncated msg-id is a DIFFERENT identity, so it
 * would thread the reply onto nothing while looking like it worked. Dropping
 * it costs the In-Reply-To and keeps the subject-based threading every client
 * falls back to.
 */
export function boundedMessageId(raw: string | null, fieldName = 'Message-ID'): string | null {
  const id = raw?.trim() ?? '';
  if (!MSG_ID.test(id)) return null;
  return id.length + fieldName.length + 2 <= RFC5322_LINE_OCTETS ? id : null;
}

/**
 * The References chain, bounded, with the thread's identity kept.
 *
 * A chain grows by one msg-id per reply and nothing in the protocol ever
 * shortens it, so a long-lived thread eventually writes a header no receiver
 * has to accept — and every id in it arrived from outside. Trimming is from
 * the SECOND entry forward: RFC 5537 §3.4.4 states the rule this application
 * follows — keep the first, keep the most recent — because the first id is
 * what a reader threads the conversation under and the last ones are what it
 * threads this message under. Dropping the tail instead would detach the reply
 * from the message it answers, which is the one thing References exists for.
 */
export function boundedReferences(references: string | null, appended: string | null): string | null {
  const chain = (references ?? '').split(/\s+/)
    .filter((id) => MSG_ID.test(id));
  const last = boundedMessageId(appended, 'References');
  if (last && chain[chain.length - 1] !== last) chain.push(last);
  if (chain.length === 0) return null;

  const budget = RFC5322_LINE_OCTETS - 'References'.length - 2;
  // Each entry after the first costs its own length plus the separating space.
  let octets = chain.reduce((sum, id) => sum + id.length + 1, -1);
  while (octets > budget && chain.length > 1) {
    octets -= chain[1]!.length + 1;
    chain.splice(1, 1);
  }
  // A single id longer than the whole budget cannot be represented at all.
  return octets > budget ? null : chain.join(' ');
}

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

/**
 * The thread one inbound message belongs to, bounded once, here.
 *
 * ONE builder, because the same identity is written to three places — the
 * reply channel's `holder_addr`, the event payload the model reads, and the
 * receipt that goes back immediately — and three constructions of it would
 * drift the first time a bound moved.
 */
export function emailThreadAddr(msg: IncomingEmail): EmailThreadAddr {
  return {
    to: msg.from,
    from: msg.to,
    subject: msg.subject,
    message_id: boundedMessageId(msg.message_id),
    references: boundedReferences(msg.references, null),
  };
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
  /** The receiving agent's file plane — an oversize body is spilled here so
   *  the woken turn can read the mail it was woken by. */
  vfs: VFS;
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
      /** The bounded thread identity this delivery belongs to — what a reply
       *  and the immediate receipt are both addressed with. */
      thread: EmailThreadAddr;
    }
  | { admitted: false; reason: string };

/** Which side of the inbox gate a sender falls on — the ONE comparison, so the
 *  pre-parse check the transport makes and the admission below cannot drift. */
function classifyEmailSender(
  from: string,
  ownerEmail: string | null,
  allowlist: ReadonlyArray<string>,
): 'owner' | 'allowlisted' | null {
  // Sender identity is the envelope from as delivered by the mail edge, which
  // enforces SPF/DKIM/DMARC before this ever runs — that upstream reliance is
  // why even the owner's mail caps at trust `authenticated` (events/hub/trust.ts).
  const sender = normalizeEmailAddress(from);
  const owner = ownerEmail ? normalizeEmailAddress(ownerEmail) : null;
  if (owner && sender === owner) return 'owner';
  return allowlist.some((a) => normalizeEmailAddress(a) === sender) ? 'allowlisted' : null;
}

/** Gate + publish an inbound email. Runs inside the agent's storage. */
export async function acceptInboundEmail(
  deps: EmailIngressDeps,
  msg: IncomingEmail,
): Promise<EmailIngressResult> {
  const sender_class = classifyEmailSender(msg.from, deps.owner_email, deps.allowlist);
  if (!sender_class) {
    return { admitted: false, reason: 'sender not authorized for this agent' };
  }
  if (!deps.tryConsumeRateLimit(msg.now)) {
    return { admitted: false, reason: 'inbound email rate limit exceeded' };
  }

  // Spilled after the gate so an unauthorized sender never writes a file —
  // the same ordering peer ingress uses. A mail longer than the brief budget
  // gets a readable path alongside the brief, because the agent is woken BY
  // this message and the brief alone is a fragment it cannot ask past.
  const bodyPath = await spillEventContent(deps.vfs, msg.body_text);

  const thread = emailThreadAddr(msg);
  const payload: EmailPayload = {
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    body_text: msg.body_text,
    // The bounded identity, not the sender's raw headers. An allowlisted
    // sender writes these, they are stored, rendered into the turn's brief and
    // put back on the wire on every reply, so the protocol's own limit is
    // applied once — at the point of admission — rather than by whichever
    // reader notices first.
    message_id: thread.message_id,
    in_reply_to: boundedMessageId(msg.in_reply_to, 'In-Reply-To'),
    references: thread.references,
    attachments: msg.attachments,
    body_path: bodyPath || undefined,
  };

  const reply_channel_id = deps.replies.open({
    event_id: 'pending',           // bound to the real event id after publish
    kind: 'email_thread',
    holder_addr: JSON.stringify(thread),
    payload_policy: 'full',
  }, msg.now);

  const { id, admitted } = deps.log.publish({
    descriptor: { ingress: 'email_inbound', variant: 'email', payload, sender_class },
    now: msg.now,
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

  return { admitted: true, event_id: id, duplicate: !admitted, sender_class, thread };
}

// ── The allowlist ────────────────────────────────────────────────

/** Union of active email_route allowlists (normally zero or one trigger). */
export function readEmailAllowlist(registry: TriggerRegistry): string[] {
  return registry.list({ kind: 'email_route', state: 'active' })
    .flatMap((t) => {
      const spec = v.safeParse(EmailAllowlistSchema, t.spec);
      return spec.success ? (spec.output.allow ?? []) : [];
    });
}

/**
 * Replace the inbound-email allowlist. The owner's own verified address is
 * always allowed and never needs listing; one active email_route trigger
 * (creator_trust recorded like every ingress) holds the extra senders, and an
 * empty list just revokes it.
 */
export async function setEmailAllowlist(
  registry: TriggerRegistry, allow: string[], now: number,
) {
  const cleaned = [...new Set(
    allow.map(normalizeEmailAddress).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)),
  )];
  for (const t of registry.list({ kind: 'email_route' })) {
    if (t.state !== 'revoked') registry.revoke(t.id, now);
  }
  if (cleaned.length > 0) {
    await registry.register({ kind: 'email_route', spec: { allow: cleaned }, creator_trust: 'owner' }, now);
  }
  return { allowlist: cleaned };
}

// ── The inbox ────────────────────────────────────────────────────

export interface EmailInboxDeps {
  log: EventLog;
  replies: ReplyChannelStore;
  triggers: TriggerRegistry;
  /** The agent's file plane, dereferenced per delivery (built lazily). */
  vfs(): VFS;
  /** Where the rate-limit windows live (the agent's own storage). */
  sql: SqlExec;
  /** Owner's verified login email, or null when unknown. */
  ownerEmail(): Promise<string | null>;
  /** A fresh event was admitted — wake the agent loop (debounced drain). */
  onAdmitted(): void;
}

export interface EmailAdmission {
  admitted: boolean;
  duplicate?: boolean;
  event_id?: string;
  reason?: string;
  /** Present on an admitted delivery: the bounded thread the sender wrote to,
   *  so the host can acknowledge on it without rebuilding the identity. */
  thread?: EmailThreadAddr;
}

/**
 * One agent's inbound mailbox: the trust gate, the shared rate window, and the
 * announcement the agent reads while that window is refusing mail.
 *
 * The drop announcement is stateful on purpose — one internal event per
 * rate-limit window, not one per dropped message. In memory: re-announcing once
 * after an eviction is harmless, a storm writing a row per message is not.
 */
export class EmailInbox {
  private dropWindow = 0;
  private dropCount = 0;

  constructor(private readonly deps: EmailInboxDeps) {}

  /** Gate, publish, and wake. Unauthorized senders never produce an event. */
  async accept(msg: IncomingEmail): Promise<EmailAdmission> {
    const ownerEmail = await this.deps.ownerEmail();
    if (!ownerEmail) return { admitted: false, reason: 'agent owner email unknown' };
    let rateDrop: { limit: number; resetAt: number } | null = null;
    const result = await acceptInboundEmail({
      log: this.deps.log,
      replies: this.deps.replies,
      owner_email: ownerEmail,
      allowlist: readEmailAllowlist(this.deps.triggers),
      vfs: this.deps.vfs(),
      tryConsumeRateLimit: (now) => {
        const decision = tryConsumeWebhookRateLimit(
          this.deps.sql, EMAIL_INBOUND_RATE_KEY, EMAIL_INBOUND_RATE_PER_MIN, now,
        );
        if (!decision.allowed) rateDrop = { limit: decision.limit, resetAt: decision.resetAt };
        return decision.allowed;
      },
    }, msg);
    if (!result.admitted) {
      if (rateDrop) this.noteRateDrop(rateDrop, msg.now);
      return { admitted: false, reason: result.reason };
    }
    // Wake the agent for a turn, debounced — only on fresh admission (a
    // duplicate delivery is already bound or in flight).
    if (!result.duplicate) this.deps.onAdmitted();
    return {
      admitted: true, duplicate: result.duplicate, event_id: result.event_id, thread: result.thread,
    };
  }

  /**
   * Whether this sender may reach the inbox at all — the transport's pre-parse
   * half of {@link accept}'s own first question, so an unauthorized message is
   * refused before it is buffered and MIME-parsed rather than after.
   *
   * Deliberately not a decision of its own: same owner address, same
   * allowlist, same comparison. It admits nothing — a yes only buys the sender
   * the parse, and `accept` asks again with the same rule before anything
   * durable happens.
   */
  async authorizes(from: string): Promise<{ authorized: boolean; reason?: string }> {
    const ownerEmail = await this.deps.ownerEmail();
    if (!ownerEmail) return { authorized: false, reason: 'agent owner email unknown' };
    const sender_class = classifyEmailSender(from, ownerEmail, readEmailAllowlist(this.deps.triggers));
    return sender_class
      ? { authorized: true }
      : { authorized: false, reason: 'sender not authorized for this agent' };
  }

  /** The live "I may be deaf right now" line for this turn's context. */
  dropNotice(now: number): MissingCapability | null {
    return inboundEmailDropNotice(EMAIL_INBOUND_RATE_PER_MIN, this.dropWindow, now);
  }

  /**
   * Tell the agent its inbox gate is dropping mail.
   *
   * One internal event per rate-limit window turns "I may be deaf right now"
   * into a fact it can act on — say so, ask the sender to resend, check back
   * after the window — without a row per dropped message.
   */
  private noteRateDrop(drop: { limit: number; resetAt: number }, now: number): void {
    if (drop.resetAt !== this.dropWindow) {
      this.dropWindow = drop.resetAt;
      this.dropCount = 0;
    }
    this.dropCount += 1;
    if (this.dropCount > 1) return;
    try {
      this.deps.log.publish({
        descriptor: {
          ingress: 'self_emit',
          variant: 'internal',
          emitting_head_trust: 'self',
          payload: {
            kind: 'email_inbound_rate_limited',
            // Audit detail for the operator's event log. It never reaches the
            // model through the brief (an internal payload's bytes are not
            // rendered); what the model reads is the live inbox line in the
            // turn's dynamic context, which also expires with the window.
            data: { limitPerMin: drop.limit, windowResetsAt: new Date(drop.resetAt).toISOString() },
          },
        },
        now,
      });
      this.deps.onAdmitted();
    } catch (err) {
      diagnostics.failure(
        'email.rate_drop_notice_failed',
        toKinuError({ doing: 'publish the inbound-email rate-drop notice', cause: err, otherwise: 'io' }),
        { limitPerMin: drop.limit },
      );
    }
  }
}

// ── Owner notifications (outbound) ───────────────────────────────

export interface OwnerNotification {
  subject: string;
  text: string;
  /** Idempotency key: a retry of the same notification dedupes downstream,
   *  while two genuinely distinct notifications key apart and both send. */
  key: string;
}

/**
 * Decide whether an owner notification should leave at all.
 *
 * Email is the away channel, not a duplicate feed: while an operator socket is
 * live the owner already sees the card in-app, and `email_notifications=false`
 * silences the channel outright.
 */
export function planOwnerNotification(input: {
  enabled: boolean;
  operatorConnected: boolean;
  subject: string;
  text: string;
}): OwnerNotification | null {
  if (!input.enabled || input.operatorConnected) return null;
  const { subject, text } = input;
  return { subject, text, key: argumentDigest({ subject, text }) };
}
