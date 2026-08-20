// Mission Inbox — outbound side. The email_thread dispatcher (correct
// In-Reply-To / References threading), the per-turn reply dispatch over a
// real EventLog + ReplyChannelStore (the full inbound → turn → threaded
// reply flow at the seams), and owner notifications. The only mock is the
// send_email binding.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  initEventsHubTables, EventLog, ReplyChannelStore,
  AgentOrchestrator, EvolutionEngine, acceptInboundEmail,
  type BackendHost,
  type SqlExec,
} from '@kinu/core';
import { createMemoryVfs, createTestRuntime } from '@kinu/test-utils';
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn, sendOwnerEmail,
  threadingHeaders,
} from '../src/email/outbound';
import { EmailOutbox } from '../src/email/outbox';
import { sqlExec } from './helpers/user-do';

function makeSql(): SqlExec {
  return sqlExec(new Database(':memory:'));
}

function freshOutbox(): EmailOutbox {
  const outbox = new EmailOutbox(makeSql());
  outbox.ensureSchema();
  return outbox;
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
const ReplyAttemptSchema = v.object({
  kind: v.string(),
  outcome: v.object({ outcome: v.string() }),
});

/** A capture fake for the send_email Workers binding. */
function fakeSendBinding(opts: { fail?: boolean } = {}) {
  const sent: SentEmail[] = [];
  function send(message: EmailMessage): Promise<EmailSendResult>;
  function send(message: SendEmailBuilder): Promise<EmailSendResult>;
  async function send(message: EmailMessage | SendEmailBuilder): Promise<EmailSendResult> {
    if (opts.fail) throw new Error('E_SENDER_NOT_VERIFIED');
    sent.push(v.parse(SentEmailSchema, message));
    return { messageId: `out-${sent.length}` };
  }
  const binding: SendEmail = { send };
  return { binding, sent };
}

describe('threadingHeaders', () => {
  test('reply points In-Reply-To at the inbound id and extends References', () => {
    expect(threadingHeaders({ message_id: '<a@x>', references: null })).toEqual({
      'In-Reply-To': '<a@x>', References: '<a@x>',
    });
    expect(threadingHeaders({ message_id: '<c@x>', references: '<a@x> <b@x>' })).toEqual({
      'In-Reply-To': '<c@x>', References: '<a@x> <b@x> <c@x>',
    });
    expect(threadingHeaders({ message_id: null, references: '<a@x>' })).toEqual({});
  });
});

describe('inbound email → turn → threaded reply (the full flow at the seams)', () => {
  function setup(sendOpts: { fail?: boolean } = {}) {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const { binding, sent } = fakeSendBinding(sendOpts);
    const outbox = new EmailOutbox(sql);
    outbox.ensureSchema();
    const replies = new ReplyChannelStore(sql, {
      email_thread: createEmailThreadDispatcher(() => ({
        email: binding, agentDisplayName: 'Scout', outbox,
      })),
    });
    return { sql, log, replies, sent };
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

  test("the turn's answer threads back to the sender as a real reply", async () => {
    const { log, replies, sent, sql } = setup();
    const eventId = await admitOwnerEmail(log, replies);

    // The drain binds the event to a synthetic turn (as AgentOrchestrator does).
    log.markConsumed(eventId, 'evt-turn-1', 0);

    const result = await dispatchEmailRepliesForTurn(
      { log, replies }, 'evt-turn-1', 'Yes — staging is green. All 1,470 tests pass.', 2_000,
    );
    expect(result).toEqual({ delivered: 1, pending: false });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: 'scout-a1b2c3@agents.example.com', name: 'Scout' },
      to: 'owner@example.com',
      subject: 'Re: Check the deploy',
      text: 'Yes — staging is green. All 1,470 tests pass.',
      headers: {
        'Auto-Submitted': 'auto-replied',
        'In-Reply-To': '<abc@mail.example.com>',
        References: '<root@mail.example.com> <abc@mail.example.com>',
      },
    });
    // The idempotency key rides the wire as a stable Message-ID (SPEC §7.4).
    expect(sent[0].headers?.['Message-ID']).toMatch(/^<kinu\.[0-9a-f]{64}@agents\.example\.com>$/);

    // The channel is settled and an audit row exists.
    expect(replies.findOpenByEvent(eventId)).toBeNull();
    const attempts = sql.exec(
      `SELECT payload FROM agent_log WHERE kind = 'reply_attempt'`,
    ).toArray();
    expect(attempts).toHaveLength(1);
    expect(v.parse(ReplyAttemptSchema, JSON.parse(String(attempts[0].payload)))).toMatchObject({
      kind: 'email_thread', outcome: { outcome: 'delivered' },
    });

    // Re-dispatch is a no-op (channel already replied).
    expect(await dispatchEmailRepliesForTurn({ log, replies }, 'evt-turn-1', 'again', 3_000))
      .toEqual({ delivered: 0, pending: false });
    expect(sent).toHaveLength(1);
  });

  test('an email injected MID-TURN still threads its reply — bound to the batch id the live turn absorbed', async () => {
    const { log, replies, sent } = setup();
    const eventId = await admitOwnerEmail(log, replies);

    // A turn is live: the seam splices the drain into the turn's next step
    // instead of queueing it (the same decision every backend delegates), as
    // the orchestrator wires it.
    const host: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async () => { throw new Error('must inject, not enqueue — a turn is live'); },
      turnInFlight: () => true,
      setTimer: () => {},
    };
    const { rt } = createTestRuntime();
    const orch = new AgentOrchestrator({
      host, eventLog: log, engine: new EvolutionEngine(rt, { enabled: false }),
    });
    await orch.drainPendingEvents();

    const step = orch.signals.prepareStep({ stepNumber: 1, messages: [{ role: 'user', content: 'q' }] });
    if (!step?.[1]) throw new Error('expected injected signal step');
    expect(String(step[1].content)).toContain('Is staging green?');

    // Turn end: the absorbed signal's reply turn id keys the SAME dispatch the
    // queued drain-turn path uses — the live turn's answer threads back.
    const { absorbed } = orch.signals.settle({ completed: true });
    expect(absorbed).toHaveLength(1);
    const absorbedSignal = absorbed[0];
    if (!absorbedSignal?.replyTurnId) throw new Error('expected absorbed reply turn');
    expect(await dispatchEmailRepliesForTurn({ log, replies }, absorbedSignal.replyTurnId, 'Green.', 2_000))
      .toEqual({ delivered: 1, pending: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers?.['In-Reply-To']).toBe('<abc@mail.example.com>');
    expect(replies.findOpenByEvent(eventId)).toBeNull();
  });

  test('an existing Re: subject is not double-prefixed', async () => {
    const { log, replies, sent } = setup();
    const result = await acceptInboundEmail({
      log, replies, owner_email: 'owner@example.com', allowlist: [], tryConsumeRateLimit: () => true,
      vfs: createMemoryVfs().vfs,
    }, {
      from: 'owner@example.com', to: 'scout-a1b2c3@agents.example.com',
      subject: 'Re: Check the deploy', body_text: 'and now?',
      message_id: '<def@mail.example.com>', in_reply_to: '<out-1@x>', references: null,
      attachments: [], now: 1_000,
    });
    if (!result.admitted) throw new Error('not admitted');
    log.markConsumed(result.event_id, 'evt-turn-2', 0);
    await dispatchEmailRepliesForTurn({ log, replies }, 'evt-turn-2', 'still green', 2_000);
    expect(sent[0].subject).toBe('Re: Check the deploy');
  });

  test('a send failure keeps the channel open for retry and audits the failure', async () => {
    const { log, replies, sent, sql } = setup({ fail: true });
    const eventId = await admitOwnerEmail(log, replies);
    log.markConsumed(eventId, 'evt-turn-3', 0);

    const result = await dispatchEmailRepliesForTurn({ log, replies }, 'evt-turn-3', 'answer', 2_000);
    expect(result).toEqual({ delivered: 0, pending: true });
    expect(sent).toHaveLength(0);
    expect(replies.findOpenByEvent(eventId)?.attempt_count).toBe(1);
    const attempts = sql.exec(`SELECT payload FROM agent_log WHERE kind = 'reply_attempt'`).toArray();
    expect(v.parse(ReplyAttemptSchema, JSON.parse(String(attempts[0].payload))).outcome.outcome).toBe('failed');
  });

  test('a turn with no drain-bound email events sends nothing', async () => {
    const { log, replies, sent } = setup();
    admitOwnerEmail(log, replies);          // pending, never bound to this turn
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
  test('sends from the agent address to the owner with a tagged subject + stable Message-ID', async () => {
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
    expect(sent[0].headers?.['Auto-Submitted']).toBe('auto-generated');
    // The idempotency key materializes as a deterministic Message-ID on the wire.
    expect(sent[0].headers?.['Message-ID']).toMatch(/^<kinu\.[0-9a-f]{64}@agents\.example\.com>$/);
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
