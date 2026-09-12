/** The peer-messaging contract between workspaces, declared at the platform
 *  layer: the events ingress resolves reply envelopes and the peers tool
 *  consumes the same port without importing the delegation harness. */

import type { JsonValue } from '../utils/json';
import type { WorkMode } from './turn';

/** Reserved topic for transport-generated reply envelopes; user sends must not claim it. */
export const PEER_REPLY_TOPIC = 'peer_reply';

export type PeerSendOutcome =
  | { status: 'delivered' | 'queued'; message_id: string }
  | { status: 'rejected'; reason: string };

export type PeerAskOutcome =
  | { status: 'replied'; from: string; reply: JsonValue | undefined }
  | { status: 'rejected'; reason: string };

export type PeerReplyOutcome = { ok: true } | { ok: false; error: string };

export type PeerSpawnOutcome = { agent: string; created: boolean } & PeerAskOutcome;

export interface PeersToolDeps {
  /** The owner's other workspaces' agents this one may address (self excluded). */
  listPeers(): Promise<Array<{ name: string; displayName?: string }>>;
  /** Send-and-await: deliver a message and wait for the reply. There is no
   *  elapsed limit on the wait — it ends when the reply arrives, and a reply
   *  that outlives this activation arrives as a peer event instead. */
  ask(input: { agent: string; topic: string; message: string; mode: WorkMode; signal?: AbortSignal }): Promise<PeerAskOutcome>;
  /** Fire-and-forget: deliver a message without waiting for a reply. */
  send(input: { agent: string; topic: string; message: string; mode: WorkMode }): Promise<PeerSendOutcome>;
  /** Answer a peer message event received this (or an earlier) turn. */
  reply(input: { eventId: string; message: string }): Promise<PeerReplyOutcome>;
  /** Create (or reuse by name) a specialist workspace, message its agent, await
   *  the result — under the same no-elapsed-limit wait as {@link ask}. */
  spawnWorkspace(input: { name?: string; purpose: string; message: string; mode: WorkMode; signal?: AbortSignal }): Promise<PeerSpawnOutcome>;
}
