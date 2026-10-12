/**
 * One execution's rounds on an actor's session (design v2 §2, D2): each round is claimed, assembled and bound, executed,
 * settled and finished here, in that order, whatever drives it. The run that drives it supplies only its assembly, the
 * projection of each round's outcome, and its next round's input.
 */
import type { ProfileAuthorityInputs, ResolvedTurnProfile } from '../profiles/resolve';
import type { WorkMode } from '../types/turn';
import type { ClaimOutcome } from './actor-claims';
import type { ChatEvent } from '../chat';
import type { ActorExecutionInput, ActorExecutionResult, ActorSession, ActorTurnLease } from './actor-session';

/** A round as its run assembled it: the profile it binds and what it executes. */
export interface AssembledRound {
  readonly profile: ResolvedTurnProfile;
  readonly profileInputs: ProfileAuthorityInputs;
  readonly input: ActorExecutionInput;
  readonly onEvent: (event: ChatEvent) => void | Promise<void>;
}

/** What a round's projection decided: the claim's outcome, and whether the run goes on to another round. */
interface ProjectedRound {
  readonly claim: ClaimOutcome;
  readonly stop: boolean;
}

export interface DrivenRun<A extends AssembledRound> {
  readonly runId: string;
  /** The run's logical turn; a later round is `turnId#n`. */
  readonly turnId: string;
  readonly mode: WorkMode;
  readonly isAborted: () => boolean;
  assemble(lease: ActorTurnLease): Promise<A>;
  project(round: { readonly index: number; readonly lease: ActorTurnLease; readonly assembled: A; readonly outcome: ActorExecutionResult }): Promise<ProjectedRound>;
  /** Appends the next round's input; false ends the run. */
  next(round: { readonly index: number }): Promise<boolean>;
}

export async function driveRun<A extends AssembledRound>(session: ActorSession, run: DrivenRun<A>): Promise<void> {
  for (let index = 0; ; index++) {
    if (run.isAborted()) return;

    // Derived, not minted: a recovered activation re-admits the same turn under the next epoch.
    const lease = session.beginTurn({ runId: run.runId, turnId: index === 0 ? run.turnId : `${run.turnId}#${String(index)}` }, run.mode, Date.now());
    let stop: boolean;

    try {
      // Per round: a promotion or a moved profile lands between rounds.
      const assembled = await run.assemble(lease);

      session.bindProfile(lease, assembled.profile, assembled.profileInputs);
      const outcome = await session.execute(lease, assembled.input, assembled.onEvent);
      const projected = await run.project({ index, lease, assembled, outcome });

      session.settleTurnClaim(lease, projected.claim);
      ({ stop } = projected);
    } finally {
      session.finishTurn(lease);
    }

    if (stop || run.isAborted() || !await run.next({ index })) return;
  }
}
