import * as v from 'valibot';
import { CLAIM_OUTCOMES, type ActorClaimStore } from './actor-claims';
import type { PendingSendStore } from './inbox';
import type { SessionTranscriptReader } from '../session/transcript';

/** Where a send stands, read from its durable facts alone: what a client asks after any break, never inferred. */
export const SendStateSchema = v.variant('status', [
  /** Its reservation is owed: no turn has taken it yet. */
  v.object({ status: v.literal('queued') }),
  /** The entry under its id names the turn that took it; that turn's claim holds no outcome yet. */
  v.object({ status: v.literal('running'), turnId: v.string() }),
  v.object({ status: v.literal('settled'), turnId: v.string(), outcome: v.picklist(CLAIM_OUTCOMES) }),
  /** Neither: handed back to its sender, refused before a turn took it, or never sent. */
  v.object({ status: v.literal('none') }),
]);

export type SendState = v.InferOutput<typeof SendStateSchema>;

export interface SendFacts {
  readonly transcript: Pick<SessionTranscriptReader, 'read'>;
  readonly pendingSends: Pick<PendingSendStore, 'has'>;
  readonly claims: Pick<ActorClaimStore, 'read'>;
}

export function sendStateOf(facts: SendFacts, id: string): SendState {
  const turnId = facts.transcript.read(id)?.turnId ?? null;

  if (turnId === null) return { status: facts.pendingSends.has(id) ? 'queued' : 'none' };
  const outcome = facts.claims.read(turnId)?.outcome ?? null;

  return outcome === null ? { status: 'running', turnId } : { status: 'settled', turnId, outcome };
}
