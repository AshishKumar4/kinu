/**
 * PeerAgent transport — always-async agent-to-agent messaging.
 *
 * The one thing a host supplies is `deliver` — the hop that reaches another
 * agent (cross-DO RPC on the cloud backend). Everything around that hop —
 * ordering, backoff, dead-lettering, the write-ahead row — belongs to the
 * shared outbox (`events/outbox.ts`), which this transport configures with a
 * policy. The ask waiter is this file's own.
 *
 * Sender side:
 *   `PeerHub.send`/`ask`/`reply` queue an `outbox_peer` row; `dispatchOutbox()`
 *   drains due rows through that hop in per-receiver order, with
 *   exponential-backoff retries and a dead-letter state for permanent
 *   refusals. The host's alarm re-drives pending rows, so delivery survives
 *   eviction.
 *
 * Receiver side:
 *   `receivePeerMessage(...)` is invoked by the sender's hop. The receiver
 *   writes a PeerAgent event into its own EventLog and acks; the admitted event
 *   drains into a programmatic turn (AgentOrchestrator.drainPendingEvents).
 *
 * Ordering: per-(sender, receiver) preserved by sender's outbox id order +
 * receiver-side dedupe on `(sender_agent, sender_event_id)`.
 *
 * Cross-owner messaging requires the receiver to have granted the specific
 * sender access — the grant is enforced receiver-side (`hasGrant`, the owner's
 * UserDO on the cloud backend), never trusted from the sender's claim.
 *
 * Send-and-await (`ask`): the sender enqueues with `reply_expected`, the
 * receiver opens a `peer_back` reply channel keyed on the admitted event, and
 * the receiving agent answers with the agents tool's reply action. The answer
 * rides the same outbox transport back (topic `peer_reply`, body
 * `{ in_reply_to, content }`); the sender's in-memory ask waiter consumes it
 * inline — a late answer past the timeout arrives as a normal peer event that
 * wakes the sender's next turn instead.
 */

import * as v from 'valibot';
import type { EventLog } from '../hub/log';
import type { ReplyChannelStore } from '../hub/reply-channel';
import type { PeerAgentPayload, ReplyChannelRow } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import { scheduledOutbox, type Outbox, type OutboxDisposition } from '../outbox';
import {
  PEER_REPLY_TOPIC,
  type PeerAskOutcome, type PeerReplyOutcome, type PeerSendOutcome,
} from '../../tools/agents-tool';
import type { SqlExec, VFS } from '../../types/primitives';
import type { WorkMode } from '../../prompting/surface';
import {
  JsonValueSchema, parseJsonObject,
  type JsonValue,
} from '../../utils/json';
import { renderThrownChain } from '../../obs/index';

// ── Wire shapes ──────────────────────────────────────────────────

export interface PeerMessage {
  sender_event_id: string;       // sender outbox row id — receiver-side dedupe
  sender_agent_name: string;
  sender_user_id: string;
  topic: string;
  body: JsonValue;
  mode: WorkMode;
  /** The sender holds an ask waiter — open a peer-back reply channel. */
  reply_expected?: boolean;
}

export interface ReceiveResult {
  admitted: boolean;
  event_id?: string;
  reason?: string;
}

// ── Sender side ──────────────────────────────────────────────────

/** One queued outbound peer message, exactly as the shared outbox stores it. */
export interface PeerOutboxMessage {
  receiver_agent_name: string;
  receiver_user_id: string;
  topic: string;
  body: JsonValue;
  mode: WorkMode;
  reply_expected: boolean;
}

const WorkModeSchema = v.picklist(['plan', 'build']);
const PeerBackHolderSchema = v.object({
  agent_name: v.string(),
  user_id: v.string(),
  ask_id: v.string(),
  mode: WorkModeSchema,
});
const ReplyBodySchema = v.object({
  in_reply_to: v.string(),
  content: v.optional(JsonValueSchema),
});
const PeerOutboxMessageSchema = v.object({
  receiver_agent_name: v.string(),
  receiver_user_id: v.string(),
  topic: v.string(),
  body: JsonValueSchema,
  mode: WorkModeSchema,
  reply_expected: v.boolean(),
});

// ── Receiver side ────────────────────────────────────────────────

export interface ReceiverDeps {
  log: EventLog;
  /** The receiver's own file plane — an oversize body is spilled here so the
   *  event brief can name where the rest of it lives. */
  vfs: VFS;
  /** Whether the sender is the same owner as this receiver. */
  isSameOwner(sender_user_id: string): Promise<boolean>;
  /** Whether the receiver has explicitly granted this sender access. */
  hasGrant(sender_agent_name: string, sender_user_id: string): Promise<boolean>;
  /** Open a peer-back reply channel for an admitted ask (reply_expected). */
  openPeerBackChannel?(event_id: string, msg: PeerMessage): void;
}

/** Receiver API: accept a peer message off the transport. Admitted/dropped. */
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
    kinu_mode: msg.mode,
    reply_expected: msg.reply_expected ?? false,
  };
  if (bodyPath) Object.assign(payload, { body_path: bodyPath });

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
    return { admitted: false, reason: renderThrownChain({ cause: err }) };
  }
}

// ── PeerHub — sender/receiver endpoint over one agent's hub ─────

/** Delivery retry policy: exponential backoff from 5s over at most 8 attempts, so
 *  the longest wait a row ever gets is 5_000·2⁶ = 320 s and then it dead-letters.
 *  Receiver refusals dead-letter immediately. There is no ceiling constant — the 1h
 *  one that used to sit here could not bind at 8 attempts, so it was a bound that
 *  could not fail. */
const MAX_DELIVERY_ATTEMPTS = 8;
const RETRY_BASE_MS = 5_000;

interface PeerBackHolder {
  agent_name: string;
  user_id: string;
  ask_id: string;
  mode: WorkMode;
}

export interface PeerHubDeps {
  /** The agent's own storage (`outbox_peer` lives next to agent_log). */
  sql: SqlExec;
  log: EventLog;
  replyChannels: ReplyChannelStore;
  /** Thunk: the runtime's file plane is built lazily, so it is dereferenced
   *  per received message, never at hub construction. */
  vfs(): VFS;
  selfAgentName(): string;
  /** The owning user id. Throw when the agent is unclaimed. */
  selfUserId(): string;
  /** The hop to the receiver agent's `receivePeerMessage` — the only part of
   *  this transport a host owns (cross-DO RPC on the cloud backend). */
  deliver(receiver_agent_name: string, msg: PeerMessage): Promise<ReceiveResult>;
  isSameOwner(sender_user_id: string): Promise<boolean>;
  hasGrant(sender_agent_name: string, sender_user_id: string): Promise<boolean>;
  /** Arm the host's alarm so pending outbox rows are re-driven after eviction.
   *  This is the outbox policy's `schedule` seam. Awaited: on the cloud backend
   *  it is a Durable Object storage write, and a Durable Object has no way to
   *  retain an unawaited one (`do.wait_until.no_op`). */
  scheduleDispatch(at: number): Promise<void>;
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
   *  awaits inside the current activation. A reply with no waiter (timeout
   *  passed, or the agent evicted) stays a pending event and wakes a normal
   *  turn. */
  private readonly waiters = new Map<string, (envelope: { content: JsonValue | undefined }) => void>();
  /** The shared durable outbox this transport's rows live in. */
  private readonly outbox: Outbox<PeerOutboxMessage>;

  constructor(private readonly deps: PeerHubDeps) {
    this.outbox = scheduledOutbox<PeerOutboxMessage>(deps.sql, 'peer', {
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      baseMs: RETRY_BASE_MS,
      // Per-receiver delivery order: a backed-off head holds the rows queued
      // behind it for that receiver and for no other.
      orderBy: (message) => `${message.receiver_user_id}:${message.receiver_agent_name}`,
      schedule: (at) => deps.scheduleDispatch(at),
      send: (message, info) => this.deliverOne(message, info.id),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ── Receiving ──────────────────────────────────────────────────

  /** The receiving half, behind whatever RPC surface a host exposes. */
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
          mode: m.mode,
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
   *  agent DELIVERED to exactly this sender. The outbox row id is only known to
   *  that receiver, so the correlation is unforgeable by third parties. */
  private isReplyToMyAsk(msg: PeerMessage): boolean {
    if (msg.topic !== PEER_REPLY_TOPIC) return false;
    const body = v.safeParse(ReplyBodySchema, msg.body);
    if (!body.success) return false;
    const record = this.outbox.status(body.output.in_reply_to);
    if (record?.state !== 'sent') return false;
    const ask = v.safeParse(PeerOutboxMessageSchema, record.message);
    if (!ask.success) return false;
    return ask.output.receiver_agent_name === msg.sender_agent_name
      && ask.output.receiver_user_id === msg.sender_user_id
      && ask.output.reply_expected;
  }

  /** Match a transport reply envelope to a live ask waiter. */
  private resolveAskWaiter(msg: PeerMessage): string | null {
    if (msg.topic !== PEER_REPLY_TOPIC) return null;
    const body = v.safeParse(ReplyBodySchema, msg.body);
    if (!body.success) return null;
    const askId = body.output.in_reply_to;
    const resolve = this.waiters.get(askId);
    if (!resolve) return null;
    resolve({ content: body.output.content });
    return askId;
  }

  // ── Sending ────────────────────────────────────────────────────

  /** Fire-and-forget. */
  async send(input: { agent: string; userId: string; topic: string; message: string; mode: WorkMode }): Promise<PeerSendOutcome> {
    const id = await this.enqueue(input.agent, input.userId, input.topic, input.message, input.mode, false);
    await this.dispatchOutbox();
    const row = this.outbox.status(id);
    if (row?.state === 'dlq') return { status: 'rejected', reason: row.lastError ?? 'rejected by receiver' };
    return { status: row?.state === 'sent' ? 'delivered' : 'queued', message_id: id };
  }

  /** Send-and-await over the async transport. */
  async ask(input: { agent: string; userId: string; topic: string; message: string; timeoutMs: number; mode: WorkMode }): Promise<PeerAskOutcome> {
    const askId = await this.enqueue(input.agent, input.userId, input.topic, input.message, input.mode, true);
    const wait = this.registerWaiter(askId, input.timeoutMs);
    await this.dispatchOutbox();
    const row = this.outbox.status(askId);
    if (row?.state === 'dlq') {
      wait.cancel();
      return { status: 'rejected', reason: row.lastError ?? 'rejected by receiver' };
    }
    const reply = await wait.promise;
    if (reply) return { status: 'replied', from: input.agent, reply: reply.content };
    return {
      status: 'no_reply',
      note: `${input.agent} did not answer within ${Math.round(input.timeoutMs / 1000)}s. ` +
        `The message was ${row?.state === 'sent' ? 'delivered' : 'queued for delivery'}; ` +
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
  async dispatchPeerBack(channel: ReplyChannelRow, payload: JsonValue): Promise<{ delivered: boolean; detail?: string }> {
    let holder: PeerBackHolder;
    try {
      holder = v.parse(PeerBackHolderSchema, parseJsonObject(channel.holder_addr));
    } catch {
      return { delivered: false, detail: 'malformed peer_back holder_addr' };
    }
    await this.enqueue(holder.agent_name, holder.user_id, PEER_REPLY_TOPIC, {
      in_reply_to: holder.ask_id,
      content: payload,
    }, holder.mode, false);
    await this.dispatchOutbox();
    // Durable handoff: the outbox owns retries from here on.
    return { delivered: true };
  }

  private async enqueue(
    receiverAgent: string,
    receiverUserId: string,
    topic: string,
    body: JsonValue,
    mode: WorkMode,
    replyExpected: boolean,
  ): Promise<string> {
    const { id } = await this.outbox.queue({
      receiver_agent_name: receiverAgent,
      receiver_user_id: receiverUserId,
      topic,
      body,
      mode,
      reply_expected: replyExpected,
    }, { now: this.now() });
    return id;
  }

  // ── Outbox dispatch ────────────────────────────────────────────

  /** Deliver due pending outbox rows in per-receiver id order. Transient
   *  failures back off and block that receiver's queue (ordering); receiver
   *  refusals dead-letter the row. Reentrancy-guarded by the outbox — the alarm
   *  and inline tool dispatches can overlap on the same activation. */
  async dispatchOutbox(now = this.now()): Promise<void> {
    await this.outbox.drain(now);
  }

  /** One delivery attempt, as the outbox policy's `send`. A resolved refusal is
   *  permanent (the receiver will refuse the next attempt for the same reason);
   *  a thrown hop is transport trouble and backs off. */
  private async deliverOne(message: PeerOutboxMessage, id: string): Promise<OutboxDisposition> {
    const parsed = v.safeParse(PeerOutboxMessageSchema, message);
    if (!parsed.success) {
      return { status: 'poison', reason: 'peer outbox row is missing a valid work mode' };
    }
    const queued = parsed.output;
    const wire: PeerMessage = {
      sender_event_id: id,
      sender_agent_name: this.deps.selfAgentName(),
      sender_user_id: this.deps.selfUserId(),
      topic: queued.topic,
      body: queued.body,
      mode: queued.mode,
    };
    if (queued.reply_expected) Object.assign(wire, { reply_expected: true });
    let result: ReceiveResult;
    try {
      result = await this.deps.deliver(queued.receiver_agent_name, wire);
    } catch (err) {
      // A thrown hop is a value here: the disposition the outbox backs off on.
      // Rendered rather than rethrown so the stored `last_error` keeps the chain.
      return { status: 'retry', reason: renderThrownChain({ cause: err }) };
    }
    // Admitted now, or deduped by the receiver (a crash redelivery) — sent
    // either way. Anything else is a refusal (e.g. no cross-owner grant).
    if (result.admitted || result.event_id) return { status: 'sent' };
    return { status: 'poison', reason: result.reason ?? 'rejected by receiver' };
  }

  /** Soonest pending retry — folded into the host's alarm reschedule. */
  nextRetryAt(): number | null {
    return this.outbox.nextRetryAt();
  }

  private registerWaiter(askId: string, timeoutMs: number) {
    let cancel!: () => void;
    const promise = new Promise<{ content: JsonValue | undefined } | null>((resolve) => {
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
