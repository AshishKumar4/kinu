/**
 * Outbound email intent log — write-ahead + idempotency for at-least-once mail
 * (agent-core SPEC §7.4). Mission-inbox replies and owner notifications are
 * external sends driven by a delivery lease that re-runs after crash/eviction;
 * without this, a retry re-sends the same mail.
 *
 * The generic half — the write-ahead row, backoff, dead-lettering, the
 * `nextRetryAt()` alarm fold — is the shared outbox (`@kinu.run/core`'s
 * `scheduledOutbox`). What is email's own and stays here:
 *   1. THE STABLE MESSAGE-ID. The caller's idempotency key materializes on the
 *      wire as a deterministic `Message-ID`, so the receiver (and our own
 *      inbound dedupe, which keys on Message-ID) treats a redelivery as the
 *      same message. It is stamped into the stored message, so every re-drive
 *      carries the id the first attempt carried.
 *   2. THE BINDING CALL. `send_email` has no "did key X land?" query, so an
 *      intent left pending (a crash between send and the status write) is
 *      re-driven by the alarm sweep. Because the Message-ID is stable, the
 *      re-drive is a SAFE re-send (deduped downstream), not a blind new message.
 *
 * The binding is resolved per call rather than closed over at construction —
 * `MonitorDO` builds its outbox before it has one — so it rides the outbox's
 * per-drain context.
 */

import { argumentDigest, scheduledOutbox, type Outbox, type SqlExec } from '@kinu.run/core';
import * as v from 'valibot';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

/** A rendered outbound message — exactly the `send_email` binding's payload. */
export interface OutboundEmailMessage {
  from: string | EmailAddress;
  to: string | EmailAddress | (string | EmailAddress)[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

export type OutboundSendResult =
  | { status: 'sent'; messageId: string }
  | { status: 'deduped'; messageId: string }
  | { status: 'failed'; messageId: string; error: string };

/** Retry policy for the reconciliation sweep — exponential backoff from 30s over
 *  at most 8 attempts, so the longest wait an intent gets is 30_000·2⁶ = 1,920 s
 *  and then it dead-letters. There is no ceiling constant beside the attempts:
 *  the longest wait above is the binding one, so an hour ceiling could never
 *  bind and would be a bound that cannot fail. The 30s base is this outbox's
 *  own (an outbound provider, not the in-process peer hub, whose base is 5s);
 *  only the dead-letter discipline is shared. */
const MAX_SEND_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;

const MESSAGE_ID_HEADER = 'Message-ID';

export class EmailOutbox {
  private readonly outbox: Outbox<OutboundEmailMessage, SendEmail>;

  /** `scheduleRetry` arms the host's timer for a backed-off re-drive. Without
   *  it the outbox has no scheduler of its own and a failed send only retries
   *  if some unrelated timer happens to wake the agent. Awaited: on a Durable
   *  Object arming is a storage write, and an unawaited one is cancelled
   *  silently on reset (`do.wait_until.no_op`). */
  constructor(sql: SqlExec, scheduleRetry: (at: number) => Promise<void> = async () => {}) {
    this.outbox = scheduledOutbox<OutboundEmailMessage, SendEmail>(sql, 'email', {
      maxAttempts: MAX_SEND_ATTEMPTS,
      baseMs: RETRY_BASE_MS,
      schedule: scheduleRetry,
      // No `orderBy`: two unrelated notifications have no order between them,
      // and one provider outage must not hold the rest of the mail.
      async send(message, _info, binding) {
        try {
          await binding.send(message);
          return { status: 'sent' };
        } catch (err) {
          // A refused send is a value here: the disposition the outbox backs
          // off on. Rendered rather than rethrown so the stored `last_error`
          // keeps the whole cause chain.
          //
          // Counted as well as stored, because the RETRY LOOP was the silent
          // part: a row's `last_error` is only read by whoever already opened
          // that row, so mail that took six attempts to leave and mail that
          // left first time were indistinguishable at fleet scale. No address,
          // no subject and no body — the count and the classification are the
          // whole signal.
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

  /** Idempotent send. Records the intent write-ahead, stamps the stable
   *  Message-ID, sends once, and reconciles status. A key already `sent`
   *  returns `deduped` without touching the binding. */
  async send(
    binding: SendEmail,
    key: string,
    message: OutboundEmailMessage,
    now: number,
  ): Promise<OutboundSendResult> {
    const stableId = messageIdFor(key, message.from);
    const stamped: OutboundEmailMessage = {
      ...message,
      headers: { ...message.headers, [MESSAGE_ID_HEADER]: stableId },
    };
    // `retry-now` re-admits an unsent key: a caller asking again means new
    // intent, so the row's backoff is cleared and a dead letter returns to
    // pending with its attempt count kept. A sent key stays final.
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

  /** Alarm-swept reconciliation: re-drive every due `pending` intent. Each
   *  re-drive carries the original Message-ID, so a duplicate is deduped
   *  downstream rather than delivered twice. Returns the count re-driven. */
  async reconcile(binding: SendEmail, now: number): Promise<number> {
    const { sent, retried, deadLettered } = await this.outbox.drain(now, { context: binding });
    return sent + retried + deadLettered;
  }

  /** Soonest pending retry — folded into the DO alarm reschedule. */
  nextRetryAt(): number | null {
    return this.outbox.nextRetryAt();
  }
}

/** Deterministic Message-ID from the idempotency key: same key → same id, so
 *  a re-send is recognizably the same message to any receiver. */
function messageIdFor(key: string, from: OutboundEmailMessage['from']): string {
  return `<kinu.${argumentDigest(key)}@${emailDomainOf(from)}>`;
}

/** The Message-ID a stored intent already carries, so a re-drive and a dedupe
 *  hit both answer with the id the FIRST attempt put on the wire. */
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
