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
  listPeers(): Promise<Array<{ name: string; displayName?: string }>>;
  /** No elapsed limit; a reply that outlives this activation arrives as a peer event. */
  ask(input: { agent: string; topic: string; message: string; mode: WorkMode; signal?: AbortSignal }): Promise<PeerAskOutcome>;
  send(input: { agent: string; topic: string; message: string; mode: WorkMode }): Promise<PeerSendOutcome>;
  reply(input: { eventId: string; message: string }): Promise<PeerReplyOutcome>;
  /** Create or reuse a workspace by name and ask its agent, with the same unbounded wait. */
  spawnWorkspace(input: { name?: string; purpose: string; message: string; mode: WorkMode; signal?: AbortSignal }): Promise<PeerSpawnOutcome>;
}
