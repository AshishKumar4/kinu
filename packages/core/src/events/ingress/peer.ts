/**
 * Async agent-to-agent transport over the shared outbox; the host supplies only `deliver`.
 * Per-(sender, receiver) order comes from outbox id order plus receiver-side dedupe on
 * `(sender_agent, sender_event_id)`. Cross-owner grants are enforced receiver-side. `ask` has no
 * elapsed bound: an answer outliving the waiting activation arrives as a normal peer event.
 */

import * as v from 'valibot';
import { WorkModeSchema } from '../../types/turn';
import type { EventLog } from '../hub/log';
import type { ReplyChannelStore } from '../hub/reply-channel';
import type { PeerAgentPayload, ReplyChannelRow } from '../hub/types';
import { spillEventContent } from '../hub/content-spill';
import { scheduledOutbox, type Outbox, type OutboxDisposition } from '../outbox';
import {
  PEER_REPLY_TOPIC,
  type PeerAskOutcome, type PeerReplyOutcome, type PeerSendOutcome,
} from '../../types/peers';
import { countMsgReceived } from '../../obs/msg-counters';
import type { SqlExec, VFS } from '../../types/primitives';
import type { WorkMode } from '../../types/turn';
import {
  JsonValueSchema, parseJsonObject,
  type JsonValue,
} from '../../utils/json';
import { renderThrownChain } from '../../obs/index';

export interface PeerMessage {
  sender_event_id: string;
  sender_agent_name: string;
  sender_user_id: string;
  topic: string;
  body: JsonValue;
  mode: WorkMode;
  reply_expected?: boolean;
}

export interface ReceiveResult {
  admitted: boolean;
  event_id?: string;
  reason?: string;
}

export interface PeerOutboxMessage {
  receiver_agent_name: string;
  receiver_user_id: string;
  topic: string;
  body: JsonValue;
  mode: WorkMode;
  reply_expected: boolean;
}

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

export interface ReceiverDeps {
  log: EventLog;
  vfs: VFS;
  isSameOwner(sender_user_id: string): Promise<boolean>;
  hasGrant(sender_agent_name: string, sender_user_id: string): Promise<boolean>;
  openPeerBackChannel?(event_id: string, msg: PeerMessage): void;
}

/** Resolves admitted or refused (permanent); rejects when undecided, which the sender retries. */
export async function receivePeerMessage(
  deps: ReceiverDeps,
  msg: PeerMessage,
  now: number,
): Promise<ReceiveResult> {
  const same_owner = await deps.isSameOwner(msg.sender_user_id);

  const receiver_grant_present = same_owner
    ? true
    : await deps.hasGrant(msg.sender_agent_name, msg.sender_user_id);

  const serialized = JSON.stringify(msg.body);

  const counted = (admitted: boolean): void => countMsgReceived({
    from: msg.sender_agent_name,
    topic: msg.topic,
    messageId: msg.sender_event_id,
    chars: serialized.length,
    admitted,
  });

  if (!same_owner && !receiver_grant_present) {
    counted(false);

    return { admitted: false, reason: 'no grant from receiver for cross-owner sender' };
  }

  const spilled = await spillEventContent(deps.vfs, serialized);

  const payload: PeerAgentPayload = {
    from_agent_name: msg.sender_agent_name,
    from_user_id: msg.sender_user_id,
    topic: msg.topic,
    body: msg.body,
    sender_event_id: msg.sender_event_id,
    kinu_mode: msg.mode,
    reply_expected: msg.reply_expected ?? false,
  };

  if (spilled?.path !== undefined) payload.body_path = spilled.path;

  if (spilled?.unsaved !== undefined) payload.body_unsaved = spilled.unsaved;

  let published: { id: string; admitted: boolean };

  try {
    published = deps.log.publish({
      descriptor: {
        ingress: 'peer_async',
        variant: 'peer_agent',
        payload,
        same_owner,
        receiver_grant_present,
      },
      now,
    });
  } catch (err) {
    // Reported as a hop failure: a refusal would dead-letter for good.
    counted(false);
    throw err;
  }

  counted(published.admitted);

  if (published.admitted && msg.reply_expected) deps.openPeerBackChannel?.(published.id, msg);

  return { admitted: published.admitted, event_id: published.id };
}

/** Receiver refusals dead-letter immediately. */
const MAX_DELIVERY_ATTEMPTS = 8;

const RETRY_BASE_MS = 5_000;

interface PeerBackHolder {
  agent_name: string;
  user_id: string;
  ask_id: string;
  mode: WorkMode;
}

interface OutboundPeerMessage {
  readonly receiverAgent: string;
  readonly receiverUserId: string;
  readonly topic: string;
  readonly body: JsonValue;
  readonly mode: WorkMode;
  readonly replyExpected: boolean;
}

export interface PeerHubDeps {
  sql: SqlExec;
  log: EventLog;
  replyChannels: ReplyChannelStore;
  /** Built lazily; dereferenced per received message. */
  vfs(): VFS;
  selfAgentName(): string;
  /** Throws when the agent is unclaimed. */
  selfUserId(): string;
  deliver(receiver_agent_name: string, msg: PeerMessage): Promise<ReceiveResult>;
  isSameOwner(sender_user_id: string): Promise<boolean>;
  hasGrant(sender_agent_name: string, sender_user_id: string): Promise<boolean>;
  /** Awaited: on a Durable Object an unawaited storage write is not retained
   *  (`do.wait_until.no_op`). */
  scheduleDispatch(at: number): Promise<void>;
  onAdmitted(): void;
  now?(): number;
}

export class PeerHub {
  /** Live only within the asking activation; a reply without a waiter wakes a normal turn. */
  private readonly waiters = new Map<string, (envelope: { content: JsonValue | undefined }) => void>();
  private readonly outbox: Outbox<PeerOutboxMessage>;

  constructor(private readonly deps: PeerHubDeps) {
    this.outbox = scheduledOutbox<PeerOutboxMessage>(deps.sql, 'peer', {
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      baseMs: RETRY_BASE_MS,
      // A backed-off head blocks only its own receiver's queue.
      orderBy: (message) => `${message.receiver_user_id}:${message.receiver_agent_name}`,
      schedule: (at) => deps.scheduleDispatch(at),
      send: (message, info) => this.deliverOne(message, info.id),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async receive(msg: PeerMessage): Promise<ReceiveResult> {
    const now = this.now();

    const result = await receivePeerMessage({
      log: this.deps.log,
      vfs: this.deps.vfs(),
      isSameOwner: (uid) => this.deps.isSameOwner(uid),
      // Asking is consenting to the answer; otherwise a cross-owner ask could never complete.
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
        // Bind the event so the post-turn drain does not re-fire it.
        this.deps.log.markConsumed(result.event_id, `peer-ask-${askId}`, 0);
      } else {
        this.deps.onAdmitted();
      }
    }

    return result;
  }

  /** Unforgeable: only that receiver knows the outbox row id. */
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

  async send(input: { agent: string; userId: string; topic: string; message: string; mode: WorkMode }): Promise<PeerSendOutcome> {
    const id = await this.enqueue({
      receiverAgent: input.agent, receiverUserId: input.userId, topic: input.topic,
      body: input.message, mode: input.mode, replyExpected: false,
    });

    await this.dispatchOutbox();
    const row = this.outbox.status(id);

    if (row?.state === 'dlq') return { status: 'rejected', reason: row.lastError ?? 'rejected by receiver' };

    return { status: row?.state === 'sent' ? 'delivered' : 'queued', message_id: id };
  }

  /** No elapsed limit: ends on reply, caller cancel, or dead-letter. */
  async ask(input: {
    agent: string; userId: string; topic: string; message: string; mode: WorkMode; signal?: AbortSignal;
  }): Promise<PeerAskOutcome> {
    const askId = await this.enqueue({
      receiverAgent: input.agent, receiverUserId: input.userId, topic: input.topic,
      body: input.message, mode: input.mode, replyExpected: true,
    });

    const wait = this.registerWaiter(askId, input.signal);
    await this.dispatchOutbox();
    const row = this.outbox.status(askId);

    if (row?.state === 'dlq') {
      wait.cancel();

      return { status: 'rejected', reason: row.lastError ?? 'rejected by receiver' };
    }

    const reply = await wait.promise;

    if (reply) return { status: 'replied', from: input.agent, reply: reply.content };

    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error('peer ask cancelled');
    }

    throw new Error('the peer ask waiter resolved without a reply, cancellation, or a dead-letter');
  }

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

  async dispatchPeerBack(channel: ReplyChannelRow, payload: JsonValue): Promise<{ delivered: boolean; detail?: string }> {
    let holder: PeerBackHolder;

    try {
      holder = v.parse(PeerBackHolderSchema, parseJsonObject(channel.holder_addr));
    } catch (error) {
      return { delivered: false, detail: `malformed peer_back holder_addr: ${renderThrownChain({ cause: error })}` };
    }

    await this.enqueue({
      receiverAgent: holder.agent_name, receiverUserId: holder.user_id, topic: PEER_REPLY_TOPIC,
      body: { in_reply_to: holder.ask_id, content: payload },
      mode: holder.mode, replyExpected: false,
    });
    await this.dispatchOutbox();

    return { delivered: true };
  }

  private async enqueue(message: OutboundPeerMessage): Promise<string> {
    const { id } = await this.outbox.queue({
      receiver_agent_name: message.receiverAgent,
      receiver_user_id: message.receiverUserId,
      topic: message.topic,
      body: message.body,
      mode: message.mode,
      reply_expected: message.replyExpected,
    }, { now: this.now() });

    return id;
  }

  /** Reentrancy-guarded by the outbox: alarm and inline dispatches can overlap. */
  async dispatchOutbox(now = this.now()): Promise<void> {
    await this.outbox.drain(now);
  }

  /** A resolved refusal is permanent; a thrown hop backs off. */
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
      return { status: 'retry', reason: renderThrownChain({ cause: err }) };
    }

    // Deduped by the receiver (crash redelivery) still counts as sent.
    if (result.admitted || result.event_id) return { status: 'sent' };

    return { status: 'poison', reason: result.reason ?? 'rejected by receiver' };
  }

  nextRetryAt(): number | null {
    return this.outbox.nextRetryAt();
  }

  /** Timer-less: lives until reply, cancellation, or eviction. */
  private registerWaiter(askId: string, signal?: AbortSignal) {
    let cancel!: () => void;

    const promise = new Promise<{ content: JsonValue | undefined } | null>((resolve) => {
      let finished = false;

      const cleanup = (): boolean => {
        if (finished) return false;
        finished = true;
        this.waiters.delete(askId);
        signal?.removeEventListener('abort', onAbort);

        return true;
      };

      const onAbort = () => {
        if (cleanup()) resolve(null);
      };

      cancel = onAbort;

      if (signal?.aborted) {
        onAbort();

        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(askId, (envelope) => {
        if (cleanup()) resolve(envelope);
      });
    });

    return { promise, cancel };
  }
}
