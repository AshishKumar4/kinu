/**
 * Outbound email intent log — write-ahead + idempotency for at-least-once mail
 * (agent-core SPEC §7.4). Mission-inbox replies and owner notifications are
 * external sends driven by a delivery lease that re-runs after crash/eviction;
 * without this, a retry re-sends the same mail.
 *
 * The discipline mirrors the peer outbox:
 *   1. WRITE-AHEAD — the send intent (idempotency key, target, payload digest,
 *      rendered message, stable Message-ID) is committed `state='pending'`
 *      BEFORE the binding.send call.
 *   2. IDEMPOTENCY KEY — the caller's stable key materializes on the wire as a
 *      deterministic `Message-ID`, so the receiver (and our own inbound dedupe,
 *      which keys on Message-ID) treats a redelivery as the same message. A key
 *      already `state='sent'` short-circuits: we never re-send it.
 *   3. RECONCILIATION — SMTP has no "did key X land?" query, so an intent left
 *      `pending` (crash between send and the status write) is re-driven by the
 *      alarm sweep. Because the Message-ID is stable, the re-drive is a SAFE
 *      re-send (deduped downstream), not a blind new message.
 */

import { argumentDigest, type SqlExec } from '@proteus/core';
import * as v from 'valibot';

const EmailAddressSchema = v.object({ email: v.string(), name: v.string() });
const OutboundEmailMessageSchema = v.object({
  from: v.union([v.string(), EmailAddressSchema]),
  to: v.union([v.string(), EmailAddressSchema, v.array(v.union([v.string(), EmailAddressSchema]))]),
  subject: v.string(),
  text: v.string(),
  headers: v.optional(v.record(v.string(), v.string())),
});

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

/** Retry policy for the reconciliation sweep — exponential backoff from 30s,
 *  capped at 1h; an intent dead-letters after 8 attempts. */
const MAX_SEND_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 3_600_000;

export const EMAIL_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS email_outbox (
  idempotency_key TEXT    PRIMARY KEY,
  message         TEXT    NOT NULL,
  message_id      TEXT    NOT NULL,
  payload_digest  TEXT    NOT NULL,
  state           TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'sent', 'dlq')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  last_error      TEXT
)`;

const EMAIL_OUTBOX_INDEX =
  `CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
   ON email_outbox (next_attempt_at) WHERE state = 'pending'`;

interface OutboxDbRow {
  idempotency_key: string;
  message: string;
  message_id: string;
  state: 'pending' | 'sent' | 'dlq';
  attempt_count: number;
}
const OutboxDbRowSchema = v.object({
  idempotency_key: v.string(),
  message: v.string(),
  message_id: v.string(),
  state: v.picklist(['pending', 'sent', 'dlq']),
  attempt_count: v.number(),
});

export class EmailOutbox {
  /** `scheduleRetry` arms the host's timer for a backed-off re-drive. Without
   *  it the outbox has no scheduler of its own and a failed send only retries
   *  if some unrelated timer happens to wake the agent. Awaited: on a Durable
   *  Object arming is a storage write, and an unawaited one is cancelled
   *  silently on reset (`do.wait_until.no_op`). */
  constructor(
    private readonly sql: SqlExec,
    private readonly scheduleRetry: (at: number) => Promise<void> = async () => {},
  ) {}

  ensureSchema(): void {
    this.sql.exec(EMAIL_OUTBOX_DDL);
    this.sql.exec(EMAIL_OUTBOX_INDEX);
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
    const existing = this.row(key);
    if (existing?.state === 'sent') {
      return { status: 'deduped', messageId: existing.message_id };
    }

    const messageId = existing?.message_id ?? this.messageIdFor(key, message.from);
    if (!existing) {
      this.sql.exec(
        `INSERT INTO email_outbox
           (idempotency_key, message, message_id, payload_digest, state, attempt_count, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        key, JSON.stringify(message), messageId, payloadDigest(message), now, now,
      );
    }
    return this.deliver(binding, key, message, messageId, now);
  }

  /** Alarm-swept reconciliation: re-drive every due `pending` intent. Each
   *  re-drive carries the original Message-ID, so a duplicate is deduped
   *  downstream rather than delivered twice. Returns the count re-driven. */
  async reconcile(binding: SendEmail, now: number): Promise<number> {
    const due = v.parse(v.array(OutboxDbRowSchema), this.sql.exec(
      `SELECT idempotency_key, message, message_id, state, attempt_count
         FROM email_outbox
        WHERE state = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at`,
      now,
    ).toArray());
    for (const row of due) {
      const message = v.parse(OutboundEmailMessageSchema, JSON.parse(row.message));
      await this.deliver(binding, row.idempotency_key, message, row.message_id, now);
    }
    return due.length;
  }

  /** Soonest pending retry — folded into the DO alarm reschedule. */
  nextRetryAt(): number | null {
    const rows = v.parse(v.array(v.object({ next: v.nullable(v.number()) })), this.sql.exec(
      `SELECT MIN(next_attempt_at) AS next FROM email_outbox WHERE state = 'pending'`,
    ).toArray());
    return rows[0]?.next ?? null;
  }

  private async deliver(
    binding: SendEmail,
    key: string,
    message: OutboundEmailMessage,
    messageId: string,
    now: number,
  ): Promise<OutboundSendResult> {
    try {
      await binding.send({
        ...message,
        headers: { ...message.headers, 'Message-ID': messageId },
      });
      this.sql.exec(
        `UPDATE email_outbox
            SET state = 'sent', attempt_count = attempt_count + 1, sent_at = ?, last_error = NULL
          WHERE idempotency_key = ?`,
        now, key,
      );
      return { status: 'sent', messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.recordFailure(key, error, now);
      return { status: 'failed', messageId, error };
    }
  }

  private async recordFailure(key: string, error: string, now: number): Promise<void> {
    const row = this.row(key);
    const attempts = (row?.attempt_count ?? 0) + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) {
      this.sql.exec(
        `UPDATE email_outbox SET state = 'dlq', attempt_count = ?, last_error = ? WHERE idempotency_key = ?`,
        attempts, `undeliverable after ${attempts} attempts: ${error}`, key,
      );
      return;
    }
    const next = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
    this.sql.exec(
      `UPDATE email_outbox SET attempt_count = ?, next_attempt_at = ?, last_error = ? WHERE idempotency_key = ?`,
      attempts, next, error, key,
    );
    await this.scheduleRetry(next);
  }

  private row(key: string): OutboxDbRow | null {
    const rows = v.parse(v.array(OutboxDbRowSchema), this.sql.exec(
      `SELECT idempotency_key, message, message_id, state, attempt_count
         FROM email_outbox WHERE idempotency_key = ?`, key,
    ).toArray());
    return rows[0] ?? null;
  }

  /** Deterministic Message-ID from the idempotency key: same key → same id, so
   *  a re-send is recognizably the same message to any receiver. */
  private messageIdFor(key: string, from: OutboundEmailMessage['from']): string {
    const domain = emailDomainOf(from);
    return `<proteus.${argumentDigest(key)}@${domain}>`;
  }
}

function payloadDigest(message: OutboundEmailMessage): string {
  const recipients = Array.isArray(message.to) ? message.to.map(emailAddressText) : emailAddressText(message.to);
  return argumentDigest({ to: recipients, subject: message.subject, text: message.text });
}

function emailDomainOf(from: OutboundEmailMessage['from']): string {
  const address = emailAddressText(from);
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : 'proteus.local';
}

function emailAddressText(address: string | EmailAddress): string {
  return v.is(v.string(), address) ? address : address.email;
}
