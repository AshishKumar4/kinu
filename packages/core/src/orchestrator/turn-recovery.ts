/**
 * Whether a turn a dead process left open may run on: the one decision for the recovery sweep and for the session
 * re-opening its own open run. A turn the decision closes is settled here; its run is the caller's to close.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { attempt, diagnostics } from '../obs/index';
import type { AgentRuntime } from '../types/agent-runtime';
import type { AgentStores } from '../state/agent-stores';
import type { PreparedRequest } from '../session/requests';
import { readVersionedScaffoldSource } from '../scaffold/versions';
import { sha256Hex } from '../safety/argument-digest';
import { verifyClaimedProgram, type ClaimOutcome, type ContextRevision, type StoredActorClaim } from './actor-claims';
import { recordRecoverySettled, sameBuildOf } from './turn-recovery-events';
import type { RunEventRecorder } from '../events/recorder';

type ClosedBy = 'stopped' | 'record_unreadable' | 'stalled' | 'unverified';

/**
 * `continue`: owed and verified, or never claimed, so it consumed nothing. `active`: a live turn here opened while this
 * read, so this decides nothing. `closed`: settled already (`settled`), or by this decision.
 */
export type InterruptedTurnVerdict =
  | { readonly kind: 'continue' }
  | { readonly kind: 'active' }
  | { readonly kind: 'closed'; readonly cause: 'settled' | ClosedBy };

export interface InterruptedTurn {
  readonly runtime: AgentRuntime;
  readonly stores: Pick<AgentStores, 'claims' | 'history'>;
  /** Where a Stop is recorded (`stop_requested`); none read, none found. */
  readonly runs: Pick<RunEventRecorder, 'stopRequested'> | null;
  readonly installedBuild: string | null;
  readonly workspace: string;
  readonly actor: string;
  readonly runId: string;
  readonly claim: StoredActorClaim | null;
  /** Read between the awaits: a turn that opened meanwhile owns the claim. */
  readonly turnOpen: () => boolean;
}

/** Call only with recovery authority. Verified claims stay owed: bytes alone do not prove the turn finished. */
export function decideInterruptedTurn(turn: InterruptedTurn): Effect.Effect<InterruptedTurnVerdict> {
  return Effect.gen(function* () {
    const { claim, stores } = turn;

    if (claim?.outcome !== undefined && claim.outcome !== null) return { kind: 'closed', cause: 'settled' } as const;

    if (turn.turnOpen()) return { kind: 'active' } as const;
    const stopped = turn.runs?.stopRequested(turn.runId) === true;

    if (claim === null) return stopped ? { kind: 'closed', cause: 'stopped' } as const : { kind: 'continue' } as const;

    const settled = (outcome: ClaimOutcome, cause: ClosedBy): InterruptedTurnVerdict => {
      stores.claims.settleRecovered(claim.turnId, claim.epoch, outcome);
      recordRecoverySettled({ workspace: turn.workspace, actor: turn.actor, cause, sameBuild: sameBuildOf(claim.program.build, turn.installedBuild) });

      return { kind: 'closed', cause };
    };

    // The outcome the stopped turn would have settled its claim with.
    if (stopped) return settled('aborted', 'stopped');

    const evidence = yield* consumedEvidence(stores, claim);

    if (turn.turnOpen()) return { kind: 'active' } as const;

    if ('failure' in evidence) {
      diagnostics.failure('actor.turn_record_unreadable', evidence.failure, { actor: turn.actor, turn: claim.turnId });

      return settled('error', 'record_unreadable');
    }

    const verdict = yield* Effect.promise(() => verifyClaimedProgram(
      claim,
      (version) => readVersionedScaffoldSource(turn.runtime, version),
      (source) => sha256Hex(source),
      evidence.context,
    ));

    const stalled = verdict.kind === 'verified' && (yield* Effect.promise(() => stalledRun(stores, claim, turn.installedBuild)));

    if (turn.turnOpen()) return { kind: 'active' } as const;

    if (stalled) {
      diagnostics.event('actor.turn_stalled', { actor: turn.actor, turn: claim.turnId, runs: claim.epoch });

      return settled('error', 'stalled');
    }

    // A host that stamps no build (the CLI) recorded none at admission either: nothing to compare, so nothing changed.
    if (verdict.kind === 'verified' || (verdict.kind === 'build_unknown' && turn.installedBuild === null)) return { kind: 'continue' } as const;

    return settled('indeterminate', 'unverified');
  });
}

/** The claim's consumed request, or why its own rows cannot be read: a failure no later sweep reads differently. */
function consumedEvidence(stores: Pick<AgentStores, 'claims'>, claim: StoredActorClaim): Effect.Effect<{ readonly context: ContextRevision } | { readonly failure: KinuError }> {
  return attempt({ doing: 'reading the request record of an interrupted turn', otherwise: 'io' }, () => stores.claims.consumedContext(claim.turnId)).pipe(
    // Absent is as unrecoverable as corrupt.
    Effect.map((context) => (context === null ? { failure: new KinuError('missing', 'claimed request evidence is missing') } : { context })),
    Effect.catch((failure) => Effect.succeed({ failure })),
  );
}

function furthestStep(requests: readonly { readonly epoch: number; readonly step: number | null }[], epoch: number): number {
  return requests.reduce((far, request) => (request.epoch === epoch && request.step !== null ? Math.max(far, request.step) : far), -1);
}

const AdmittedBuildSchema = v.looseObject({ installedBuild: v.nullable(v.string()) });

/** Undefined: none recorded. */
async function admittedBuild(stores: Pick<AgentStores, 'history'>, admission: PreparedRequest | undefined): Promise<string | null | undefined> {
  if (admission === undefined) return undefined;
  const recorded = v.safeParse(AdmittedBuildSchema, await stores.history.messages.payloads.read(admission.metadata));

  return recorded.success ? recorded.output.installedBuild : undefined;
}

async function stalledRun(stores: Pick<AgentStores, 'history'>, claim: StoredActorClaim, installedBuild: string | null): Promise<boolean> {
  if (claim.epoch < 2 || installedBuild === null) return false;
  const requests = stores.history.requests.forTurn(claim.turnId);
  const admission = (epoch: number) => requests.find((request) => request.epoch === epoch && request.step === null);
  const builds = await Promise.all([admittedBuild(stores, admission(claim.epoch - 1)), admittedBuild(stores, admission(claim.epoch))]);

  if (builds.some((build) => build !== installedBuild)) return false;

  return furthestStep(requests, claim.epoch) <= furthestStep(requests, claim.epoch - 1);
}
