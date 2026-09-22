/**
 * EmailOutbox write-ahead intent and idempotency (agent-core SPEC §7.4), over the shared
 * `outbox_email` rows: `dedupe_key` is the idempotency key; Message-ID rides the stored headers.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { EmailOutbox, type OutboundEmailMessage } from '@kinu.run/core';
import type { SqlExec } from '@kinu.run/core';
import { sqlExec } from './helpers/user-do';

function makeSql() {
  const db = new Database(':memory:');

  return { sql: sqlExec(db), db };
}

const SentSchema = v.object({
  from: v.union([v.string(), v.object({ email: v.string(), name: v.string() })]),
  to: v.union([
    v.string(),
    v.object({ email: v.string(), name: v.string() }),
    v.array(v.union([v.string(), v.object({ email: v.string(), name: v.string() })])),
  ]),
  subject: v.string(),
  text: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
});

type Sent = v.InferOutput<typeof SentSchema>;

type SendEmailBuilder = Parameters<SendEmail['send']>[0];

const OutboxTestRowSchema = v.object({
  state: v.picklist(['pending', 'sent', 'dlq']),
  message: v.string(),
  attempt_count: v.number(),
  next_attempt_at: v.number(),
});

/** `onSend` can observe the row mid-flight or throw to simulate a transport failure. */
function fakeBinding(onSend?: (m: Sent) => void) {
  const sent: Sent[] = [];
  function send(outgoing: EmailMessage): Promise<EmailSendResult>;
  function send(outgoing: SendEmailBuilder): Promise<EmailSendResult>;
  async function send(outgoing: EmailMessage | SendEmailBuilder): Promise<EmailSendResult> {
    const parsed = v.parse(SentSchema, outgoing);
    onSend?.(parsed);
    sent.push(parsed);

    return { messageId: `ack-${sent.length}` };
  }

  const binding: SendEmail = { send };

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

function outbox() {
  const { sql } = makeSql();

  return { box: new EmailOutbox(sql), sql };
}

/** Every intent is stamped before queueing, so a missing Message-ID is a defect. */
function rowFor(sql: SqlExec, key: string) {
  const row = sql.exec(
    `SELECT state, message, attempt_count, next_attempt_at FROM outbox_email WHERE dedupe_key = ?`, key,
  ).toArray()[0];

  if (row === undefined) return undefined;
  const parsed = v.parse(OutboxTestRowSchema, row);
  const stored = v.parse(SentSchema, JSON.parse(parsed.message));
  const messageId = stored.headers?.['Message-ID'];

  if (messageId === undefined) throw new Error(`stored intent ${key} carries no Message-ID`);

  return { ...parsed, messageId };
}

describe('EmailOutbox — write-ahead intent', () => {
  test('the intent is committed pending BEFORE the send lands', async () => {
    const { box, sql } = outbox();
    let stateAtSend: string | undefined;

    const { binding } = fakeBinding(() => {
      stateAtSend = rowFor(sql, 'k1')?.state;
    });

    const result = await box.send(binding, 'k1', message(), 1_000);

    expect(stateAtSend).toBe('pending');
    expect(result.status).toBe('sent');
    const row = rowFor(sql, 'k1');

    if (!row) throw new Error('expected persisted outbox row');
    expect(row.state).toBe('sent');
    expect(row.messageId).toMatch(/^<kinu\.[0-9a-f]{64}@agents\.example\.com>$/);
    expect(result.messageId).toBe(row.messageId);
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

  test('a sent key stays deduped however many times it is replayed', async () => {
    const { box, sql } = outbox();
    const { binding, sent } = fakeBinding();
    await box.send(binding, 'dup', message(), 1_000);

    for (let replay = 0; replay < 5; replay++) {
      expect((await box.send(binding, 'dup', message(), 2_000 + replay)).status).toBe('deduped');
    }

    expect(sent).toHaveLength(1);
    expect(rowFor(sql, 'dup')?.attempt_count).toBe(1);
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

describe('EmailOutbox — retry backoff', () => {
  test('each failed attempt doubles the wait from the 30s base', async () => {
    const { box, sql } = outbox();
    const failing = fakeBinding(() => { throw new Error('down'); });

    await box.send(failing.binding, 'curve', message(), 0);
    expect(rowFor(sql, 'curve')?.next_attempt_at).toBe(30_000);      // 30_000 · 2⁰

    await box.reconcile(failing.binding, 30_000);
    expect(rowFor(sql, 'curve')?.next_attempt_at).toBe(90_000);      // + 30_000 · 2¹

    await box.reconcile(failing.binding, 90_000);
    expect(rowFor(sql, 'curve')?.next_attempt_at).toBe(210_000);     // + 30_000 · 2²
  });

  test('a row still inside its backoff is not re-driven', async () => {
    const { box } = outbox();
    const failing = fakeBinding(() => { throw new Error('down'); });
    await box.send(failing.binding, 'early', message(), 0);
    expect(failing.sent).toHaveLength(0);   // the throw happens before the push

    const redriven = await box.reconcile(failing.binding, 29_999);

    expect(redriven).toBe(0);
  });
});

describe('EmailOutbox — reconciliation of an indeterminate', () => {
  test('a send that crashed mid-flight stays pending and is re-driven with the SAME Message-ID', async () => {
    const { box, sql } = outbox();

    const failing = fakeBinding(() => { throw new Error('E_SENDER_NOT_VERIFIED'); });
    const first = await box.send(failing.binding, 'recon', message(), 1_000);
    expect(first.status).toBe('failed');

    const pending = rowFor(sql, 'recon');

    if (!pending) throw new Error('expected pending outbox row');
    expect(pending.state).toBe('pending');          // indeterminate, not lost
    expect(pending.attempt_count).toBe(1);
    const boundMessageId = pending.messageId;

    const ok = fakeBinding();
    const reconciled = await box.reconcile(ok.binding, 10_000_000);

    expect(reconciled).toBe(1);
    expect(ok.sent).toHaveLength(1);
    // The original Message-ID makes this a safe re-send.
    expect(ok.sent[0].headers?.['Message-ID']).toBe(boundMessageId);
    expect(first.messageId).toBe(boundMessageId);
    expect(rowFor(sql, 'recon')?.state).toBe('sent');
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

    if (next === null) throw new Error('expected a scheduled retry');
    expect(next).toBeGreaterThan(1_000);
  });

  test('a failed send arms the host timer for its own backoff', async () => {
    // Otherwise a retry only happened if an unrelated timer woke the agent.
    const { sql } = makeSql();
    const armed: number[] = [];
    const box = new EmailOutbox(sql, async (at) => { armed.push(at); });
    const failing = fakeBinding(() => { throw new Error('down'); });

    await box.send(failing.binding, 'arm', message(), 1_000);

    const next = box.nextRetryAt();

    if (next === null) throw new Error('expected a scheduled retry');
    // Admission arms too; the last arm is this failure's backoff.
    expect(armed).toEqual([1_000, next]);
  });

  test('a dead-lettered intent arms nothing — there is no next attempt', async () => {
    const { sql } = makeSql();
    const armed: number[] = [];
    const box = new EmailOutbox(sql, async (at) => { armed.push(at); });
    const failing = fakeBinding(() => { throw new Error('permanent'); });
    await box.send(failing.binding, 'dead', message(), 0);

    for (let i = 1; i < 10; i++) await box.reconcile(failing.binding, i * 1_000_000_000);

    expect(box.nextRetryAt()).toBeNull();
    const settled = armed.length;
    await box.reconcile(failing.binding, 20_000_000_000);
    expect(armed).toHaveLength(settled);   // dead-lettered: nothing left to wake for
  });

  test('a permanently failing intent dead-letters ON the 8th attempt', async () => {
    const { box, sql } = outbox();
    let attempts = 0;
    const failing = fakeBinding(() => { attempts++; throw new Error('permanent'); });
    await box.send(failing.binding, 'dead', message(), 0);

    for (let i = 1; i < 10; i++) await box.reconcile(failing.binding, i * 1_000_000_000);

    const row = rowFor(sql, 'dead');

    if (!row) throw new Error('expected dead-lettered outbox row');
    expect(row.state).toBe('dlq');
    expect(row.attempt_count).toBe(8);
    expect(attempts).toBe(8);              // the 8th is the last one tried
    expect(box.nextRetryAt()).toBeNull();
  });

  test('re-sending a dead-lettered key re-admits it and buys one more attempt', async () => {
    // fabric's `onDuplicate: retry-now`: a caller asking again is new intent.
    const { box, sql } = outbox();
    const failing = fakeBinding(() => { throw new Error('permanent'); });
    await box.send(failing.binding, 'revive', message(), 0);

    for (let i = 1; i < 10; i++) await box.reconcile(failing.binding, i * 1_000_000_000);
    expect(rowFor(sql, 'revive')?.state).toBe('dlq');

    const ok = fakeBinding();
    const result = await box.send(ok.binding, 'revive', message(), 20_000_000_000);

    expect(result.status).toBe('sent');
    expect(ok.sent).toHaveLength(1);
    expect(rowFor(sql, 'revive')?.state).toBe('sent');
  });
});
