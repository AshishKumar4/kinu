/**
 * PeerAgent transport — always-async agent-to-agent messaging.
 *
 * Sender side:
 *   `enqueueOutboundPeer(...)` writes a `peer_outbox` row; `PeerHub.dispatchOutbox()`
 *   delivers due rows via DO RPC in per-receiver order (ULID id order), with
 *   exponential-backoff retries and a dead-letter state for permanent refusals.
 *   The DO alarm re-drives pending rows, so delivery survives eviction.
 *
 * Receiver side:
 *   `receivePeerMessage(...)` is invoked by the sender via DO RPC. The receiver
 *   writes a PeerAgent event into its own EventLog and acks; the admitted event
 *   drains into a programmatic turn (AgentOrchestrator.drainPendingEvents).
 *
 * Ordering: per-(sender, receiver) preserved by sender's outbox id order +
 * receiver-side dedupe on `(sender_agent, sender_event_id)`.
 *
 * Cross-owner messaging requires the receiver to have granted the specific
 * sender access — the grant is enforced by the receiver's UserDO
 * (`hasPeerGrant`), never trusted from the sender's claim.
 *
 * Send-and-await (`ask`): the sender enqueues with `reply_expected`, the
 * receiver opens a `peer_back` reply channel keyed on the admitted event, and
 * the receiving agent answers with the agents tool's reply action. The answer
 * rides the same outbox transport back (topic `peer_reply`, body
 * `{ in_reply_to, content }`); the sender's in-memory ask waiter consumes it
 * inline — a late answer past the timeout arrives as a normal peer event that
 * wakes the sender's next turn instead.
 */

import {
  PEER_REPLY_TOPIC, spillEventContent, ulid,
  type EventLog, type PeerAgentPayload,
  type PeerAskOutcome, type PeerReplyOutcome, type PeerSendOutcome,
  type ReplyChannelRow, type ReplyChannelStore, type VFS,
} from '@proteus/core';

interface SqlExec {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

// ── Wire shapes ──────────────────────────────────────────────────

export interface PeerMessage {
  sender_event_id: string;       // sender outbox row id — receiver-side dedupe
  sender_agent_name: string;
  sender_user_id: string;
  topic: string;
  body: unknown;
  /** The sender holds an ask waiter — open a peer-back reply channel. */
  reply_expected?: boolean;
}

export interface ReceiveResult {
  admitted: boolean;
  event_id?: string;
  reason?: string;
}

// ── Sender side ──────────────────────────────────────────────────

export interface SenderDeps {
  /** Sender-side outbox row writer (e.g., direct SQL on the sender's DO). */
  enqueueOutboxRow(row: OutboxRow): void;
  /** Ask the sender DO to wake up to dispatch the new outbox row. */
  scheduleDispatch(at: number): void;
}

export interface OutboxRow {
  id: string;
  receiver_agent_name: string;
  receiver_user_id: string;
  payload: unknown;
  causality_event_id: string | null;
  next_attempt_at: number;
}

export interface SendOptions {
  receiver_agent_name: string;
  receiver_user_id: string;
  topic: string;
  body: unknown;
  reply_expected?: boolean;
  caused_by_event_id?: string;
}

/** Sender API: enqueue a peer message. Returns the outbox row id. */
export function enqueueOutboundPeer(
  deps: SenderDeps,
  opts: SendOptions,
  now: number,
): string {
  const id = ulid();
  deps.enqueueOutboxRow({
    id,
    receiver_agent_name: opts.receiver_agent_name,
    receiver_user_id: opts.receiver_user_id,
    payload: { topic: opts.topic, body: opts.body, reply_expected: opts.reply_expected ?? false },
    causality_event_id: opts.caused_by_event_id ?? null,
    next_attempt_at: now,
  });
  deps.scheduleDispatch(now);
  return id;
}

// ── Receiver side ────────────────────────────────────────────────

export interface ReceiverDeps {
  log: EventLog;
  /** The receiver's own file plane — an oversize body is spilled here so the
   *  event brief can name where the rest of it lives. */
  vfs: VFS;
  /** Whether the sender is the same owner as this receiver (UserDO lookup). */
  isSameOwner(sender_user_id: string): Promise<boolean>;
  /** Whether the receiver has explicitly granted this sender access. */
  hasGrant(sender_agent_name: string, sender_user_id: string): Promise<boolean>;
  /** Open a peer-back reply channel for an admitted ask (reply_expected). */
  openPeerBackChannel?(event_id: string, msg: PeerMessage): void;
}

/** Receiver API: accept a peer message via DO RPC. Returns admitted/dropped. */
export async function receivePeerMessage(
  deps: ReceiverDeps,
  msg: PeerMessage,
  now: number,
): Promise<ReceiveResult> {
  const same_owner = await deps.isSameOwner(msg.sender_user_id);
  const receiver_grant_present = same_owner
    ? true   // same-owner peers don't need an explicit grant beyond ownership
    : await deps.hasGrant(msg.sender_agent_name, msg.sender_user_id);

  if (!same_owner && !receiver_grant_present) {
    return { admitted: false, reason: 'no grant from receiver for cross-owner sender' };
  }

  // Spilled after the grant check so a refused message never writes a file.
  const bodyPath = await spillEventContent(deps.vfs, JSON.stringify(msg.body));

  const payload: PeerAgentPayload = {
    from_agent_name: msg.sender_agent_name,
    from_user_id: msg.sender_user_id,
    topic: msg.topic,
    body: msg.body,
    sender_event_id: msg.sender_event_id,
    reply_expected: msg.reply_expected ?? false,
    ...(bodyPath ? { body_path: bodyPath } : {}),
  };

  try {
    const { id, admitted } = deps.log.publish({
      descriptor: {
        ingress: 'peer_async',
        variant: 'peer_agent',
        payload,
        same_owner,
        receiver_grant_present,
      },
      now,
    });
    if (admitted && msg.reply_expected) deps.openPeerBackChannel?.(id, msg);
    return { admitted, event_id: id };
  } catch (err) {
    return { admitted: false, reason: (err as Error).message };
  }
}

// ── PeerHub — sender/receiver endpoint over one agent's hub ─────

/** Delivery retry policy: exponential backoff from 5s, capped at 1h; a row
 *  dead-letters after 8 attempts. Receiver refusals dead-letter immediately. */
const MAX_DELIVERY_ATTEMPTS = 8;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 3_600_000;

interface PeerBackHolder {
  agent_name: string;
  user_id: string;
  ask_id: string;
}

interface OutboxDbRow {
  id: string;
  receiver_agent_name: string;
  receiver_user_id: string;
  payload: string;
  attempt_count: number;
  next_attempt_at: number;
}

export interface PeerHubDeps {
  /** The agent's own DO SQL (peer_outbox lives next to agent_log). */
  sql: SqlExec;
  log: EventLog;
  replyChannels: ReplyChannelStore;
  /** Thunk: the runtime's file plane is built lazily, so it is dereferenced
   *  per received message, never at hub construction. */
  vfs(): VFS;
  selfAgentName(): string;
  /** The owning user id. Throw when the agent is unclaimed. */
  selfUserId(): string;
  /** DO RPC to the receiver agent's `receivePeerMessage`. */
  deliver(receiver_agent_name: string, msg: PeerMessage): Promise<ReceiveResult>;
  isSameOwner(sender_user_id: string): Promise<boolean>;
  hasGrant(sender_agent_name: string, sender_user_id: string): Promise<boolean>;
  /** Arm the DO alarm so pending outbox rows are re-driven after eviction. */
  scheduleDispatch(at: number): void;
  /** A new external event was admitted — wake the agent loop (drain). */
  onAdmitted(): void;
  now?(): number;
}

/**
 * One agent's peer endpoint: the agents tool's ask/send/reply ride it, the
 * orchestrator's `receivePeerMessage` @callable and alarm handler drive it.
 */
export class PeerHub {
  /** In-memory ask waiters keyed by outbox id — alive only while an ask()
   *  awaits inside the current DO activation. A reply with no waiter (timeout
   *  passed, or DO evicted) stays a pending event and wakes a normal turn. */
  private readonly waiters = new Map<string, (envelope: { content: unknown }) => void>();
  private dispatching = false;

  constructor(private readonly deps: PeerHubDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ── Receiving ──────────────────────────────────────────────────

  /** The `receivePeerMessage` @callable body. */
  async receive(msg: PeerMessage): Promise<ReceiveResult> {
    const now = this.now();
    const result = await receivePeerMessage({
      log: this.deps.log,
      vfs: this.deps.vfs(),
      isSameOwner: (uid) => this.deps.isSameOwner(uid),
      // A reply correlated to an ask THIS agent delivered to THAT sender is
      // implicitly accepted — asking is consenting to the answer. Without
      // this, a cross-owner ask could never complete (the answer would need
      // a reciprocal grant on the asker's side and dead-letter instead).
      hasGrant: async (agent, uid) =>
        (await this.deps.hasGrant(agent, uid)) || this.isReplyToMyAsk(msg),
      openPeerBackChannel: (event_id, m) => {
        const holder: PeerBackHolder = {
          agent_name: m.sender_agent_name,
          user_id: m.sender_user_id,
          ask_id: m.sender_event_id,
        };
        this.deps.replyChannels.open({
          event_id,
          kind: 'peer_back',
          holder_addr: JSON.stringify(holder),
          payload_policy: 'full',
        }, now);
      },
    }, msg, now);

    if (result.admitted && result.event_id) {
      const askId = this.resolveAskWaiter(msg);
      if (askId) {
        // The awaiting ask() consumed the reply inline — bind the event so the
        // post-turn drain never re-fires it as a fresh programmatic turn.
        this.deps.log.markConsumed(result.event_id, `peer-ask-${askId}`, 0);
      } else {
        this.deps.onAdmitted();
      }
    }
    return result;
  }

  /** True iff `msg` is a reply envelope whose `in_reply_to` names an ask this
   *  agent DELIVERED to exactly this sender. The outbox ULID is only known to
   *  that receiver, so the correlation is unforgeable by third parties. */
  private isReplyToMyAsk(msg: PeerMessage): boolean {
    if (msg.topic !== PEER_REPLY_TOPIC) return false;
    const body = (msg.body ?? null) as { in_reply_to?: unknown } | null;
    const askId = typeof body?.in_reply_to === 'string' ? body.in_reply_to : null;
    if (!askId) return false;
    const rows = this.deps.sql.exec(
      `SELECT receiver_agent_name, receiver_user_id, payload
       FROM peer_outbox WHERE id = ? AND state = 'delivered'`, askId,
    ).toArray() as Array<{ receiver_agent_name: string; receiver_user_id: string; payload: string }>;
    const row = rows[0];
    if (!row) return false;
    if (row.receiver_agent_name !== msg.sender_agent_name) return false;
    if (row.receiver_user_id !== msg.sender_user_id) return false;
    try {
      return (JSON.parse(row.payload) as { reply_expected?: boolean }).reply_expected === true;
    } catch {
      return false;
    }
  }

  /** Match a transport reply envelope to a live ask waiter. */
  private resolveAskWaiter(msg: PeerMessage): string | null {
    if (msg.topic !== PEER_REPLY_TOPIC) return null;
    const body = (msg.body ?? null) as { in_reply_to?: unknown; content?: unknown } | null;
    const askId = typeof body?.in_reply_to === 'string' ? body.in_reply_to : null;
    if (!askId) return null;
    const resolve = this.waiters.get(askId);
    if (!resolve) return null;
    resolve({ content: body?.content });
    return askId;
  }

  // ── Sending ────────────────────────────────────────────────────

  /** Fire-and-forget. */
  async send(input: { agent: string; userId: string; topic: string; message: string }): Promise<PeerSendOutcome> {
    const id = this.enqueue(input.agent, input.userId, input.topic, input.message, false);
    await this.dispatchOutbox();
    const row = this.outboxState(id);
    if (row?.state === 'dlq') return { status: 'rejected', reason: row.last_error ?? 'rejected by receiver' };
    return { status: row?.state === 'delivered' ? 'delivered' : 'queued', message_id: id };
  }

  /** Send-and-await over the async transport. */
  async ask(input: { agent: string; userId: string; topic: string; message: string; timeoutMs: number }): Promise<PeerAskOutcome> {
    const askId = this.enqueue(input.agent, input.userId, input.topic, input.message, true);
    const wait = this.registerWaiter(askId, input.timeoutMs);
    await this.dispatchOutbox();
    const row = this.outboxState(askId);
    if (row?.state === 'dlq') {
      wait.cancel();
      return { status: 'rejected', reason: row.last_error ?? 'rejected by receiver' };
    }
    const reply = await wait.promise;
    if (reply) return { status: 'replied', from: input.agent, reply: reply.content };
    return {
      status: 'no_reply',
      note: `${input.agent} did not answer within ${Math.round(input.timeoutMs / 1000)}s. ` +
        `The message was ${row?.state === 'delivered' ? 'delivered' : 'queued for delivery'}; ` +
        'a late answer will arrive as a peer event that wakes you.',
    };
  }

  /** Answer a received peer ask through its peer-back reply channel. */
  async reply(input: { eventId: string; message: string }): Promise<PeerReplyOutcome> {
    const channel = this.deps.replyChannels.findOpenByEvent(input.eventId, 'peer_back');
    if (!channel) {
      return {
        ok: false,
        error: `no open peer reply channel for event ${input.eventId} — already answered, expired, or the sender did not ask for a reply`,
      };
    }
    const outcome = await this.deps.replyChannels.reply(channel.id, input.message, this.now());
    if (outcome.outcome === 'delivered') return { ok: true };
    const detail = outcome.outcome === 'failed' && outcome.detail ? `: ${outcome.detail}` : '';
    return { ok: false, error: `reply not delivered (${outcome.outcome}${detail})` };
  }

  /** ReplyDispatcher body for kind='peer_back': route the answer back to the
   *  asker over the same durable outbox transport. */
  async dispatchPeerBack(channel: ReplyChannelRow, payload: unknown): Promise<{ delivered: boolean; detail?: string }> {
    let holder: Partial<PeerBackHolder>;
    try {
      holder = JSON.parse(channel.holder_addr) as Partial<PeerBackHolder>;
    } catch {
      return { delivered: false, detail: 'malformed peer_back holder_addr' };
    }
    if (!holder.agent_name || !holder.user_id || !holder.ask_id) {
      return { delivered: false, detail: 'incomplete peer_back holder_addr' };
    }
    this.enqueue(holder.agent_name, holder.user_id, PEER_REPLY_TOPIC, {
      in_reply_to: holder.ask_id,
      content: payload,
    }, false);
    await this.dispatchOutbox();
    // Durable handoff: the outbox owns retries from here on.
    return { delivered: true };
  }

  private enqueue(receiverAgent: string, receiverUserId: string, topic: string, body: unknown, replyExpected: boolean): string {
    return enqueueOutboundPeer({
      enqueueOutboxRow: (row) => {
        this.deps.sql.exec(
          `INSERT INTO peer_outbox
             (id, receiver_agent_name, receiver_user_id, payload,
              causality_event_id, next_attempt_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          row.id, row.receiver_agent_name, row.receiver_user_id,
          JSON.stringify(row.payload), row.causality_event_id,
          row.next_attempt_at, this.now(),
        );
      },
      scheduleDispatch: (at) => this.deps.scheduleDispatch(at),
    }, {
      receiver_agent_name: receiverAgent,
      receiver_user_id: receiverUserId,
      topic,
      body,
      reply_expected: replyExpected,
    }, this.now());
  }

  // ── Outbox dispatch ────────────────────────────────────────────

  /** Deliver due pending outbox rows in per-receiver id order. Transient
   *  failures back off and block that receiver's queue (ordering); receiver
   *  refusals dead-letter the row. Reentrancy-guarded — the alarm and inline
   *  tool dispatches can overlap on the same activation. */
  async dispatchOutbox(now = this.now()): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const rows = this.deps.sql.exec(
        `SELECT id, receiver_agent_name, receiver_user_id, payload, attempt_count, next_attempt_at
         FROM peer_outbox WHERE state = 'pending' ORDER BY id`,
      ).toArray() as unknown as OutboxDbRow[];

      const blocked = new Set<string>();
      for (const row of rows) {
        const receiverKey = `${row.receiver_user_id}:${row.receiver_agent_name}`;
        if (blocked.has(receiverKey)) continue;
        if (row.next_attempt_at > now) {
          blocked.add(receiverKey);
          this.deps.scheduleDispatch(row.next_attempt_at);
          continue;
        }

        const payload = JSON.parse(row.payload) as { topic: string; body: unknown; reply_expected?: boolean };
        try {
          const res = await this.deps.deliver(row.receiver_agent_name, {
            sender_event_id: row.id,
            sender_agent_name: this.deps.selfAgentName(),
            sender_user_id: this.deps.selfUserId(),
            topic: payload.topic,
            body: payload.body,
            ...(payload.reply_expected ? { reply_expected: true } : {}),
          });
          if (res.admitted || res.event_id) {
            // Admitted now, or deduped by the receiver (a crash redelivery) —
            // delivered either way.
            this.deps.sql.exec(
              `UPDATE peer_outbox SET state = 'delivered', attempt_count = attempt_count + 1, delivered_at = ? WHERE id = ?`,
              now, row.id,
            );
          } else {
            // Receiver refused (e.g. no cross-owner grant) — permanent.
            this.deps.sql.exec(
              `UPDATE peer_outbox SET state = 'dlq', attempt_count = attempt_count + 1, last_error = ? WHERE id = ?`,
              res.reason ?? 'rejected by receiver', row.id,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const attempts = row.attempt_count + 1;
          if (attempts >= MAX_DELIVERY_ATTEMPTS) {
            this.deps.sql.exec(
              `UPDATE peer_outbox SET state = 'dlq', attempt_count = ?, last_error = ? WHERE id = ?`,
              attempts, `undeliverable after ${attempts} attempts: ${message}`, row.id,
            );
          } else {
            const next = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** row.attempt_count);
            this.deps.sql.exec(
              `UPDATE peer_outbox SET attempt_count = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
              attempts, next, message, row.id,
            );
            this.deps.scheduleDispatch(next);
          }
          blocked.add(receiverKey);   // preserve per-receiver ordering
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  /** Soonest pending retry — folded into the DO alarm reschedule. */
  nextRetryAt(): number | null {
    const rows = this.deps.sql.exec(
      `SELECT MIN(next_attempt_at) AS next FROM peer_outbox WHERE state = 'pending'`,
    ).toArray() as Array<{ next: number | null }>;
    return rows[0]?.next ?? null;
  }

  private outboxState(id: string): { state: string; last_error: string | null } | null {
    const rows = this.deps.sql.exec(
      `SELECT state, last_error FROM peer_outbox WHERE id = ?`, id,
    ).toArray() as Array<{ state: string; last_error: string | null }>;
    return rows[0] ?? null;
  }

  private registerWaiter(askId: string, timeoutMs: number): {
    promise: Promise<{ content: unknown } | null>;
    cancel(): void;
  } {
    let cancel!: () => void;
    const promise = new Promise<{ content: unknown } | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(askId);
        resolve(null);
      }, timeoutMs);
      cancel = () => {
        clearTimeout(timer);
        this.waiters.delete(askId);
        resolve(null);
      };
      this.waiters.set(askId, (envelope) => {
        clearTimeout(timer);
        this.waiters.delete(askId);
        resolve(envelope);
      });
    });
    return { promise, cancel };
  }
}
