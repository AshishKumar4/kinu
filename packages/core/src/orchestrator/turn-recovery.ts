/**
 * Whether a turn a dead process left open may run on: the one decision for the recovery sweep and for the session
 * re-opening its own open run. A turn the decision closes is settled here; its run is the caller's to close.
 */
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { attempt, diagnostics } from '../obs/index';
import type { AgentStores } from '../state/agent-stores';
import { sha256Hex } from '../safety/argument-digest';
import { cutsThrough, verifyClaimedProgram, type ClaimOutcome, type ContextRevision, type StoredActorClaim } from './actor-claims';
import { recordRecoverySettled, sameBuildOf } from './turn-recovery-events';
import type { RunEventRecorder } from '../events/recorder';
import type { ReportedTurn } from '../subordinates/turn-reports';

type ClosedBy = 'stopped' | 'answered' | 'record_unreadable' | 'stalled' | 'unverified';

/**
 * `continue`: owed and verified, or never claimed, so it consumed nothing. `active`: a live turn here opened while this
 * read, so this decides nothing. `closed`: settled already (`settled`), or by this decision.
 */
export type InterruptedTurnVerdict =
  | { readonly kind: 'continue' }
  | { readonly kind: 'active' }
  | { readonly kind: 'closed'; readonly cause: 'settled' | ClosedBy };

export interface InterruptedTurn {
  /** Reads retained program bytes; recovery never needs a composed execution seat. */
  readonly source: (version: number) => Promise<string | null>;
  readonly stores: Pick<AgentStores, 'claims' | 'history'>;
  /** Where a Stop is recorded (`stop_requested`); none read, none found. */
  readonly runs: Pick<RunEventRecorder, 'stopRequested'> | null;
  /** Whether the turn already gave its hirer the report that answers its assignment; absent where nothing is hired. */
  readonly answered?: (turn: ReportedTurn) => boolean;
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

    const settled = (open: StoredActorClaim, outcome: ClaimOutcome, cause: ClosedBy): InterruptedTurnVerdict => {
      stores.claims.settleRecovered(open.turnId, open.epoch, outcome);
      recordRecoverySettled({ workspace: turn.workspace, actor: turn.actor, cause, sameBuild: sameBuildOf(open.program?.build ?? null, turn.installedBuild) });

      return { kind: 'closed', cause };
    };

    // Never claimed, or claimed only to prepare: it consumed nothing, so it prepares again under the next epoch.
    if (claim === null || claim.status === 'preparing') {
      if (!stopped) return { kind: 'continue' } as const;

      return claim === null ? { kind: 'closed', cause: 'stopped' } as const : settled(claim, 'aborted', 'stopped');
    }

    // The outcome the stopped turn would have settled its claim with.
    if (stopped) return settled(claim, 'aborted', 'stopped');

    // Its hirer holds the answer already: run again, it would answer a closed assignment a second time.
    if (turn.answered?.(claim) === true) return settled(claim, 'indeterminate', 'answered');

    const evidence = yield* consumedEvidence(stores, claim);

    if (turn.turnOpen()) return { kind: 'active' } as const;

    if ('failure' in evidence) {
      diagnostics.failure('actor.turn_record_unreadable', evidence.failure, { actor: turn.actor, turn: claim.turnId });

      return settled(claim, 'error', 'record_unreadable');
    }

    const verdict = yield* Effect.promise(() => verifyClaimedProgram(
      claim,
      turn.source,
      (source) => sha256Hex(source),
      evidence.context,
    ));

    const cuts = verdict.kind === 'verified' ? cutsOf(stores, claim, turn.installedBuild) : { work: 0, provider: 0 };

    if (turn.turnOpen()) return { kind: 'active' } as const;

    if (cuts.work >= POISON_WORK_CUTS || cuts.provider >= STALLED_PROVIDER_CUTS) {
      diagnostics.event('actor.turn_stalled', { actor: turn.actor, turn: claim.turnId, epoch: claim.epoch, workCuts: cuts.work, providerCuts: cuts.provider });

      return settled(claim, 'error', 'stalled');
    }

    // A host that stamps no build (the CLI) recorded none at admission either: nothing to compare, so nothing changed.
    if (verdict.kind === 'verified' || (verdict.kind === 'build_unknown' && turn.installedBuild === null)) return { kind: 'continue' } as const;

    return settled(claim, 'indeterminate', 'unverified');
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

/**
 * Cuts inside a step's own work, in a row on one build with no step finishing, that settle the turn instead of running
 * it again: a step that ends its own process (a tool past the CPU or memory limit) would otherwise run forever. A turn
 * must outlast five resets from outside, the bar tardigrade's kill5 sets (2026-10-08: two such resets inside one long
 * step ended Kinu's turn), so the sixth cut in the step's own work is the step's.
 */
const POISON_WORK_CUTS = 6;

/**
 * Cuts while the step waits on the provider, likewise counted, that settle it. None is the step's fault, but a wait can
 * be the turn's: task-j7gjjr's model wait outlasted the workspace's memory and time limits fifteen times in a day
 * (2026-09-25), dropping every tab's socket each time. Twenty covers five outside resets four times over.
 */
const STALLED_PROVIDER_CUTS = 20;

/** The dead execution's cuts, itself counted ({@link TurnCut}); a host that stamps no build counts none. */
function cutsOf(stores: Pick<AgentStores, 'claims'>, claim: StoredActorClaim, installedBuild: string | null) {
  const cut = stores.claims.cutOf(claim.turnId);

  if (installedBuild === null || cut === null || cut.epoch !== claim.epoch || cut.build !== installedBuild) return { work: 0, provider: 0 };

  return cutsThrough(cut);
}
