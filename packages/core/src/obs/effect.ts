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

/** {@link attempt} for a callee whose refusal is already worded for its reader: its message is kept, not replaced. */
export function attemptInItsWords<A>(otherwise: ErrorCode, run: () => PromiseLike<A>): Effect.Effect<A, KinuError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => (cause instanceof KinuError ? cause : new KinuError(classifyErrorCode({ cause }) ?? otherwise, renderThrownChain({ cause }), { cause })),
  });
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

/** One run per key until it settles; a failure frees the key. */
export function sharedBy<I, A>(keyOf: (input: I) => string | number | null, run: (input: I) => Effect.Effect<A, KinuError | VfsError>): (input: I) => Promise<A> {
  const pending = new Map<string | number | null, Promise<A>>();

  return (input) => {
    const key = keyOf(input);
    const held = pending.get(key);

    if (held !== undefined) return held;
    let started: Promise<A> | undefined;
    // A run can fail before `settle` returns; it is then never held.
    let holding = true;

    started = settle(Effect.onError(run(input), () => Effect.sync(() => {
      if (started === undefined) holding = false;
      else if (pending.get(key) === started) pending.delete(key);
    })));

    if (holding) pending.set(key, started);

    return started;
  };
}

export function shared<A>(run: () => Effect.Effect<A, KinuError | VfsError>): () => Promise<A> {
  return sharedBy<void, A>(() => null, run);
}

/** One run at a time. */
export function deduped<A>(run: () => Effect.Effect<A, KinuError | VfsError>): () => Promise<A> {
  let running: Promise<A> | undefined;

  return () => {
    if (running !== undefined) return running;
    let started: Promise<A> | undefined;
    let live = true;

    started = settle(Effect.ensuring(run(), Effect.sync(() => {
      if (started === undefined) live = false;
      else if (running === started) running = undefined;
    })));

    if (live) running = started;

    return started;
  };
}
