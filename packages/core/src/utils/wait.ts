/** One ask-until-answered loop for CLI waits. Ends on the answer, the probe's failure, or abort; it carries no clock. */
import { Effect } from 'effect';
import { abortableSleep } from './abort';

export interface WaitOptions {
  readonly intervalMs: number;
  onWaiting?: () => void;
}

export interface StoppableWaitOptions extends WaitOptions {
  /** The wait answers `undefined` once this aborts. */
  readonly signal: AbortSignal;
}

/** `undefined` from the probe means "not yet". A wait with no signal ends only on an answer or a failure. */
export function untilAnswered<T, E>(probe: Effect.Effect<T | undefined, E>, opts: StoppableWaitOptions): Effect.Effect<T | undefined, E>;
export function untilAnswered<T, E>(probe: Effect.Effect<T | undefined, E>, opts: WaitOptions): Effect.Effect<T, E>;
export function untilAnswered<T, E>(
  probe: Effect.Effect<T | undefined, E>,
  opts: WaitOptions & { readonly signal?: AbortSignal },
): Effect.Effect<T | undefined, E> {
  return Effect.gen(function* () {
    for (;;) {
      if (opts.signal?.aborted) return undefined;
      const answer = yield* probe;

      if (answer !== undefined) return answer;
      opts.onWaiting?.();
      yield* Effect.promise(() => abortableSleep(opts.intervalMs, opts.signal, 'resolve'));
    }
  });
}
