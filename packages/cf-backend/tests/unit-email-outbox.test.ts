/**
 * EmailOutbox — write-ahead intent + idempotency for outbound mail
 * (agent-core SPEC §7.4). Asserts, at the store seam over bun:sqlite:
 *   - the intent row is committed `pending` BEFORE the binding.send lands;
 *   - a replay under the same idempotency key is a no-op (never re-sends);
 *   - a stable Message-ID rides every attempt (so a re-send is deduped, not new);
 *   - an indeterminate intent (crash mid-send) is RECONCILED — re-driven with the
 *     same key/Message-ID — rather than blind-retried or lost;
 *   - a permanent failure dead-letters after the attempt budget.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EmailOutbox, type OutboundEmailMessage } from '../src/email/outbox.js';
import type { SqlExec } from '@proteus/core';

function makeSql(): { sql: SqlExec; db: Database } {
  const db = new Database(':memory:');
  const sql: SqlExec = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
  return { sql, db };
}

type Sent = OutboundEmailMessage & { headers?: Record<string, string> };

/** A capture fake for the send_email binding.
 *  `onSend` can observe the outbox state mid-flight (before status is written)
 *  or throw to simulate a transport failure / crash. */
function fakeBinding(onSend?: (m: Sent) => void) {
  const sent: Sent[] = [];
  const binding = {
    async send(message: Sent) {
      onSend?.(message);
      sent.push(message);
      return { messageId: `ack-${sent.length}` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

function message(overrides: Partial<OutboundEmailMessage> = {}): OutboundEmailMessage {
  return {
    from: { email: 'scout@agents.example.com', name: 'Scout' },
    to: 'owner@example.com',
    subject: 'Deploy is green',
    text: 'All checks pass.',
    ...overrides,
  };
}

function outbox(): { box: EmailOutbox; sql: SqlExec } {
  const { sql } = makeSql();
  const box = new EmailOutbox(sql);
  box.ensureSchema();
  return { box, sql };
}

function rowFor(sql: SqlExec, key: string): Record<string, unknown> | undefined {
  return sql.exec(`SELECT * FROM email_outbox WHERE idempotency_key = ?`, key).toArray()[0];
}

describe('EmailOutbox — write-ahead intent', () => {
  test('the intent is committed pending BEFORE the send lands', async () => {
    const { box, sql } = outbox();
    let stateAtSend: unknown;
    const { binding } = fakeBinding(() => {
      // Inside the send call the row must already exist and be pending.
      stateAtSend = rowFor(sql, 'k1')?.state;
    });

    const result = await box.send(binding, 'k1', message(), 1_000);

    expect(stateAtSend).toBe('pending');
    expect(result.status).toBe('sent');
    const row = rowFor(sql, 'k1')!;
    expect(row.state).toBe('sent');
    expect(row.message_id).toMatch(/^<proteus\.[0-9a-f]{64}@agents\.example\.com>$/);
    expect(String(row.payload_digest)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('EmailOutbox — idempotency key', () => {
  test('a replay under the same key is a no-op (never re-sends)', async () => {
    const { box } = outbox();
    const { binding, sent } = fakeBinding();

    const first = await box.send(binding, 'dup', message(), 1_000);
    const second = await box.send(binding, 'dup', message(), 2_000);

    expect(first.status).toBe('sent');
    expect(second.status).toBe('deduped');
    expect(second.messageId).toBe(first.messageId);
    expect(sent).toHaveLength(1);
  });

  test('distinct keys each send and get distinct Message-IDs', async () => {
    const { box } = outbox();
    const { binding, sent } = fakeBinding();

    const a = await box.send(binding, 'a', message(), 1_000);
    const b = await box.send(binding, 'b', message(), 1_000);

    expect(sent).toHaveLength(2);
    expect(a.messageId).not.toBe(b.messageId);
  });
});

describe('EmailOutbox — reconciliation of an indeterminate', () => {
  test('a send that crashed mid-flight stays pending and is re-driven with the SAME Message-ID', async () => {
    const { box, sql } = outbox();

    // Attempt 1: the transport throws (crash / not-yet-verified sender).
    const failing = fakeBinding(() => { throw new Error('E_SENDER_NOT_VERIFIED'); });
    const first = await box.send(failing.binding, 'recon', message(), 1_000);
    expect(first.status).toBe('failed');

    const pending = rowFor(sql, 'recon')!;
    expect(pending.state).toBe('pending');          // indeterminate, not lost
    expect(pending.attempt_count).toBe(1);
    const boundMessageId = pending.message_id as string;

    // The alarm sweep re-drives due pending intents; now the binding accepts.
    const ok = fakeBinding();
    const reconciled = await box.reconcile(ok.binding, 10_000_000);

    expect(reconciled).toBe(1);
    expect(ok.sent).toHaveLength(1);
    // Re-driven under the ORIGINAL Message-ID — a safe re-send, not a new one.
    expect(ok.sent[0].headers?.['Message-ID']).toBe(boundMessageId);
    expect(first.messageId).toBe(boundMessageId);
    expect(rowFor(sql, 'recon')!.state).toBe('sent');
  });

  test('reconcile does not re-drive an already-sent intent (no blind retry)', async () => {
    const { box } = outbox();
    const { binding, sent } = fakeBinding();
    await box.send(binding, 'done', message(), 1_000);

    const redriven = await box.reconcile(binding, 10_000_000);

    expect(redriven).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test('nextRetryAt surfaces the soonest pending intent for the alarm fold', async () => {
    const { box } = outbox();
    const failing = fakeBinding(() => { throw new Error('down'); });
    await box.send(failing.binding, 'r', message(), 1_000);

    const next = box.nextRetryAt();
    expect(typeof next).toBe('number');
    expect(next!).toBeGreaterThan(1_000);
  });

  test('a failed send arms the host timer for its own backoff', async () => {
    // Without this the outbox has no scheduler: a retry only ever happened if
    // some unrelated timer woke the agent and the sweep noticed the row.
    const { sql } = makeSql();
    const armed: number[] = [];
    const box = new EmailOutbox(sql, (at) => { armed.push(at); });
    box.ensureSchema();
    const failing = fakeBinding(() => { throw new Error('down'); });

    await box.send(failing.binding, 'arm', message(), 1_000);

    expect(armed).toEqual([box.nextRetryAt()!]);
  });

  test('a dead-lettered intent arms nothing — there is no next attempt', async () => {
    const { sql } = makeSql();
    const armed: number[] = [];
    const box = new EmailOutbox(sql, (at) => { armed.push(at); });
    box.ensureSchema();
    const failing = fakeBinding(() => { throw new Error('permanent'); });
    await box.send(failing.binding, 'dead', message(), 0);
    for (let i = 1; i < 10; i++) await box.reconcile(failing.binding, i * 1_000_000_000);

    expect(box.nextRetryAt()).toBeNull();
    const settled = armed.length;
    await box.reconcile(failing.binding, 20_000_000_000);
    expect(armed).toHaveLength(settled);   // dead-lettered: nothing left to wake for
  });

  test('a permanently failing intent dead-letters after the attempt budget', async () => {
    const { box, sql } = outbox();
    const failing = fakeBinding(() => { throw new Error('permanent'); });
    await box.send(failing.binding, 'dead', message(), 0);
    // Advance `now` past each backoff so every reconcile actually re-drives,
    // exhausting the attempt budget.
    for (let i = 1; i < 10; i++) await box.reconcile(failing.binding, i * 1_000_000_000);

    const row = rowFor(sql, 'dead')!;
    expect(row.state).toBe('dlq');
    expect(box.nextRetryAt()).toBeNull();
  });
});
