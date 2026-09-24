/** Inbound mail gate: the owner's verified address or an active email_route allowlist entry is
 *  admitted; anyone else is dropped with no event row. */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { ReplyChannelStore } from '../hub/reply-channel';
import type { TriggerRegistry } from '../hub/triggers';
import type { EmailAttachmentMeta, EmailPayload, EventId } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import type { SqlExec, VFS } from '../../types/primitives';
import type { MissingCapability } from '../../types/dynamic-context';
import { argumentDigest } from '../../safety/argument-digest';
import { tryConsumeWebhookRateLimit } from './rate-limit';
import { diagnostics, toKinuError } from '../../obs/index';

/** All senders combined. Drops are announced so the agent is not silently deaf. */
export const EMAIL_INBOUND_RATE_PER_MIN = 30;

const EmailAllowlistSchema = v.object({ allow: v.optional(v.array(v.string())) });

const EMAIL_INBOUND_RATE_KEY = 'email:inbound';

export function normalizeEmailAddress(raw: string): string {
  const angled = raw.match(/<([^<>]+)>\s*$/);

  return (angled ? angled[1] : raw).trim().toLowerCase();
}

/** Null once the window has reset, so a turn is never told about deafness that has ended. */
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

/** RFC 5322 §2.1.1 line limit, excluding CRLF; each bound subtracts its own field name. */
const RFC5322_LINE_OCTETS = 998;

const MSG_ID = /^<[\x21-\x3D\x3F-\x7E]+>$/;

/** Null rather than truncated: a truncated msg-id is a different identity. */
export function boundedMessageId(raw: string | null, fieldName = 'Message-ID'): string | null {
  const id = raw?.trim() ?? '';

  if (!MSG_ID.test(id)) return null;

  return id.length + fieldName.length + 2 <= RFC5322_LINE_OCTETS ? id : null;
}

/** Keeps the first and most recent ids (RFC 5537 §3.4.4), trimming from the second entry. */
export function boundedReferences(references: string | null, appended: string | null): string | null {
  const chain = (references ?? '').split(/\s+/)
    .filter((id) => MSG_ID.test(id));

  const last = boundedMessageId(appended, 'References');

  if (last && chain[chain.length - 1] !== last) chain.push(last);

  if (chain.length === 0) return null;

  const budget = RFC5322_LINE_OCTETS - 'References'.length - 2;
  let octets = chain.reduce((sum, id) => sum + id.length + 1, -1);

  while (octets > budget && chain.length > 1) {
    octets -= chain[1].length + 1;
    chain.splice(1, 1);
  }

  return octets > budget ? null : chain.join(' ');
}

export interface EmailThreadAddr {
  to: string;
  from: string;
  subject: string;
  message_id: string | null;
  references: string | null;
}

/** One builder for reply channel, event payload and receipt, so the bounds cannot drift. */
function emailThreadAddr(msg: IncomingEmail): EmailThreadAddr {
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
  owner_email: string | null;
  allowlist: ReadonlyArray<string>;
  tryConsumeRateLimit(now: number): boolean;
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
      duplicate: boolean;
      sender_class: 'owner' | 'allowlisted';
      thread: EmailThreadAddr;
    }
  | { admitted: false; reason: string };

/** Shared by the transport's pre-parse check and admission so they cannot drift. */
function classifyEmailSender(
  from: string,
  ownerEmail: string | null,
  allowlist: ReadonlyArray<string>,
): 'owner' | 'allowlisted' | null {
  // The mail edge enforces SPF/DKIM/DMARC upstream; hence the owner caps at `authenticated`.
  const sender = normalizeEmailAddress(from);
  const owner = ownerEmail ? normalizeEmailAddress(ownerEmail) : null;

  if (owner && sender === owner) return 'owner';

  return allowlist.some((a) => normalizeEmailAddress(a) === sender) ? 'allowlisted' : null;
}

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

  // Spilled after the gate so an unauthorized sender never writes a file.
  const spilled = await spillEventContent(deps.vfs, msg.body_text);

  const thread = emailThreadAddr(msg);

  const payload: EmailPayload = {
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    body_text: msg.body_text,
    // Bounded identity, not raw sender headers, which are stored and replayed on every reply.
    message_id: thread.message_id,
    in_reply_to: boundedMessageId(msg.in_reply_to, 'In-Reply-To'),
    references: thread.references,
    attachments: msg.attachments,
    body_path: spilled?.path,
    body_unsaved: spilled?.unsaved,
  };

  const reply_channel_id = deps.replies.open({
    event_id: 'pending',
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
      deps.replies.abort(reply_channel_id, msg.now, 'duplicate email delivery');
    }
  }

  return { admitted: true, event_id: id, duplicate: !admitted, sender_class, thread };
}

export function readEmailAllowlist(registry: TriggerRegistry): string[] {
  return registry.list({ kind: 'email_route', state: 'active' })
    .flatMap((t) => {
      const spec = v.safeParse(EmailAllowlistSchema, t.spec);

      return spec.success ? (spec.output.allow ?? []) : [];
    });
}

/** The owner's address is always allowed; an empty list revokes the email_route trigger. */
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

export interface EmailInboxDeps {
  log: EventLog;
  replies: ReplyChannelStore;
  triggers: TriggerRegistry;
  vfs(): VFS;
  sql: SqlExec;
  ownerEmail(): Promise<string | null>;
  onAdmitted(): void;
}

export interface EmailAdmission {
  admitted: boolean;
  duplicate?: boolean;
  event_id?: string;
  reason?: string;
  thread?: EmailThreadAddr;
}

/** One drop announcement per rate window, held in memory: a re-announce after eviction is
 *  harmless, a row per dropped message is not. */
export class EmailInbox {
  private dropWindow = 0;
  private dropCount = 0;

  constructor(private readonly deps: EmailInboxDeps) {}

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

    if (!result.duplicate) this.deps.onAdmitted();

    return {
      admitted: true, duplicate: result.duplicate, event_id: result.event_id, thread: result.thread,
    };
  }

  /** Pre-parse check with the same rule as `accept`, which asks again before anything durable. */
  async authorizes(from: string): Promise<{ authorized: boolean; reason?: string }> {
    const ownerEmail = await this.deps.ownerEmail();

    if (!ownerEmail) return { authorized: false, reason: 'agent owner email unknown' };
    const sender_class = classifyEmailSender(from, ownerEmail, readEmailAllowlist(this.deps.triggers));

    return sender_class
      ? { authorized: true }
      : { authorized: false, reason: 'sender not authorized for this agent' };
  }

  dropNotice(now: number): MissingCapability | null {
    return inboundEmailDropNotice(EMAIL_INBOUND_RATE_PER_MIN, this.dropWindow, now);
  }

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
            // Operator audit only; the model reads the live inbox line instead.
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

export interface OwnerNotification {
  subject: string;
  text: string;
  key: string;
}

/** Email is the away channel: skipped while an operator socket is live or when
 *  `email_notifications=false`. */
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
