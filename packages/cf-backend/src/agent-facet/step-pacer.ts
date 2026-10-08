/**
 * A facet runs under its own CPU budget of about 30 s, and its parent's `limits.cpu_ms` does not raise it; a turn kept
 * inside the one call that started it dies after some twenty steps (platform catalog `do.facet.cpu_ms`). So each model
 * step waits for a call into this facet that grants it, and that call stays open until the step has ended: the step runs
 * on that call's budget. The workspace makes the call when the facet asks for it, whoever started the turn.
 */
import { Effect } from 'effect';
import { attempt, KinuError, settle, toKinuError } from '@kinu.run/core/obs';
import type { AgentWorkspace } from './agent-turn';

export class StepPacer {
  private readonly waiting = new Map<string, (ended: () => void) => void>();

  /** Resolves with the step's end once a call grants it. */
  pace(workspace: Pick<AgentWorkspace, 'paceStep'>, turnId: string, signal: AbortSignal): Promise<() => void> {
    const granted = Effect.callback<() => void, KinuError>((resume) => {
      const stopped = (): void => {
        resume(Effect.fail(toKinuError({ doing: `waiting for leave to run turn ${turnId}'s step`, cause: signal.reason, otherwise: 'unavailable' })));
      };

      this.waiting.set(turnId, (ended) => { resume(Effect.succeed(ended)); });
      signal.addEventListener('abort', stopped, { once: true });

      return Effect.sync(() => { signal.removeEventListener('abort', stopped); });
    });

    // The workspace answers once the step it granted has ended; an answer before the grant granted nothing.
    const unanswered = attempt({ doing: `asking the workspace to run turn ${turnId}'s step`, otherwise: 'unavailable' }, () => workspace.paceStep(turnId)).pipe(
      Effect.flatMap(() => Effect.fail(new KinuError('unavailable', `The workspace answered turn ${turnId}'s step without granting it.`))),
    );

    return settle(Effect.raceFirst(granted, unanswered).pipe(Effect.ensuring(Effect.sync(() => { this.waiting.delete(turnId); }))));
  }

  /** The call a step runs under: answers once the step has ended. */
  async grant(turnId: string): Promise<void> {
    const waiting = this.waiting.get(turnId);

    if (waiting === undefined) return await settle(Effect.fail(new KinuError('missing', `No step of turn ${turnId} is waiting to run.`)));
    this.waiting.delete(turnId);
    const ended = Promise.withResolvers<void>();

    waiting(() => { ended.resolve(); });
    await ended.promise;
  }
}
