import * as v from 'valibot';
import { CLAIM_OUTCOMES, type ActorClaimStore, type ClaimOutcome } from './actor-claims';
import { STEER_METADATA_KEY, type PendingSendStore } from './inbox';
import { RUN_END_REASONS } from './turn-lifecycle';
import type { RunEventRecorder } from '../events/recorder';
import type { SessionTranscriptReader } from '../session/transcript';

/** A send that opened its turn, alone or carried with others, landed as `turn`; one the running turn read at a step, as
 *  `mid-turn`. */
const LandedSchema = v.picklist(['turn', 'mid-turn']);

/** Where a send stands, read from its durable facts alone: what a client asks after any break, never inferred. */
export const SendStateSchema = v.variant('status', [
  /** Its reservation is owed: no turn has taken it yet. */
  v.object({ status: v.literal('queued') }),
  /** The entry under its id names the turn that took it; that turn has not ended. */
  v.object({ status: v.literal('running'), turnId: v.string(), landed: LandedSchema }),
  v.object({ status: v.literal('settled'), turnId: v.string(), landed: LandedSchema, outcome: v.picklist(CLAIM_OUTCOMES) }),
  /** Neither: handed back to its sender, refused before a turn took it, or never sent. */
  v.object({ status: v.literal('none') }),
]);

export type SendState = v.InferOutput<typeof SendStateSchema>;

export interface SendFacts {
  readonly transcript: Pick<SessionTranscriptReader, 'read' | 'metadata'>;
  readonly pendingSends: Pick<PendingSendStore, 'has'>;
  readonly claims: Pick<ActorClaimStore, 'read'>;
  readonly runs: Pick<RunEventRecorder, 'endReason'>;
}

/** A turn that ended before it admitted a claim (a Stop or a failure while it was prepared) has only its run's end. */
function runEnd(runs: SendFacts['runs'], runId: string | null): ClaimOutcome | null {
  const reason = runId === null ? null : runs.endReason(runId);

  return reason === null ? null : v.parse(v.picklist(RUN_END_REASONS), reason);
}

export async function sendStateOf(facts: SendFacts, id: string): Promise<SendState> {
  const entry = facts.transcript.read(id);

  if (entry?.turnId == null) return { status: facts.pendingSends.has(id) ? 'queued' : 'none' };
  const { turnId, runId } = entry;
  const landed = (await facts.transcript.metadata(id))?.[STEER_METADATA_KEY] === true ? 'mid-turn' : 'turn';
  const claim = facts.claims.read(turnId);
  const outcome = claim === null ? runEnd(facts.runs, runId) : claim.outcome;

  return outcome === null ? { status: 'running', turnId, landed } : { status: 'settled', turnId, landed, outcome };
}
