/**
 * A facet runs under its own CPU budget, and its parent's `limits.cpu_ms` does not raise it: about 30 s of CPU on work
 * no newer call into it is waiting for, after which it is reset (platform catalog `do.facet.cpu_ms`, proven by probe in
 * ~/kinu-logs/research/FACET-CPU-LIMIT-1008.md §1, §5). A call into the facet that waits for a piece of work gives that
 * piece a budget of its own (§5), and a turn kept inside the one call that started it died after 22 steps (§3). So a
 * turn's steps run under a grant: a call the workspace makes into this facet when the facet asks for it, which stays
 * open, waiting on the steps, until the grant is let go.
 *
 * One grant serves a turn's steps while it has budget left: a step reuses the held grant, and asks for a new one only
 * when none is held for its execution, when the held one was revoked (the workspace rejects the open call as it cuts
 * the turn, so a Stop is fenced as each step's own call fenced it), when the step binds the turn's profile, or once the
 * held grant has been open {@link RENEW_AFTER_MS}. The facet cannot read its CPU time, so the bound is wall time, which
 * CPU on one isolate never exceeds: half the budget, leaving the step after it room. A grant is let go as its turn ends
 * (`release`), as the turn is stopped, or as the agent rests (`releaseAll`): a call held open keeps the workspace from
 * hibernating (#69).
 */
import { Effect, Exit } from 'effect';
import { attempt, hold, KinuError, settle, toKinuError } from '@kinu.run/core/obs';
import { PLATFORM_CATALOG, type DynamicContext, type HarnessMode, type ResolvedTurnProfile } from '@kinu.run/core';
import type { AgentWorkspace, TurnBound } from './agent-turn';

const RENEW_AFTER_MS = PLATFORM_CATALOG['do.facet.cpu_ms'].limit.value / 2;

/** A granted step: its end, which the step calls once it ended, the live block the grant carried, when the pace that
 *  asked for it bound the turn's profile, and the workspace's `harness.mode` as the grant left it. */
export interface GrantedStep {
  readonly ended: () => void;
  readonly dynamic: DynamicContext | null;
  readonly harnessMode: HarnessMode;
}

/** The grant a turn's steps run under: the execution it was asked for, when, the call it holds open, and the mode it
 *  carried, which each step it serves reads. */
interface HeldGrant {
  readonly bound: TurnBound;
  readonly at: number;
  readonly letGo: () => void;
  readonly harnessMode: HarnessMode;
  revoked: boolean;
}

export class StepPacer {
  private readonly waiting = new Map<string, (granted: GrantedStep) => void>();

  /** Each turn's held grant, by its turn: written as a grant arrives, dropped by {@link release}, {@link releaseAll}, a
   *  stop of its turn, or a newer grant of its turn. */
  private readonly held = new Map<string, HeldGrant>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Resolves with the step's grant: the held one, or one a call into the facet gives. `profile`: the turn's, on the step
   *  that binds it, which always asks. */
  pace(workspace: Pick<AgentWorkspace, 'paceStep'>, bound: TurnBound, signal: AbortSignal, profile: ResolvedTurnProfile | null): Promise<GrantedStep> {
    const held = this.held.get(bound.turnId);

    if (held !== undefined && profile === null && !held.revoked && !signal.aborted && sameExecution(held.bound, bound) && this.now() - held.at < RENEW_AFTER_MS) {
      return Promise.resolve({ ended: () => {}, dynamic: null, harnessMode: held.harnessMode });
    }

    this.release(bound.turnId);

    return settle(this.ask(workspace, bound, signal, profile));
  }

  /** The turn ended: the call its steps ran under answers. */
  release(turnId: string): void {
    const held = this.held.get(turnId);

    if (held === undefined) return;
    this.held.delete(turnId);
    held.letGo();
  }

  /** The agent rests: no turn of its holds a call open. */
  releaseAll(): void {
    const held = [...this.held.values()];

    this.held.clear();

    for (const grant of held) grant.letGo();
  }

  private ask(workspace: Pick<AgentWorkspace, 'paceStep'>, bound: TurnBound, signal: AbortSignal, profile: ResolvedTurnProfile | null): Effect.Effect<GrantedStep, KinuError> {
    const { turnId } = bound;

    return Effect.suspend(() => {
      let holding: HeldGrant | null = null;
      // The grant, if it arrives before its wait starts (the call is made first): taken by the wait as it starts.
      let early: GrantedStep | null = null;
      let take: (step: GrantedStep) => void = (step) => { early = step; };

      const arrive = (step: GrantedStep): void => { take(step); };

      this.waiting.set(turnId, arrive);

      // The call that grants it, held: it answers once the grant is let go, or settles first as the workspace cuts the
      // turn, which revokes the grant if it is held: the next step asks again, to be refused.
      const answered = hold(attempt({ doing: `asking the workspace to run turn ${turnId}'s steps`, otherwise: 'unavailable' }, () => workspace.paceStep(bound, profile)).pipe(
        Effect.ensuring(Effect.sync(() => { if (holding !== null) holding.revoked = true; })),
      ));

      const granted = Effect.callback<GrantedStep, KinuError>((resume) => {
        const stopped = (): void => {
          resume(Effect.fail(toKinuError({ doing: `waiting for leave to run turn ${turnId}'s step`, cause: signal.reason, otherwise: 'unavailable' })));
        };

        take = (step) => { resume(Effect.succeed(step)); };

        if (early !== null) take(early);
        signal.addEventListener('abort', stopped, { once: true });

        return Effect.sync(() => { signal.removeEventListener('abort', stopped); });
      });

      // Settled before the grant: refused, or answered without granting.
      const unanswered = Effect.promise(() => answered).pipe(Effect.flatMap((exit) => Exit.isFailure(exit)
        ? Effect.failCause(exit.cause)
        : Effect.fail(new KinuError('unavailable', `The workspace answered turn ${turnId}'s step without granting it.`))));

      return Effect.raceFirst(granted, unanswered).pipe(Effect.map((step): GrantedStep => {
        holding = { bound, at: this.now(), letGo: step.ended, harnessMode: step.harnessMode, revoked: false };
        this.held.set(turnId, holding);
        signal.addEventListener('abort', () => { this.release(turnId); }, { once: true });

        return { ended: () => {}, dynamic: step.dynamic, harnessMode: step.harnessMode };
      }));
    }).pipe(Effect.ensuring(Effect.sync(() => { this.waiting.delete(turnId); })));
  }

  /** The call a turn's steps run under: answers once its grant is let go. `dynamic`: the live block on the profile its
   *  pace bound; `harnessMode`: the workspace's as it granted. */
  async grant(turnId: string, dynamic: DynamicContext | null, harnessMode: HarnessMode): Promise<void> {
    const waiting = this.waiting.get(turnId);

    if (waiting === undefined) return await settle(Effect.fail(new KinuError('missing', `No step of turn ${turnId} is waiting to run.`)));
    this.waiting.delete(turnId);
    const ended = Promise.withResolvers<void>();

    waiting({ ended: () => { ended.resolve(); }, dynamic, harnessMode });
    await ended.promise;
  }
}

function sameExecution(held: TurnBound, bound: TurnBound): boolean {
  return held.runId === bound.runId && held.epoch === bound.epoch;
}
