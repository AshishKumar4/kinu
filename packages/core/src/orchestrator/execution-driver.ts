/**
 * One execution's life on an actor's session, for every input that opens one (design v2 §2, D2): chat turns, delivered
 * runs and a run's later rounds alike. Each round is opened, claimed as `preparing` (its epoch, its capability, minted),
 * declared and prepared under that capability, bound (the profile frozen under its key), executed, closed and
 * finished here, in that order. The input supplies only its assembly, the projection of each round's result, and the
 * next round's input.
 */
import type { ProfileAuthorityInputs, ResolvedTurnProfile } from '../profiles/resolve';
import type { JsonObject } from '../utils/json';
import type { WorkMode } from '../types/turn';
import { Cause, Effect } from 'effect';
import { KinuError, settle } from '../obs/index';
import type { ClaimOutcome, PreparingClaim } from './actor-claims';
import type { ChatEvent } from '../chat';
import type { ActorExecutionInput, ActorExecutionResult, ActorSession, ActorTurnLease } from './actor-session';
import type { TurnCapability } from './execution';
import type { FrozenAuthority } from './turn-facts';

/** A round opened and claimed: what its assembly declares and prepares under. */
export interface ClaimedRound {
  readonly index: number;
  readonly lease: ActorTurnLease;
  readonly capability: TurnCapability;
  /** What the execution froze as it first bound, which its recovery binds again and resolves nothing from; null for one
   *  that never bound (new input, a Retry's new run, a run's next round). */
  readonly frozen: FrozenAuthority | null;
  /** The bind transition, once, before any model or tool work: the profile is bound to the session and frozen under the
   *  execution's key. Assembly calls it as it resolves the profile. */
  readonly bind: (profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs) => void;
}

/** A round as its input assembled it. */
export interface AssembledRound {
  readonly input: ActorExecutionInput;
  readonly onEvent: (event: ChatEvent) => void | Promise<void>;
}

/** What a round's projection decided: the claim's outcome, and whether the execution goes on to another round. */
interface ProjectedRound {
  readonly claim: ClaimOutcome;
  readonly stop: boolean;
}

export interface DrivenExecution<A extends AssembledRound> {
  readonly runId: string;
  /** The first round's logical turn; a later round is its own, `turnId#n`. */
  readonly turnId: string;
  readonly mode: WorkMode;
  readonly metadata?: JsonObject;
  /** The first round's claim, reserved before the round began (`ActorSession.reserveExecution`): a run's preparation. */
  readonly reserved?: PreparingClaim;
  /** Asked before each round's claim, and between rounds: an execution stopped from outside claims nothing more. */
  readonly isAborted?: () => boolean;
  /** Wraps each round's preparation, execution and projection: the invocation context they run in. */
  within?<T>(body: () => Promise<T>): Promise<T>;
  /** Before the round's claim: what it records as it opens, and a recovery's decision on the execution it supersedes. */
  open?(lease: ActorTurnLease, index: number): Promise<void>;
  /** The declaration and preparation, under the round's capability; it binds through `bind` as it resolves. */
  assemble(round: ClaimedRound): Promise<A>;
  /** The executed round's result, committed: its claim's outcome, which a commit that closed the claim already holds. */
  project(round: ClaimedRound & { readonly assembled: A; readonly outcome: ActorExecutionResult }): Promise<ProjectedRound>;
  /** A round stopped before its claim: it ran nothing, and ends interrupted on `outcome`. Absent, it ends as a failure
   *  (`failed`) with the Stop as its cause. */
  stopped?(round: { readonly index: number; readonly lease: ActorTurnLease; readonly outcome: ActorExecutionResult }): Promise<void>;
  /** A round that failed before its projection answered. Answers its claim's outcome, as `project` does. */
  failed(round: { readonly index: number; readonly lease: ActorTurnLease; readonly failure: unknown }): Promise<ClaimOutcome>;
  /** Appends the next round's input and answers its turn; null ends the execution. */
  next?(round: { readonly index: number }): Promise<string | null>;
}

export async function driveExecution<A extends AssembledRound>(session: ActorSession, execution: DrivenExecution<A>): Promise<void> {
  return await settle(Effect.gen(function* () {
    let turnId = execution.turnId;

    for (let index = 0; ; index++) {
      // A later round is not opened once stopped; the first is, and ends as a Stop ends it (`stopped`).
      if (index > 0 && execution.isAborted?.() === true) return;

      // Derived, not minted: a recovered activation re-admits the same turn under the next epoch.
      const lease = session.beginTurn({ runId: execution.runId, turnId }, execution.mode, Date.now(), execution.metadata);
      const stop = yield* driveRound(session, execution, lease, index);

      if (stop || execution.isAborted?.() === true) return;
      const next = yield* Effect.promise(async () => await execution.next?.({ index }) ?? null);

      if (next === null) return;
      turnId = next;
    }
  }));
}

/** One round under `lease`, finished whatever it ends on: whether the execution stops after it. */
function driveRound<A extends AssembledRound>(session: ActorSession, execution: DrivenExecution<A>, lease: ActorTurnLease, index: number): Effect.Effect<boolean, KinuError> {
  // A round its projection left open is settled on the outcome it answered: a run's rounds commit no close of their own.
  const close = (outcome: ClaimOutcome): void => { if (session.claimOpen(lease)) session.settleTurnClaim(lease, outcome); };

  const reserved = index === 0 ? execution.reserved : undefined;

  const round = Effect.gen(function* () {
    yield* Effect.promise(async () => { await execution.open?.(lease, index); });

    // Stopped while it opened: nothing is claimed for it, and it ends as a Stop ends it.
    if (lease.signal.aborted || execution.isAborted?.() === true) {
      if (execution.stopped === undefined) return yield* Effect.fail(new KinuError('cancelled', 'The execution was stopped before it was claimed.'));
      yield* Effect.promise(async () => { await execution.stopped?.({ index, lease, outcome: await session.unexecuted(lease) }); });

      if (reserved !== undefined) session.settleReserved(reserved, 'aborted');

      return true;
    }

    const claimed = claimedRound(session, lease, index, reserved);

    const body = async (): Promise<ProjectedRound> => {
      // Per round: a promotion or a moved profile lands between rounds.
      const assembled = await execution.assemble(claimed);
      const outcome = await session.execute(lease, assembled.input, assembled.onEvent);

      return await execution.project({ ...claimed, assembled, outcome });
    };

    const projected = yield* Effect.promise(() => execution.within?.(body) ?? body());

    close(projected.claim);

    return projected.stop;
  });

  return round.pipe(
    Effect.catchCause((cause) => Effect.promise(async () => {
      const outcome = await execution.failed({ index, lease, failure: Cause.squash(cause) });

      close(outcome);

      // Reserved for this round before it began, and never adopted: it ends with the round.
      if (reserved !== undefined) session.settleReserved(reserved, outcome);

      return true;
    })),
    Effect.ensuring(Effect.sync(() => { session.finishTurn(lease); })),
  );
}

/** The round's claim, adopted from `reserved` or minted, and the bind it makes once as it assembles. */
function claimedRound(session: ActorSession, lease: ActorTurnLease, index: number, reserved: PreparingClaim | undefined): ClaimedRound {
  const capability = session.reserveClaim(lease, reserved);
  let bound = false;

  return {
    index, lease, capability, frozen: session.frozen(lease),
    bind: (profile, inputs) => {
      if (bound) return;
      bound = true;
      session.bindProfile(lease, profile, inputs);
    },
  };
}
