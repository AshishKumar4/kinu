import { Cause, Effect, Exit, Fiber, Scheduler } from 'effect';
import type { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { classifyErrorCode, KinuError, renderThrownChain, toKinuError, type ErrorCode } from './error';
import { classify, type ExpectedFailure } from './expected-failure';

const WITHIN_ONE_EVENT = new Scheduler.MixedScheduler('sync');

export function attempt<A>(
  input: { readonly doing: string; readonly otherwise: ErrorCode },
  run: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, KinuError> {
  return Effect.tryPromise({ try: run, catch: (cause) => toKinuError({ ...input, cause }) });
}

const worded = (otherwise: ErrorCode, { cause }: { readonly cause: unknown }): KinuError =>
  (cause instanceof KinuError ? cause : new KinuError(classifyErrorCode({ cause }) ?? otherwise, renderThrownChain({ cause }), { cause }));

/** {@link attempt} for a callee whose refusal is already worded for its reader: its message is kept, not replaced. */
export function attemptInItsWords<A>(otherwise: ErrorCode, run: () => PromiseLike<A>): Effect.Effect<A, KinuError> {
  return Effect.tryPromise({ try: run, catch: (cause) => worded(otherwise, { cause }) });
}

/** {@link attemptInItsWords} for a thrown defect. */
export function inItsWords<A>(otherwise: ErrorCode, effect: Effect.Effect<A>): Effect.Effect<A, KinuError> {
  return Effect.catchDefect(effect, (cause) => Effect.fail(worded(otherwise, { cause })));
}

interface SettleOptions {
  readonly signal?: AbortSignal;
  readonly interrupted?: string;
}

function fail(cause: Cause.Cause<KinuError | VfsError>, options?: SettleOptions): never {
  if (!Cause.hasInterruptsOnly(cause)) throw Cause.squash(cause);

  const signal = options?.signal;

  throw new KinuError(
    'cancelled',
    options?.interrupted ?? 'interrupted',
    signal?.aborted === true ? { cause: signal.reason } : undefined,
  );
}

/** The only runner. Its awaits add hops a plain `await` does not, so a call forwarded when a gate opens stays a promise chain. */
export async function settle<A>(effect: Effect.Effect<A, KinuError | VfsError>, options?: SettleOptions): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { scheduler: WITHIN_ONE_EVENT, signal: options?.signal });

  if (Exit.isSuccess(exit)) return exit.value;

  return fail(exit.cause, options);
}

export function settleSync<A>(effect: Effect.Effect<A, KinuError | VfsError>, options?: Pick<SettleOptions, 'interrupted'>): A {
  const exit = Effect.runSyncExit(effect);

  if (Exit.isSuccess(exit)) return exit.value;
  const defect = Cause.squash(exit.cause);

  if (Cause.isAsyncFiberError(defect)) Effect.runFork(Fiber.interrupt(defect.fiber));

  return fail(exit.cause, options);
}

/** `effect` with the named failure passed as `undefined`. */
export function tolerated<A, E>(effect: Effect.Effect<A, E>, expected: ExpectedFailure): Effect.Effect<A | undefined, E> {
  return Effect.catchCause(effect, (cause) => (classify({ cause: Cause.squash(cause) }) === expected ? Effect.undefined : Effect.failCause(cause)));
}

/**
 * Runs `operation`, returning `undefined` only for the named failure; anything else is rethrown
 * as-is, unwrapped, to keep the failing frame on top.
 */
export function tolerate<T>(operation: () => T, expected: ExpectedFailure): T | undefined {
  return settleSync(tolerated(Effect.sync(operation), expected));
}

/** `tolerate` for an operation that rejects rather than throws. */
export function tolerateAsync<T>(operation: () => Promise<T>, expected: ExpectedFailure): Promise<T | undefined> {
  return settle(tolerated(Effect.promise(operation), expected));
}

interface FlightOptions<I> {
  readonly key?: (input: I) => string | number | null;
  readonly keep?: 'success' | 'exit';
}

/** One run per key, joined by each caller with its exit; settling frees the key unless `keep` holds it. */
export function flight<A, E extends KinuError | VfsError>(run: () => Effect.Effect<A, E>, options?: FlightOptions<void>): () => Effect.Effect<A, E>;
export function flight<I, A, E extends KinuError | VfsError>(run: (input: I) => Effect.Effect<A, E>, options?: FlightOptions<I>): (input: I) => Effect.Effect<A, E>;
export function flight<I, A, E extends KinuError | VfsError>(run: (input: I) => Effect.Effect<A, E>, options?: FlightOptions<I>): (input: I) => Effect.Effect<A, E> {
  const held = new Map<string | number | null, Promise<Exit.Exit<A, E>>>();

  return (input) => Effect.suspend(() => {
    const key = options?.key?.(input) ?? null;
    let exit = held.get(key);

    if (exit === undefined) {
      let live = true;

      const free = Effect.sync(() => {
        if (exit === undefined) live = false;
        else if (held.get(key) === exit) held.delete(key);
      });

      const ran = run(input);
      let kept = Effect.ensuring(ran, free);

      if (options?.keep === 'exit') kept = ran;
      else if (options?.keep === 'success') kept = Effect.onError(ran, () => free);

      exit = settle(Effect.exit(kept));

      if (live) held.set(key, exit);
    }

    const settled = exit;

    return Effect.flatten(Effect.promise(() => settled));
  });
}
