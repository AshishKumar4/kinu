import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * A workspace's side of an arrival (docs/MAIL.md §3-§4). The account's Mailbox has filed the message and decided, from
 * Cloudflare's DMARC verdict and the box's policy, that it wakes this workspace's agent, and on whose word: the
 * verified owner's (an instruction, its words in the event, a reply thread to their registered address) or anyone
 * else's (untrusted input: sender and subject only; the agent reads the body with `mail.read`, never as an order).
 */

import type { EventLog } from '../hub/log';
import type { ReplyChannelStore } from '../hub/reply-channel';
import type { EmailAttachmentMeta, EmailPayload, EventId } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import type { SqlExec } from '../../types/primitives';
import type { MissingCapability } from '../../types/dynamic-context';
import type { MailWoke } from '../../mail/mailbox-api';
import { argumentDigest } from '../../safety/argument-digest';
import { tryConsumeWebhookRateLimit } from './rate-limit';
import { Effect } from 'effect';
import { diagnostics, settleSync, toKinuError } from '../../obs/index';

/** All senders combined. Drops are announced so the agent is not silently deaf. */
export const EMAIL_INBOUND_RATE_PER_MIN = 30;

const EMAIL_INBOUND_RATE_KEY = 'email:inbound';

function normalizeEmailAddress(raw: string): string {
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
      `dropping mail right now: more than ${limitPerMin} messages arrived within one minute and the gate `
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

/** What the Mailbox hands the workspace whose agent an arrival woke. */
export interface MailArrival {
  /** On whose word it woke the agent: the verified owner's, or untrusted input. */
  woke: MailWoke;
  /** The From address Cloudflare's verdict passed. */
  from: string;
  /** The box address it reached. */
  to: string;
  subject: string;
  /** The owner's own words, quoted history set aside; null for input. */
  instruction: string | null;
  message_id: string | null;
  references: string | null;
  attachments: EmailAttachmentMeta[];
  /** Where it is filed: `mail.read(thread)` reads it. */
  mail: { box: string; thread: string; message: string };
  now: number;
}

export type MailAdmission =
  | { admitted: true; event_id: EventId; duplicate: boolean; woke: MailWoke; thread: EmailThreadAddr | null }
  | { admitted: false; reason: string };

export interface MailAdmissionDeps {
  log: EventLog;
  /** Where the owner's reply thread is kept; null where the woken agent answers in the app only. */
  replies: ReplyChannelStore | null;
  /** The workspace owner's sign-in email, asked again here: an address changed since the box was opened is not theirs. */
  owner_email: string | null;
  tryConsumeRateLimit(now: number): boolean;
  vfs: VFS;
}

/** Publishes the arrival to the event hub, and for the owner's mail opens the thread their reply goes back on. */
export async function admitMailArrival(deps: MailAdmissionDeps, arrival: MailArrival): Promise<MailAdmission> {
  const owner = deps.owner_email !== null && normalizeEmailAddress(deps.owner_email) === normalizeEmailAddress(arrival.from);
  const woke = arrival.woke === 'owner' && owner ? 'owner' : 'input';

  if (!deps.tryConsumeRateLimit(arrival.now)) return { admitted: false, reason: 'inbound email rate limit exceeded' };

  const words = woke === 'owner' ? arrival.instruction ?? '' : '';
  // Spilled only for the owner: input's body stays in the Mailbox, read with `mail.read` and marked untrusted.
  const spilled = words === '' ? null : await spillEventContent(deps.vfs, words);
  const message_id = boundedMessageId(arrival.message_id);
  const references = boundedReferences(arrival.references, null);

  const payload: EmailPayload = {
    from: arrival.from,
    to: arrival.to,
    subject: arrival.subject,
    body_text: words,
    message_id,
    in_reply_to: null,
    references,
    attachments: arrival.attachments,
    body_path: spilled?.path,
    body_unsaved: spilled?.unsaved,
    mail: arrival.mail,
  };

  // Only the owner's mail opens a reply thread, and it answers their registered address.
  const thread: EmailThreadAddr | null = woke === 'owner' && deps.replies !== null
    ? { to: arrival.from, from: arrival.to, subject: arrival.subject, message_id, references }
    : null;

  const reply_channel_id = thread === null ? null : deps.replies?.open({ event_id: 'pending', kind: 'email_thread', holder_addr: JSON.stringify(thread) }, arrival.now) ?? null;

  const { id, admitted } = deps.log.publish({
    descriptor: { ingress: 'email_inbound', variant: 'email', payload, sender_class: woke },
    now: arrival.now,
  });

  if (reply_channel_id) {
    if (admitted) deps.replies?.bindEvent(reply_channel_id, id);
    else deps.replies?.abort(reply_channel_id);
  }

  return { admitted: true, event_id: id, duplicate: !admitted, woke, thread };
}

export interface EmailInboxDeps {
  /** The woken agent's own event log: each agent of a workspace drains its own. */
  log(actorId: string): EventLog;
  /** The workspace's reply threads, its main agent's: only an arrival that woke it is answered by mail. */
  replies: ReplyChannelStore;
  mainActorId(): string;
  vfs(): VFS;
  sql: SqlExec;
  ownerEmail(): Promise<string | null>;
  onAdmitted(): void;
}

/** One drop announcement per rate window, held in memory: a re-announce after eviction is
 *  harmless, a row per dropped message is not. */
export class EmailInbox {
  private dropWindow = 0;
  private dropCount = 0;

  constructor(private readonly deps: EmailInboxDeps) {}

  async accept(arrival: MailArrival, actorId: string): Promise<MailAdmission> {
    let rateDrop: { limit: number; resetAt: number } | null = null;

    const result = await admitMailArrival({
      log: this.deps.log(actorId),
      replies: actorId === this.deps.mainActorId() ? this.deps.replies : null,
      owner_email: await this.deps.ownerEmail(),
      vfs: this.deps.vfs(),
      tryConsumeRateLimit: (now) => {
        const decision = tryConsumeWebhookRateLimit(
          this.deps.sql, EMAIL_INBOUND_RATE_KEY, EMAIL_INBOUND_RATE_PER_MIN, now,
        );

        if (!decision.allowed) rateDrop = { limit: decision.limit, resetAt: decision.resetAt };

        return decision.allowed;
      },
    }, arrival);

    if (!result.admitted) {
      if (!rateDrop) return result;

      return settleSync(Effect.as(this.noteRateDrop(rateDrop, arrival.now), result));
    }

    if (!result.duplicate) this.deps.onAdmitted();

    return result;
  }

  dropNotice(now: number): MissingCapability | null {
    return inboundEmailDropNotice(EMAIL_INBOUND_RATE_PER_MIN, this.dropWindow, now);
  }

  private noteRateDrop(drop: { limit: number; resetAt: number }, now: number): Effect.Effect<void> {
    if (drop.resetAt !== this.dropWindow) {
      this.dropWindow = drop.resetAt;
      this.dropCount = 0;
    }

    this.dropCount += 1;

    if (this.dropCount > 1) return Effect.void;

    return Effect.try({
      try: () => {
      this.deps.log(this.deps.mainActorId()).publish({
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
      },
      catch: (cause) => toKinuError({ doing: 'publish the inbound-email rate-drop notice', cause, otherwise: 'io' }),
    }).pipe(Effect.catch((failure) => Effect.sync(() => {
      diagnostics.failure('email.rate_drop_notice_failed', failure, { limitPerMin: drop.limit });
    })));
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
