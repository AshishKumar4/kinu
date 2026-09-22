/**
 * Outbound email outbox (agent-core SPEC §7.4). The idempotency key becomes a stable `Message-ID`,
 * so a re-drive of a pending intent is deduped downstream rather than delivered twice.
 */

import { argumentDigest } from '../safety/argument-digest';
import { scheduledOutbox, type Outbox } from './outbox';
import { type SqlExec } from '../types/primitives';
import * as v from 'valibot';
import { diagnostics, renderThrownChain, toKinuError } from "../obs/index";

interface EmailAddress {
  name: string;
  email: string;
}

export interface OutboundEmailMessage {
  from: string | EmailAddress;
  to: string | EmailAddress | (string | EmailAddress)[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

interface EmailSender {
  send(message: OutboundEmailMessage): Promise<{ messageId: string }>;
}

export type OutboundSendResult =
  | { status: 'sent'; messageId: string }
  | { status: 'deduped'; messageId: string }
  | { status: 'failed'; messageId: string; error: string };

const MAX_SEND_ATTEMPTS = 8;

const RETRY_BASE_MS = 30_000;

const MESSAGE_ID_HEADER = 'Message-ID';

export class EmailOutbox {
  private readonly outbox: Outbox<OutboundEmailMessage, EmailSender>;

  /** Awaited: on a Durable Object arming is a storage write, and an unawaited one is cancelled
   *  silently on reset (`do.wait_until.no_op`). */
  constructor(sql: SqlExec, scheduleRetry: (at: number) => Promise<void> = async () => {}) {
    this.outbox = scheduledOutbox<OutboundEmailMessage, EmailSender>(sql, 'email', {
      maxAttempts: MAX_SEND_ATTEMPTS,
      baseMs: RETRY_BASE_MS,
      schedule: scheduleRetry,
      // No `orderBy`: one provider outage must not hold unrelated mail.
      async send(message, _info, binding) {
        try {
          await binding.send(message);

          return { status: 'sent' };
        } catch (err) {
          // Counted without address, subject or body; `last_error` alone is invisible at fleet scale.
          diagnostics.failure('email.outbox_send_failed', toKinuError({
            doing: 'sending a queued outbound message',
            cause: err,
            otherwise: 'unavailable',
          }));

          return { status: 'retry', reason: renderThrownChain({ cause: err }) };
        }
      },
    });
  }

  /** A key already `sent` returns `deduped` without touching the binding. */
  async send(
    binding: EmailSender,
    key: string,
    message: OutboundEmailMessage,
    now: number,
  ): Promise<OutboundSendResult> {
    const stableId = messageIdFor(key, message.from);

    const stamped: OutboundEmailMessage = {
      ...message,
      headers: { ...message.headers, [MESSAGE_ID_HEADER]: stableId },
    };

    // `retry-now`: asking again clears backoff and revives a dead letter; a sent key stays final.
    const { id } = await this.outbox.queue(stamped, { dedupeKey: key, now, onDuplicate: 'retry-now' });
    const queued = this.outbox.status(id);

    if (queued?.state === 'sent') {
      return { status: 'deduped', messageId: messageIdOf(queued.message) ?? stableId };
    }

    await this.outbox.drain(now, { context: binding });
    const settled = this.outbox.status(id);
    const messageId = messageIdOf(settled?.message) ?? stableId;

    if (settled?.state === 'sent') return { status: 'sent', messageId };

    return { status: 'failed', messageId, error: settled?.lastError ?? 'the send did not complete' };
  }

  async reconcile(binding: EmailSender, now: number): Promise<number> {
    const { sent, retried, deadLettered } = await this.outbox.drain(now, { context: binding });

    return sent + retried + deadLettered;
  }

  nextRetryAt(): number | null {
    return this.outbox.nextRetryAt();
  }
}

function messageIdFor(key: string, from: OutboundEmailMessage['from']): string {
  return `<kinu.${argumentDigest(key)}@${emailDomainOf(from)}>`;
}

function messageIdOf(message: OutboundEmailMessage | null | undefined): string | null {
  return message?.headers?.[MESSAGE_ID_HEADER] ?? null;
}

function emailDomainOf(from: OutboundEmailMessage['from']): string {
  const address = emailAddressText(from);
  const at = address.lastIndexOf('@');

  return at >= 0 ? address.slice(at + 1) : 'kinu.local';
}

function emailAddressText(address: string | EmailAddress): string {
  return v.is(v.string(), address) ? address : address.email;
}
