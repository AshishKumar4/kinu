import { Cause, Effect, Exit, Scheduler } from 'effect';
import { KinuError, toKinuError, type ErrorCode, type Refusal } from './error';

const WITHIN_ONE_EVENT = new Scheduler.MixedScheduler('sync');

export type Wire<T, F = Refusal> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: F };

export function attempt<A>(
  input: { readonly doing: string; readonly otherwise: ErrorCode },
  run: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, KinuError> {
  return Effect.tryPromise({ try: run, catch: (cause) => toKinuError({ ...input, cause }) });
}

interface SettleOptions {
  readonly signal?: AbortSignal;
  readonly interrupted?: string;
}

function fail(cause: Cause.Cause<KinuError>, options?: SettleOptions): never {
  if (!Cause.hasInterruptsOnly(cause)) throw Cause.squash(cause);

  const signal = options?.signal;

  throw new KinuError(
    'cancelled',
    options?.interrupted ?? 'interrupted',
    signal?.aborted === true ? { cause: signal.reason } : undefined,
  );
}

export async function settle<A>(effect: Effect.Effect<A, KinuError>, options?: SettleOptions): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { scheduler: WITHIN_ONE_EVENT, signal: options?.signal });

  if (Exit.isSuccess(exit)) return exit.value;

  return fail(exit.cause, options);
}

export function settleSync<A>(effect: Effect.Effect<A, KinuError>, options?: Pick<SettleOptions, 'interrupted'>): A {
  const exit = Effect.runSyncExit(effect);

  if (Exit.isSuccess(exit)) return exit.value;

  return fail(exit.cause, options);
}

export function toWire<A, F>(
  effect: Effect.Effect<A, KinuError>,
  encode: (failure: KinuError) => F,
): Effect.Effect<Wire<A, F>> {
  return Effect.match(effect, {
    onSuccess: (value): Wire<A, F> => ({ ok: true, value }),
    onFailure: (failure): Wire<A, F> => ({ ok: false, error: encode(failure) }),
  });
}
