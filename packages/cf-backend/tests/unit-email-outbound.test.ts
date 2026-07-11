// Mission Inbox — outbound side. The email_thread dispatcher (correct
// In-Reply-To / References threading), the per-turn reply dispatch over a
// real EventLog + ReplyChannelStore (the full inbound → turn → threaded
// reply flow at the seams), and owner notifications. The only mock is the
// send_email binding.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initEventsHubTables, EventLog, ReplyChannelStore } from '@proteus/core';
import { acceptInboundEmail } from '../src/events/ingress/email.js';
import {
  createEmailThreadDispatcher, dispatchEmailRepliesForTurn, sendOwnerEmail,
  threadingHeaders,
} from '../src/email/outbound.js';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

function makeSql(): SqlExec {
  const db = new Database(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings as never[]) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
}

type SentEmail = {
  from: string | { email: string; name: string };
  to: unknown;
  subject: string;
  text?: string;
  headers?: Record<string, string>;
};

/** A capture fake for the send_email Workers binding. */
function fakeSendBinding(opts: { fail?: boolean } = {}) {
  const sent: SentEmail[] = [];
  const binding = {
    async send(message: SentEmail) {
      if (opts.fail) throw new Error('E_SENDER_NOT_VERIFIED');
      sent.push(message);
      return { messageId: `out-${sent.length}` };
    },
  } as unknown as SendEmail;
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
    const replies = new ReplyChannelStore(sql, {
      email_thread: createEmailThreadDispatcher(() => ({
        email: binding, agentDisplayName: 'Scout',
      })),
    });
    return { sql, log, replies, sent };
  }

  function admitOwnerEmail(log: EventLog, replies: ReplyChannelStore) {
    const result = acceptInboundEmail({
      log, replies,
      owner_email: 'owner@example.com',
      allowlist: [],
      tryConsumeRateLimit: () => true,
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
    const eventId = admitOwnerEmail(log, replies);

    // The drain binds the event to a synthetic turn (as AgentOrchestrator does).
    log.markConsumed(eventId, 'evt-turn-1', 0);

    const delivered = await dispatchEmailRepliesForTurn(
      { log, replies }, 'evt-turn-1', 'Yes — staging is green. All 1,470 tests pass.', 2_000,
    );
    expect(delivered).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
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

    // The channel is settled and an audit row exists.
    expect(replies.findOpenByEvent(eventId)).toBeNull();
    const attempts = sql.exec(
      `SELECT payload FROM agent_log WHERE kind = 'reply_attempt'`,
    ).toArray();
    expect(attempts).toHaveLength(1);
    expect(JSON.parse(attempts[0].payload as string)).toMatchObject({
      kind: 'email_thread', outcome: { outcome: 'delivered' },
    });

    // Re-dispatch is a no-op (channel already replied).
    expect(await dispatchEmailRepliesForTurn({ log, replies }, 'evt-turn-1', 'again', 3_000)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test('an existing Re: subject is not double-prefixed', async () => {
    const { log, replies, sent } = setup();
    const result = acceptInboundEmail({
      log, replies, owner_email: 'owner@example.com', allowlist: [], tryConsumeRateLimit: () => true,
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
    const eventId = admitOwnerEmail(log, replies);
    log.markConsumed(eventId, 'evt-turn-3', 0);

    const delivered = await dispatchEmailRepliesForTurn({ log, replies }, 'evt-turn-3', 'answer', 2_000);
    expect(delivered).toBe(0);
    expect(sent).toHaveLength(0);
    expect(replies.findOpenByEvent(eventId)?.attempt_count).toBe(1);
    const attempts = sql.exec(`SELECT payload FROM agent_log WHERE kind = 'reply_attempt'`).toArray();
    expect(JSON.parse(attempts[0].payload as string).outcome.outcome).toBe('failed');
  });

  test('a turn with no drain-bound email events sends nothing', async () => {
    const { log, replies, sent } = setup();
    admitOwnerEmail(log, replies);          // pending, never bound to this turn
    expect(await dispatchEmailRepliesForTurn({ log, replies }, 'evt-other', 'answer', 2_000)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test('empty answers are not emailed', async () => {
    const { log, replies, sent } = setup();
    const eventId = admitOwnerEmail(log, replies);
    log.markConsumed(eventId, 'evt-turn-4', 0);
    expect(await dispatchEmailRepliesForTurn({ log, replies }, 'evt-turn-4', '   ', 2_000)).toBe(0);
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
      ownerEmail: 'owner@example.com',
    }, { subject: 'Evolution changelog digest', text: 'Self-change digest: 3 entries…' });
    expect(ok).toBe(true);
    expect(sent[0]).toEqual({
      from: { email: 'scout-a1b2c3@agents.example.com', name: 'Scout' },
      to: 'owner@example.com',
      subject: '[Scout] Evolution changelog digest',
      text: 'Self-change digest: 3 entries…',
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
  });

  test('skips quietly when the platform email pieces are missing', async () => {
    const { binding, sent } = fakeSendBinding();
    const base = {
      email: binding, emailDomain: 'agents.example.com',
      agentName: 'a', agentDisplayName: 'A', ownerEmail: 'o@e.com',
    };
    expect(await sendOwnerEmail({ ...base, email: undefined }, { subject: 's', text: 't' })).toBe(false);
    expect(await sendOwnerEmail({ ...base, emailDomain: undefined }, { subject: 's', text: 't' })).toBe(false);
    expect(await sendOwnerEmail({ ...base, ownerEmail: null }, { subject: 's', text: 't' })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('a send failure is contained (returns false, never throws)', async () => {
    const { binding } = fakeSendBinding({ fail: true });
    expect(await sendOwnerEmail({
      email: binding, emailDomain: 'agents.example.com',
      agentName: 'a', agentDisplayName: 'A', ownerEmail: 'o@e.com',
    }, { subject: 's', text: 't' })).toBe(false);
  });
});
