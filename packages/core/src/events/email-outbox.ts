/**
 * Outbound email outbox (agent-core SPEC §7.4): a key already sent is never sent again. Email Service writes the
 * Message-ID itself and refuses one we set (developers.cloudflare.com/email-service/reference/headers, read
 * 2026-10-05), so a send whose answer was lost is sent once more.
 */

import { Effect } from 'effect';
import { scheduledOutbox, type Outbox, type OutboxDisposition } from './outbox';
import { type SqlExec } from '../types/primitives';
import { diagnostics, renderThrownChain, settle, toKinuError } from "../obs/index";

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
  | { status: 'sent' }
  | { status: 'deduped' }
  | { status: 'failed'; error: string };

const MAX_SEND_ATTEMPTS = 8;

const RETRY_BASE_MS = 30_000;

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
      send(message, _info, binding) {
        return settle(Effect.tryPromise({ try: () => binding.send(message), catch: (cause) => ({ cause }) }).pipe(Effect.match({
          onSuccess: (): OutboxDisposition => ({ status: 'sent' }),
          onFailure: (failed): OutboxDisposition => {
            // Counted without address, subject or body; `last_error` alone is invisible at fleet scale.
            diagnostics.failure('email.outbox_send_failed', toKinuError({
              doing: 'sending a queued outbound message',
              cause: failed.cause,
              otherwise: 'unavailable',
            }));

            return { status: 'retry', reason: renderThrownChain(failed) };
          },
        })));
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
    // `retry-now`: asking again clears backoff and revives a dead letter; a sent key stays final.
    const { id } = await this.outbox.queue(message, { dedupeKey: key, now, onDuplicate: 'retry-now' });

    if (this.outbox.status(id)?.state === 'sent') return { status: 'deduped' };

    await this.outbox.drain(now, { context: binding });
    const settled = this.outbox.status(id);

    if (settled?.state === 'sent') return { status: 'sent' };

    return { status: 'failed', error: settled?.lastError ?? 'the send did not complete' };
  }

  async reconcile(binding: EmailSender, now: number): Promise<number> {
    const { sent, retried, deadLettered } = await this.outbox.drain(now, { context: binding });

    return sent + retried + deadLettered;
  }

  nextRetryAt(): number | null {
    return this.outbox.nextRetryAt();
  }
}
