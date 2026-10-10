// Mission Inbox outbound: email_thread dispatch, per-turn reply over a real EventLog +
// ReplyChannelStore, owner notifications. Only the send_email binding is faked.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  initEventsHubTables, EventLog, ReplyChannelStore,
  AgentOrchestrator, EvolutionEngine, acceptInboundEmail, historyTurnPairs,
  type BackendHost,
  type SqlExec,
} from '@kinu.run/core';
import { createMemoryVfs, createTestActorsOver, createTestRuntime } from '@kinu.run/test-utils';
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn,
  sendInboundEmailReceipt, sendOwnerEmail,
} from '../src/email/outbound';
import { EmailOutbox } from '@kinu.run/core';
import { sqlExec } from './helpers/user-do';
import { refuseUnlistedHeaders } from './helpers/email-service';

function makeExec(db: Database): SqlExec {
  return sqlExec(db);
}

function freshOutbox(): EmailOutbox {
  return new EmailOutbox(makeExec(new Database(':memory:')));
}

const SentEmailSchema = v.object({
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

type SentEmail = v.InferOutput<typeof SentEmailSchema>;

type SendEmailBuilder = Parameters<SendEmail['send']>[0];

function fakeSendBinding(opts: { fail?: boolean } = {}) {
  const sent: SentEmail[] = [];
  function send(message: EmailMessage): Promise<EmailSendResult>;
  function send(message: SendEmailBuilder): Promise<EmailSendResult>;
  async function send(message: EmailMessage | SendEmailBuilder): Promise<EmailSendResult> {
    if (opts.fail) throw new Error('E_SENDER_NOT_VERIFIED');
    const parsed = v.parse(SentEmailSchema, message);

    refuseUnlistedHeaders(parsed.headers);
    sent.push(parsed);

    return { messageId: `out-${sent.length}` };
  }

  const binding: SendEmail = { send };

  return { binding, sent };
}

// The full round trip, MIME to threaded reply with retries, is `email-round-trip.test.ts`; these are its edges.
describe('the reply channel at its edges', () => {
  function setup(sendOpts: { fail?: boolean } = {}) {
    const db = new Database(':memory:');
    const exec = makeExec(db);
    initEventsHubTables(exec);
    const actor = createTestActorsOver(db).main;
    const log = new EventLog(exec, actor);
    const { binding, sent } = fakeSendBinding(sendOpts);
    const outbox = new EmailOutbox(exec);

    const replies = new ReplyChannelStore(exec, actor, {
      email_thread: createEmailThreadDispatcher(() => ({
        email: binding, agentDisplayName: 'Scout', outbox,
      })),
    });

    return { sql: exec, log, replies, sent };
  }

  async function admitOwnerEmail(log: EventLog, replies: ReplyChannelStore) {
    const result = await acceptInboundEmail({
      log, replies,
      owner_email: 'owner@example.com',
      allowlist: [],
      tryConsumeRateLimit: () => true,
      vfs: createMemoryVfs().vfs,
    }, {
      from: 'owner@example.com',
      to: 'scout-a1b2c3@agents.example.com',
      subject: 'Check the deploy',
      body_text: 'Is staging green?',
      message_id: '<abc@mail.example.com>',
      in_reply_to: null,
      references: '<root@mail.example.com>',
      attachments: [],
      now: 1_000,
    });

    if (!result.admitted) throw new Error('setup: email not admitted');

    return result.event_id;
  }

  test('an email injected MID-TURN still threads its reply — bound to the batch id the live turn absorbed', async () => {
    const { log, replies, sent } = setup();
    const eventId = await admitOwnerEmail(log, replies);

    // A live turn absorbs the drain into its next step instead of queueing it.
    const host: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async () => { throw new Error('must inject, not enqueue — a turn is live'); },
      turnInFlight: () => true,
      setTimer: () => {},
    };

    const { rt, stores } = createTestRuntime();

    const orch = new AgentOrchestrator({
      host, eventLog: log, engine: new EvolutionEngine(rt, historyTurnPairs(stores.history), { enabled: false }),
    });

    await orch.drainPendingEvents();

    const step = await orch.inbox.prepareStep({ stepNumber: 1, messages: [{ role: 'user', content: 'q' }] });

    if (!step?.[1]) throw new Error('expected injected signal step');
    expect(v.parse(v.string(), step[1].content)).toContain('Is staging green?');

    // The absorbed signal's reply turn id keys the same dispatch as the queued path.
    const { absorbed } = orch.inbox.settle({ completed: true });
    expect(absorbed).toHaveLength(1);
    const absorbedSignal = absorbed[0];

    if (!absorbedSignal?.replyTurnId) throw new Error('expected absorbed reply turn');
    expect(await dispatchEmailRepliesForTurn({ log, replies }, absorbedSignal.replyTurnId, 'Green.', 2_000))
      .toEqual({ delivered: 1, pending: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers?.['In-Reply-To']).toBe('<abc@mail.example.com>');
    expect(replies.findOpenByEvent(eventId)).toBeNull();
  });

  test('a turn with no drain-bound email events sends nothing', async () => {
    const { log, replies, sent } = setup();
    await admitOwnerEmail(log, replies);          // pending, never bound to this turn
    expect(await dispatchEmailRepliesForTurn({ log, replies }, 'evt-other', 'answer', 2_000))
      .toEqual({ delivered: 0, pending: false });
    expect(sent).toHaveLength(0);
  });

  test('empty answers are not emailed', async () => {
    const { log, replies, sent } = setup();
    const eventId = await admitOwnerEmail(log, replies);
    log.markConsumed(eventId, 'evt-turn-4', 0);
    expect(await dispatchEmailRepliesForTurn({ log, replies }, 'evt-turn-4', '   ', 2_000))
      .toEqual({ delivered: 0, pending: true });
    expect(sent).toHaveLength(0);
    expect(replies.findOpenByEvent(eventId)).not.toBeNull();  // still open
  });
});

describe('sendOwnerEmail — changelog digests + job completions', () => {
  test('sends from the agent address to the owner with a tagged subject', async () => {
    const { binding, sent } = fakeSendBinding();

    const ok = await sendOwnerEmail({
      email: binding, emailDomain: 'agents.example.com',
      agentName: 'scout-a1b2c3', agentDisplayName: 'Scout',
      ownerEmail: 'owner@example.com', outbox: freshOutbox(),
    }, { subject: 'Evolution changelog digest', text: 'Self-change digest: 3 entries…', key: 'digest-1' });

    expect(ok).toBe(true);
    expect(sent[0]).toMatchObject({
      from: { email: 'scout-a1b2c3@agents.example.com', name: 'Scout' },
      to: 'owner@example.com',
      subject: '[Scout] Evolution changelog digest',
      text: 'Self-change digest: 3 entries…',
    });
    expect(sent[0].headers).toEqual({ 'Auto-Submitted': 'auto-generated' });
  });

  test('skips quietly when the platform email pieces are missing', async () => {
    const { binding, sent } = fakeSendBinding();

    const base = {
      email: binding, emailDomain: 'agents.example.com',
      agentName: 'a', agentDisplayName: 'A', ownerEmail: 'o@e.com', outbox: freshOutbox(),
    };

    const note = { subject: 's', text: 't', key: 'k' };
    expect(await sendOwnerEmail({ ...base, email: undefined }, note)).toBe(false);
    expect(await sendOwnerEmail({ ...base, emailDomain: undefined }, note)).toBe(false);
    expect(await sendOwnerEmail({ ...base, ownerEmail: null }, note)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('a send failure is contained (returns false, never throws)', async () => {
    const { binding } = fakeSendBinding({ fail: true });
    expect(await sendOwnerEmail({
      email: binding, emailDomain: 'agents.example.com',
      agentName: 'a', agentDisplayName: 'A', ownerEmail: 'o@e.com', outbox: freshOutbox(),
    }, { subject: 's', text: 't', key: 'k' })).toBe(false);
  });
});

// KINU-054: the sender got nothing until a turn answered, and threading headers grew unbounded.
describe('the receipt an accepted message gets immediately', () => {
  const THREAD = {
    to: 'owner@example.com',
    from: 'scout-a1b2c3@agents.example.com',
    subject: 'Check the deploy',
    message_id: '<abc@mail.example.com>',
    references: '<root@mail.example.com>',
  };

  test('no send_email binding is a quiet skip, not a failed delivery', async () => {
    const { sent } = fakeSendBinding();
    expect(await sendInboundEmailReceipt(
      { email: undefined, agentDisplayName: 'Scout', outbox: freshOutbox() }, THREAD, 'evt-1',
    )).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('a thread with no usable Message-ID carries no threading headers', async () => {
    const { binding, sent } = fakeSendBinding();

    const ok = await sendInboundEmailReceipt(
      { email: binding, agentDisplayName: 'Scout', outbox: freshOutbox() },
      { ...THREAD, message_id: null },
      'evt-noid',
    );

    expect(ok).toBe(true);
    expect(sent[0].headers?.['In-Reply-To']).toBeUndefined();
    expect(sent[0].headers?.['References']).toBeUndefined();
  });

});

describe('threading headers stay inside the line a receiver must accept', () => {
  const REFERENCES_BUDGET = 998 - 'References'.length - 2;

  async function receiptHeaders(
    thread: { message_id: string | null; references: string | null },
    eventId: string,
  ): Promise<Record<string, string>> {
    const { binding, sent } = fakeSendBinding();
    await sendInboundEmailReceipt(
      { email: binding, agentDisplayName: 'Scout', outbox: freshOutbox() },
      {
        to: 'owner@example.com',
        from: 'scout-a1b2c3@agents.example.com',
        subject: 'Check the deploy',
        ...thread,
      },
      eventId,
    );

    return sent[0].headers ?? {};
  }

  test('a long inherited chain is trimmed from the middle, never from either end', async () => {
    const chain = Array.from({ length: 200 }, (_, i) => `<r${String(i).padStart(3, '0')}@x>`);

    const headers = await receiptHeaders(
      { message_id: '<answered@x>', references: chain.join(' ') }, 'evt-long',
    );

    expect(headers['In-Reply-To']).toBe('<answered@x>');

    const references = headers['References'] ?? '';
    const kept = references.split(' ');
    expect(references.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    expect(kept[0]).toBe('<r000@x>');
    expect(kept[kept.length - 1]).toBe('<answered@x>');
    expect(kept).not.toContain('<r001@x>');
  });

  test('a Message-ID no line can carry threads on nothing rather than on a truncation', async () => {
    const headers = await receiptHeaders(
      { message_id: `<${'x'.repeat(1_200)}@x>`, references: '<a@x>' }, 'evt-wide',
    );

    expect(headers['In-Reply-To']).toBeUndefined();
    expect(headers['References']).toBeUndefined();
  });
});
