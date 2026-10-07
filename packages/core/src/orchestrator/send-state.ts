import type { ActorClaimStore, ClaimOutcome } from './actor-claims';
import type { PendingSendStore } from './inbox';
import type { SessionTranscriptReader } from '../session/transcript';

/** Where a send stands, read from its durable facts alone: what a client asks after any break, never inferred. */
export type SendState =
  /** Its reservation is owed: no turn has taken it yet. */
  | { readonly status: 'queued' }
  /** The entry under its id names the turn that took it; that turn's claim holds no outcome yet. */
  | { readonly status: 'running'; readonly turnId: string }
  | { readonly status: 'settled'; readonly turnId: string; readonly outcome: ClaimOutcome }
  /** Neither: handed back to its sender, refused before a turn took it, or never sent. */
  | { readonly status: 'none' };

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
