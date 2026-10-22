/**
 * The one inbound mail path (docs/MAIL.md §4): Email Routing's catch-all on EMAIL_DOMAIN delivers every message here.
 * The recipient names a box; its label's MailName names the account; the account's Mailbox files the message and
 * decides, from Cloudflare's verdict and the box's policy, whom it wakes. Pure of platform imports: `email()` in
 * server.ts binds the objects.
 *
 * An unknown address is refused at SMTP time, so the sender learns it bounced. Every message to a real box is kept,
 * list and machine mail included (a GitHub notification is mail the person reads); only a machine's message never
 * wakes anyone, since an answer to an auto-reply would loop.
 */
import { isAutoReplyEmail, parseMailRecipient, readBounded, type MailDelivery, type MailRecipient } from '@kinu.run/core';
import { KinuError, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { MailboxDO } from './mailbox-do';
import type { MailNameDO } from './mailname-do';

/** Email Routing's own ceiling (email.routing.message_bytes): nothing larger arrives. */
const INBOUND_MAIL_MAX_BYTES = 25 * 1024 * 1024;

export interface InboundMail {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  /** A pre-filter, never the gate: the bytes are counted as they arrive. */
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface MailRouterDeps {
  readonly domain: string | undefined;
  /** The label's MailName, which holds its claim. */
  name(label: string): Pick<MailNameDO, 'lookup'>;
  mailbox(userId: string): Pick<MailboxDO, 'deliver'>;
  /** Hands an arrival to the workspace whose agent it woke. */
  wake(delivery: MailDelivery & { readonly wake: NonNullable<MailDelivery['wake']> }, recipient: MailRecipient): Promise<void>;
  /** Tells the person's assistant new mail waits for its triage; answers even when the assistant does not, the mail filed. */
  triage(reader: NonNullable<MailDelivery['triage']>): Promise<void>;
}

export type MailRouting =
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'filed'; readonly delivery: MailDelivery; readonly woke: boolean };

/** The box a recipient reaches: its label's account, and the path under it (an alias names a box directly). */
async function resolve(deps: MailRouterDeps, to: string): Promise<{ userId: string; recipient: MailRecipient } | null> {
  const recipient = parseMailRecipient(to, deps.domain ?? '');

  if (deps.domain === undefined || deps.domain === '' || recipient === null) return null;

  const claim = await deps.name(recipient.username).lookup();

  // A name kept with no owner is retired: it routes nowhere, and its row keeps anyone from claiming it again.
  if (claim === null || claim.user_id === '') return null;

  // An alias is a whole address of its own: `hello@D` reaching a workspace's box.
  if (claim.kind === 'alias') {
    return recipient.path === '' ? { userId: claim.user_id, recipient: { ...recipient, path: claim.target_path ?? '' } } : null;
  }

  return { userId: claim.user_id, recipient };
}

export async function routeInboundMail(message: InboundMail, deps: MailRouterDeps): Promise<MailRouting> {
  const target = await resolve(deps, message.to);

  if (target === null) {
    message.setReject('No such address here.');

    return { outcome: 'refused', reason: `unknown recipient ${message.to}` };
  }

  if (message.rawSize > INBOUND_MAIL_MAX_BYTES) {
    message.setReject('The message is larger than this address accepts.');

    return { outcome: 'refused', reason: `over ${String(INBOUND_MAIL_MAX_BYTES)} bytes` };
  }

  // message.raw is single-use; the declared size is the sender's claim, the count is ours.
  const raw = await readBounded(message.raw, INBOUND_MAIL_MAX_BYTES);

  if (raw === 'too_large') {
    message.setReject('The message is larger than this address accepts.');

    return { outcome: 'refused', reason: `over ${String(INBOUND_MAIL_MAX_BYTES)} bytes` };
  }

  // A stream that broke mid-read fails the delivery, so Email Routing tries it again.
  if (raw instanceof KinuError) return await settle(Effect.fail(raw));

  const delivery = await deps.mailbox(target.userId).deliver({ raw, envelopeFrom: message.from, recipient: target.recipient });

  if (delivery === null) {
    message.setReject('No such address here.');

    return { outcome: 'refused', reason: `no box at ${message.to}` };
  }

  if (delivery.triage !== null) await deps.triage(delivery.triage);

  const wake = delivery.wake;

  // A redelivery is handed on again: the handoff may be what failed, and the workspace admits a Message-ID once.
  if (wake === null || isAutoReplyEmail(message.headers)) return { outcome: 'filed', delivery, woke: false };

  await deps.wake({ ...delivery, wake }, target.recipient);

  return { outcome: 'filed', delivery, woke: true };
}
