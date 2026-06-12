/**
 * PeerAgent ingress — always-async transport.
 *
 * Sender side:
 *   `enqueueOutboundPeer(...)` writes a `peer_outbox` row and schedules
 *   a DO alarm to dispatch it. Never blocks on the receiver.
 *
 * Receiver side:
 *   `receivePeerMessage(...)` is invoked by the sender's alarm via DO RPC.
 *   The receiver writes a PeerAgent event into its own EventLog and acks.
 *
 * Ordering: per-(sender, receiver) preserved by sender's outbox sequence
 * + receiver-side dedupe on `(sender_agent, sender_event_id)`.
 *
 * Cross-owner messaging requires the receiver to have granted the
 * specific sender access — the grant is enforced by the receiver UserDO,
 * never trusted from the sender's claim.
 */

import {
  type EventLog, type PeerAgentPayload, ulid,
} from '@proteus/core';

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
    payload: { topic: opts.topic, body: opts.body },
    causality_event_id: opts.caused_by_event_id ?? null,
    next_attempt_at: now,
  });
  deps.scheduleDispatch(now);
  return id;
}

// ── Receiver side ────────────────────────────────────────────────

export interface ReceiverDeps {
  log: EventLog;
  /** Whether the sender is the same owner as this receiver (UserDO lookup). */
  isSameOwner(sender_user_id: string): Promise<boolean>;
  /** Whether the receiver has explicitly granted this sender access. */
  hasGrant(sender_agent_name: string, sender_user_id: string): Promise<boolean>;
}

export interface PeerMessage {
  sender_event_id: string;       // for receiver-side dedupe
  sender_agent_name: string;
  sender_user_id: string;
  topic: string;
  body: unknown;
}

/** Receiver API: accept a peer message via DO RPC. Returns admitted/dropped. */
export async function receivePeerMessage(
  deps: ReceiverDeps,
  msg: PeerMessage,
  now: number,
): Promise<{ admitted: boolean; event_id?: string; reason?: string }> {
  const same_owner = await deps.isSameOwner(msg.sender_user_id);
  const receiver_grant_present = same_owner
    ? true   // same-owner peers don't need an explicit grant beyond ownership
    : await deps.hasGrant(msg.sender_agent_name, msg.sender_user_id);

  if (!same_owner && !receiver_grant_present) {
    return { admitted: false, reason: 'no grant from receiver for cross-owner sender' };
  }

  const payload: PeerAgentPayload = {
    from_agent_name: msg.sender_agent_name,
    from_user_id: msg.sender_user_id,
    topic: msg.topic,
    body: msg.body,
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
    return { admitted, event_id: id };
  } catch (err) {
    return { admitted: false, reason: (err as Error).message };
  }
}
