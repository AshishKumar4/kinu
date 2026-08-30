// Peer transport behavior — TWO real hubs (EventLog + ReplyChannelStore + the
// shared outbox's `outbox_peer` over in-memory SQLite) wired back-to-back
// through PeerHub, the same seams the orchestrator wires to DO RPC. Covers the
// peers-tool paths:
// fire-and-forget, send-and-await round-trip, trust-grant enforcement,
// timer-less waiter and post-eviction reply delivery, crash redelivery dedupe,
// per-receiver ordering, the spawn-a-specialist round-trip, and the
// reference-plus-digest spill for bodies past the brief budget.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  EventLog, ReplyChannelStore, initEventsHubTables, buildDrainBatch, nextAlarmTime,
  eventContentPath, renderForLLM, PeerHub, JsonValueSchema,
  type PeerAgentPayload, type ReplyDispatcher, type ReplyChannelKind,
  type PeerMessage, type KinuEvent, type ReceiveResult, type SqlExec,
} from '@kinu.run/core';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { sqlExec } from './helpers/user-do';

function makeSql(): SqlExec {
  return sqlExec(new Database(':memory:'));
}

interface TestAgent {
  name: string;
  userId: string;
  sql: SqlExec;
  log: EventLog;
  replyChannels: ReplyChannelStore;
  hub: PeerHub;
  /** The agent's own file plane — oversize peer bodies spill here. */
  files: Map<string, string>;
  /** onAdmitted() fires — the drain→programmatic-turn wake. */
  wakes: number;
  /** scheduleDispatch timestamps — the DO alarm arms. */
  retries: number[];
  /** Cross-owner senders this agent's owner has granted: `${userId}:${agent}`. */
  grants: Set<string>;
  /** Simulates the receiver DO being unreachable (RPC throws). */
  online: boolean;
  /** The hub's clock. Null leaves it on the wall clock; a number pins it so a
   *  backoff curve can be read as an exact instant. */
  clock: number | null;
}

const PeerAgentPayloadSchema: v.GenericSchema<PeerAgentPayload> = v.object({
  from_agent_name: v.string(),
  from_user_id: v.string(),
  topic: v.string(),
  body: JsonValueSchema,
  sender_event_id: v.string(),
  reply_expected: v.optional(v.boolean()),
  body_path: v.optional(v.string()),
  kinu_mode: v.picklist(['plan', 'build']),
});

const RejectionErrorSchema = v.instance(Error);
const PeerOutboxRowSchema = v.object({
  id: v.string(),
  message: v.string(),
  order_key: v.nullable(v.string()),
  state: v.string(),
  attempt_count: v.number(),
  next_attempt_at: v.number(),
  last_error: v.nullable(v.string()),
});
const QueuedPeerMessageSchema = v.object({ receiver_agent_name: v.string() });

function makeNetwork() {
  const network = new Map<string, TestAgent>();

  function addAgent(name: string, userId: string): TestAgent {
    const sql = makeSql();
    initEventsHubTables(sql);
    const log = new EventLog(sql);
    const dispatchers: Partial<Record<ReplyChannelKind, ReplyDispatcher>> = {};
    const replyChannels = new ReplyChannelStore(sql, dispatchers);
    const { vfs, files } = createMemoryVfs();
    let agent: TestAgent | null = null;
    const hub = new PeerHub({
      sql, log, replyChannels,
      vfs: () => vfs,
      selfAgentName: () => name,
      selfUserId: () => userId,
      deliver: async (receiverName: string, msg: PeerMessage): Promise<ReceiveResult> => {
        const peer = network.get(receiverName);
        if (!peer || !peer.online) throw new Error(`receiver DO unreachable: ${receiverName}`);
        return peer.hub.receive(msg);
      },
      isSameOwner: async (uid) => uid === userId,
      hasGrant: async (senderAgent, senderUserId) => {
        if (!agent) throw new Error('agent network fixture not initialized');
        return agent.grants.has(`${senderUserId}:${senderAgent}`);
      },
      scheduleDispatch: async (at) => {
        if (!agent) throw new Error('agent network fixture not initialized');
        agent.retries.push(at);
      },
      onAdmitted: () => {
        if (!agent) throw new Error('agent network fixture not initialized');
        agent.wakes++;
      },
      now: () => {
        if (!agent) throw new Error('agent network fixture not initialized');
        return agent.clock ?? Date.now();
      },
    });
    agent = {
      name, userId, sql, log, replyChannels, files, hub,
      wakes: 0, retries: [], grants: new Set(), online: true, clock: null,
    };
    // The peer_back reply dispatcher routes answers back over the same outbox
    // (exactly how the orchestrator registers it, lazily bound).
    dispatchers.peer_back = { dispatch: (ch, p) => agent.hub.dispatchPeerBack(ch, p) };
    network.set(name, agent);
    return agent;
  }

  return { network, addAgent };
}

function pendingPeerEvents(agent: TestAgent): KinuEvent[] {
  return agent.log.pending({ variant: 'peer_agent' });
}

function peerPayload(event: KinuEvent): PeerAgentPayload {
  if (event.variant !== 'peer_agent') throw new Error(`expected peer event ${event.id}`);
  return v.parse(PeerAgentPayloadSchema, event.payload);
}

function outboxRows(agent: TestAgent) {
  return v.parse(v.array(PeerOutboxRowSchema), agent.sql.exec(
    `SELECT id, message, order_key, state, attempt_count, next_attempt_at, last_error
     FROM outbox_peer ORDER BY id`,
  ).toArray()).map((row) => ({
    ...row,
    receiver_agent_name: v.parse(QueuedPeerMessageSchema, JSON.parse(row.message)).receiver_agent_name,
  }));
}

/** Wait for the next asynchronous transport phase, not for a guessed duration. */
async function until(fact: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (fact()) return;
    await Promise.resolve();
  }
  throw new Error(`${what} did not happen within 100 microtask turns`);
}

describe('fire-and-forget (send)', () => {
  test('delivers into the receiver hub and wakes it exactly once', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);

    const result = await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'status', message: 'shipping today' });
    expect(result).toMatchObject({ status: 'delivered' });

    const events = pendingPeerEvents(bob);
    expect(events).toHaveLength(1);
    const payload = peerPayload(events[0]);
    expect(payload.from_agent_name).toBe('alice');
    expect(payload.body).toBe('shipping today');
    expect(payload.reply_expected).toBe(false);
    expect(bob.wakes).toBe(1);

    // Same-owner peer events land at authenticated trust, normal priority.
    expect(events[0].trust).toBe('authenticated');
    expect(events[0].priority).toBe('normal');

    // The drained turn renders the message without a reply instruction.
    const batch = buildDrainBatch(pendingPeerEvents(bob))!;
    expect(batch.text).toContain('peer agent (alice)');
    expect(batch.text).not.toContain("action:'reply'");

    expect(outboxRows(alice)[0].state).toBe('sent');
  });
});

describe('send-and-await (ask) round-trip', () => {
  test("the peer's reply through peers resolves the sender's awaiting ask", async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);

    const askPromise = alice.hub.ask({ mode: 'build',
      agent: 'bob', userId: bob.userId, topic: 'research',
      message: 'What changed upstream?',
    });
    await until(() => pendingPeerEvents(bob).length === 1, 'the ask delivery');

    // Bob was woken; his drained turn carries the mechanical reply route.
    const events = pendingPeerEvents(bob);
    expect(events).toHaveLength(1);
    expect(peerPayload(events[0]).reply_expected).toBe(true);
    const batch = buildDrainBatch(events)!;
    expect(batch.text).toContain(`agents({action:'reply', event_id:'${events[0].id}'`);

    // Bob answers through the peer-back reply channel.
    const replied = await bob.hub.reply({ eventId: events[0].id, message: 'v2 API landed' });
    expect(replied).toEqual({ ok: true });

    // Alice's ask resolves with the answer.
    expect(await askPromise).toEqual({ status: 'replied', from: 'bob', reply: 'v2 API landed' });

    // The reply envelope was consumed inline by the waiter — it must NOT wake
    // Alice as a fresh turn nor linger as a pending event.
    expect(alice.wakes).toBe(0);
    expect(pendingPeerEvents(alice)).toHaveLength(0);

    // Channel is spent: answering again is a sharp no-op error.
    const again = await bob.hub.reply({ eventId: events[0].id, message: 'dup' });
    expect(again.ok).toBe(false);
  });

  test('replying to an event that never asked for a reply errors honestly', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);
    await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'fyi', message: 'no answer needed' });
    const events = pendingPeerEvents(bob);
    const result = await bob.hub.reply({ eventId: events[0].id, message: 'but here is one' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('no open peer reply channel');
  });
});

describe('trust-grant enforcement (cross-owner)', () => {
  const userA = 'a'.repeat(32);
  const userB = 'b'.repeat(32);

  test('an un-granted cross-owner sender is rejected by the receiver and dead-letters', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', userA);
    const mallory = addAgent('mallory', userB);
    const result = await mallory.hub.ask({ mode: 'build',
      agent: 'alice', userId: userA, topic: 'probe', message: 'let me in',
    });
    expect(result).toEqual({ status: 'rejected', reason: 'no grant from receiver for cross-owner sender' });
    expect(pendingPeerEvents(alice)).toHaveLength(0);
    expect(alice.wakes).toBe(0);
    expect(outboxRows(mallory)[0].state).toBe('dlq');
  });

  test('a cross-owner ask completes on a ONE-directional grant — the answer is implicitly accepted', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', userA);
    const carol = addAgent('carol', userB);
    alice.grants.add(`${userB}:carol`);   // alice accepts carol; carol grants nothing

    const askPromise = carol.hub.ask({ mode: 'build',
      agent: 'alice', userId: userA, topic: 'question', message: 'What is your uptime?',
    });
    await until(() => pendingPeerEvents(alice).length === 1, 'the cross-owner ask delivery');
    const events = pendingPeerEvents(alice);
    expect(events).toHaveLength(1);
    await alice.hub.reply({ eventId: events[0].id, message: '99.99%' });

    // Without the reply-to-my-ask correlation this would dead-letter on
    // carol's side (no grant for alice) and the ask could never complete.
    expect(await askPromise).toEqual({ status: 'replied', from: 'alice', reply: '99.99%' });
    expect(outboxRows(alice).map((r) => r.state)).toEqual(['sent']);
  });

  test('an uncorrelated cross-owner "reply" envelope is still rejected (no forged replies)', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', userA);

    // Alice never delivered an ask to "mallory"; a forged reply envelope with
    // a guessed id must hit the normal default-deny grant path.
    const result = await alice.hub.receive({ mode: 'build',
      sender_event_id: 'forged-1',
      sender_agent_name: 'mallory',
      sender_user_id: userB,
      topic: 'peer_reply',
      body: { in_reply_to: 'no-such-ask', content: 'gotcha' },
    });
    expect(result).toEqual({ admitted: false, reason: 'no grant from receiver for cross-owner sender' });
    expect(pendingPeerEvents(alice)).toHaveLength(0);
  });

  test('a granted cross-owner sender is admitted at external trust / background priority', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', userA);
    const carol = addAgent('carol', userB);
    alice.grants.add(`${userB}:carol`);

    const result = await carol.hub.send({ mode: 'build', agent: 'alice', userId: userA, topic: 'hello', message: 'hi from another owner' });
    expect(result).toMatchObject({ status: 'delivered' });

    const events = pendingPeerEvents(alice);
    expect(events).toHaveLength(1);
    expect(events[0].trust).toBe('external');
    expect(events[0].priority).toBe('background');
    expect(alice.wakes).toBe(1);
  });
});

describe('timer-less ask waiter + cancellation', () => {
  test('the live wait never expires; cancellation leaves the late reply as a waking event', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);
    const abort = new AbortController();

    const pending = alice.hub.ask({ mode: 'build',
      agent: 'bob', userId: bob.userId, topic: 'slow', message: 'take your time',
      signal: abort.signal,
    });
    let settled = false;
    const settledPending = pending.finally(() => {
      settled = true;
    });
    await until(() => pendingPeerEvents(bob).length === 1, 'the pending ask delivery');
    expect(settled).toBe(false);

    abort.abort(new Error('cancelled by user'));
    let cancellation: Error | null = null;
    try {
      await settledPending;
    } catch (cause) {
      const parsed = v.safeParse(RejectionErrorSchema, cause);
      cancellation = parsed.success ? parsed.output : new Error(String(cause));
    }
    expect(cancellation?.message).toBe('cancelled by user');

    const events = pendingPeerEvents(bob);
    const replied = await bob.hub.reply({ eventId: events[0].id, message: 'sorry, here it is' });
    expect(replied).toEqual({ ok: true });
    await until(() => alice.wakes === 1, 'the late reply wake');

    const late = pendingPeerEvents(alice);
    expect(late).toHaveLength(1);
    const payload = peerPayload(late[0]);
    expect(payload.topic).toBe('peer_reply');
    expect(v.parse(v.object({ content: v.string() }), payload.body).content).toBe('sorry, here it is');
  });
});

describe('redelivery dedupe (crash between deliver and mark)', () => {
  test('re-dispatching an already-delivered outbox row is a receiver no-op', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);

    await alice.hub.send({ mode: 'plan', agent: 'bob', userId: bob.userId, topic: 'once', message: 'exactly once' });
    expect(pendingPeerEvents(bob)).toHaveLength(1);

    // Simulate a crash after delivery but before the delivered-mark landed:
    // the row is pending again and the alarm re-drives it.
    const row = outboxRows(alice)[0];
    alice.sql.exec(`UPDATE outbox_peer SET state = 'pending', next_attempt_at = 0 WHERE id = ?`, row.id);
    await alice.hub.dispatchOutbox();

    expect(pendingPeerEvents(bob)).toHaveLength(1);          // deduped
    const redelivered = pendingPeerEvents(bob)[0];
    if (!redelivered) throw new Error('expected redelivered peer event');
    expect(peerPayload(redelivered).kinu_mode).toBe('plan');
    expect(outboxRows(alice)[0].state).toBe('sent');    // settled again
    expect(bob.wakes).toBe(1);                                // no double wake
  });
});

describe('per-receiver ordering + retry backoff', () => {
  test('an unreachable receiver blocks its queue; recovery delivers in order', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);
    bob.online = false;

    const first = await alice.hub.send({ mode: 'plan', agent: 'bob', userId: bob.userId, topic: 'step', message: 'first' });
    const second = await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'step', message: 'second' });
    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');

    // Only the head-of-line row was attempted — the second stayed untouched
    // behind it (ordering) — and a retry alarm was armed.
    const rows = outboxRows(alice);
    expect(rows.map((r) => r.state)).toEqual(['pending', 'pending']);
    expect(rows[0].attempt_count).toBe(1);
    expect(rows[1].attempt_count).toBe(0);
    expect(alice.retries.length).toBeGreaterThan(0);

    // Receiver comes back; the alarm re-drives past the backoff window.
    bob.online = true;
    await alice.hub.dispatchOutbox(Date.now() + 60_000);

    expect(outboxRows(alice).map((r) => r.state)).toEqual(['sent', 'sent']);
    const pending = pendingPeerEvents(bob);
    const bodies = pending.map((event) => peerPayload(event).body);
    expect(bodies).toEqual(['first', 'second']);
    expect(pending.map((event) => peerPayload(event).kinu_mode))
      .toEqual(['plan', 'build']);
    expect(buildDrainBatch(pending)).toMatchObject({ mode: 'plan', ids: [pending[0]?.id] });
    expect(buildDrainBatch(pending.slice(1))).toMatchObject({ mode: 'build', ids: [pending[1]?.id] });
  });

  test('a past-due retry is re-armed immediately by the alarm fold — the blocked delivery eventually fires', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);
    bob.online = false;

    const sent = await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'ping', message: 'anyone there?' });
    expect(sent.status).toBe('queued');
    const retryAt = alice.hub.nextRetryAt();
    expect(retryAt).not.toBeNull();

    // The DO idled past the retry time with no dispatch (e.g. the armed alarm
    // fired while an inline dispatch held the reentrancy guard). The retry is
    // now PAST-DUE: a future-only reschedule filter would drop it and the
    // delivery would stall forever on an idle agent. The fold clamps it to
    // "fire immediately" instead.
    if (retryAt === null) throw new Error('expected scheduled peer retry');
    const later = retryAt + 3_600_000;
    expect(nextAlarmTime(later, [], alice.hub.nextRetryAt())).toBe(later);

    // The immediate alarm re-drives the outbox and the delivery lands.
    bob.online = true;
    await alice.hub.dispatchOutbox(later);
    expect(outboxRows(alice).map((r) => r.state)).toEqual(['sent']);
    expect(pendingPeerEvents(bob)).toHaveLength(1);
  });

  test('each failed delivery doubles the wait from the 5s base', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);
    bob.online = false;
    alice.clock = 0;

    await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'ping', message: 'hello' });
    expect(outboxRows(alice)[0].next_attempt_at).toBe(5_000);        // 5_000 · 2⁰

    await alice.hub.dispatchOutbox(5_000);
    expect(outboxRows(alice)[0].next_attempt_at).toBe(15_000);       // + 5_000 · 2¹

    await alice.hub.dispatchOutbox(15_000);
    expect(outboxRows(alice)[0].next_attempt_at).toBe(35_000);       // + 5_000 · 2²
  });

  test('an unreachable receiver dead-letters ON the 8th attempt', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);
    bob.online = false;
    alice.clock = 0;

    await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'ping', message: 'anyone?' });
    for (let sweep = 1; sweep < 10; sweep++) {
      await alice.hub.dispatchOutbox(sweep * 1_000_000);
    }

    const row = outboxRows(alice)[0];
    expect(row.state).toBe('dlq');
    expect(row.attempt_count).toBe(8);
    expect(row.last_error).toContain('undeliverable after 8 attempts');
    expect(alice.hub.nextRetryAt()).toBeNull();
  });
});

describe('spawn a specialist (fresh peer joins mid-flight)', () => {
  test('create → ask → reply round-trip against a just-created teammate', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));

    // The orchestrator's spawn action: create the agent (registry +
    // claimOwner — here: joins the network under the same owner), then ask.
    const specialist = addAgent('paper-summarizer', alice.userId);
    const askPromise = alice.hub.ask({ mode: 'build',
      agent: specialist.name, userId: alice.userId, topic: 'task',
      message: 'Summarize the three latest papers',
    });
    await until(() => pendingPeerEvents(specialist).length === 1, 'the specialist ask delivery');

    const events = pendingPeerEvents(specialist);
    expect(events).toHaveLength(1);
    expect(specialist.wakes).toBe(1);
    await specialist.hub.reply({ eventId: events[0].id, message: 'Summaries: …' });

    expect(await askPromise).toEqual({
      status: 'replied', from: 'paper-summarizer', reply: 'Summaries: …',
    });
  });
});

describe('oversize peer bodies stay reachable', () => {
  const userA = 'a'.repeat(32);
  const userB = 'b'.repeat(32);

  test('a body past the brief budget spills to the receiver file plane and the brief cites it', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);

    const message = 'upstream diff hunk; '.repeat(400);
    await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'handoff', message });

    const events = pendingPeerEvents(bob);
    const payload = peerPayload(events[0]);
    const path = payload.body_path;
    expect(path).toBe(eventContentPath(JSON.stringify(message)));

    // The reference resolves, losslessly, on the receiver's own file plane.
    if (!path) throw new Error('expected spilled peer body path');
    expect(bob.files.get(path)).toBe(JSON.stringify(message));
    // …and the drained turn is told where to look.
    expect(renderForLLM(events[0]).brief).toEndWith(` — full message: ${path}`);
    const batch = buildDrainBatch(events);
    if (!batch) throw new Error('expected peer drain batch');
    expect(batch.text).toContain(path);
  });

  test('a body within the brief budget writes nothing and renders exactly as before', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', 'u1'.padEnd(32, '0'));
    const bob = addAgent('bob', alice.userId);

    await alice.hub.send({ mode: 'build', agent: 'bob', userId: bob.userId, topic: 'status', message: 'shipping today' });

    const events = pendingPeerEvents(bob);
    expect(peerPayload(events[0]).body_path).toBeUndefined();
    expect(bob.files.size).toBe(0);
    expect(renderForLLM(events[0]).brief).toBe('status: "shipping today"');
  });

  test('a refused cross-owner message spills nothing — no unadmitted writes', async () => {
    const { addAgent } = makeNetwork();
    const alice = addAgent('alice', userA);
    const mallory = addAgent('mallory', userB);

    await mallory.hub.send({ mode: 'build',
      agent: 'alice', userId: userA, topic: 'probe', message: 'let me in; '.repeat(200),
    });

    expect(pendingPeerEvents(alice)).toHaveLength(0);
    expect(alice.files.size).toBe(0);
  });
});
