import { Cause, Data, Effect, Exit, Fiber, Scheduler } from 'effect';
import * as v from 'valibot';

export const DevboxErrorCode = v.picklist([
  'io', 'configuration', 'invalid-input', 'not-ready', 'cancelled', 'missing',
  'file', 'process', 'start-overrun', 'start-interrupted', 'chain-advanced', 'mount-marker', 'refused', 'indeterminate',
]);

export type DevboxErrorCode = v.InferOutput<typeof DevboxErrorCode>;

interface FailureOptions extends ErrorOptions {
  readonly expectedRev?: number | null;
  readonly storedRev?: number | null;
}

/** The library's failure contract; its own code and cause survive Worker RPC. */
export class DevboxError extends Data.TaggedError('DevboxError')<{
  readonly code: DevboxErrorCode;
  readonly message: string;
  readonly expectedRev?: number | null;
  readonly storedRev?: number | null;
}> {
  constructor(code: DevboxErrorCode, message: string, options?: FailureOptions) {
    super(options?.expectedRev === undefined ? { code, message } : { code, message, expectedRev: options.expectedRev, storedRev: options.storedRev });
    this.name = `DevboxError[${code}]`;

    if (options !== undefined && 'cause' in options) Object.defineProperty(this, 'cause', { value: options.cause, writable: true, configurable: true });
  }

}

const Failure = v.object({
  _tag: v.literal('DevboxError'), code: DevboxErrorCode, message: v.string(),
  expectedRev: v.optional(v.nullable(v.number())), storedRev: v.optional(v.nullable(v.number())),
});

export type DevboxFailure = v.InferOutput<typeof Failure>;

/** The thrown value read as this library's failure: its own instance, or the copy Worker RPC delivers. */
export function devboxFailure(thrown: { readonly cause: unknown }): DevboxFailure | undefined {
  const read = v.safeParse(Failure, thrown.cause);

  return read.success ? read.output : undefined;
}

const withinOneEvent = new Scheduler.MixedScheduler('sync');

function failure(code: DevboxErrorCode, thrown: { readonly cause: unknown }, doing?: string): DevboxError {
  const { cause } = thrown;

  if (cause instanceof DevboxError) return cause;
  const copy = devboxFailure(thrown);

  if (copy !== undefined) return new DevboxError(copy.code, copy.message, { cause, expectedRev: copy.expectedRev, storedRev: copy.storedRev });
  const detail = cause instanceof Error ? cause.message : String(cause);

  return new DevboxError(cause instanceof Error && cause.name === 'AbortError' ? 'cancelled' : code, doing === undefined ? detail : `${doing}: ${detail}`, { cause });
}

export function attempt<A>(code: DevboxErrorCode, run: (signal: AbortSignal) => PromiseLike<A>, doing?: string): Effect.Effect<A, DevboxError> {
  return Effect.tryPromise({ try: run, catch: cause => failure(code, { cause }, doing) });
}

/** `effect` with what it did not own answered as `attempt` answers a throw: a rejection it awaited (`Effect.promise` keeps
 *  one as a defect) fails in `code`, in the thrower's words; a DevboxError it failed with, or threw, passes unchanged. */
export function attempted<A>(code: DevboxErrorCode, effect: Effect.Effect<A, DevboxError>, doing?: string): Effect.Effect<A, DevboxError> {
  return Effect.catchCause(effect, (cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(failure(code, { cause: Cause.squash(cause) }, doing))));
}

export function attemptSync<A>(code: DevboxErrorCode, run: () => A, doing?: string): Effect.Effect<A, DevboxError> {
  return Effect.try({ try: run, catch: cause => failure(code, { cause }, doing) });
}

/** The file adapter may return its platform errno error; every owned failure is DevboxError. */
function reject<E extends Error>(cause: Cause.Cause<E>, signal?: AbortSignal): never {
  if (!Cause.hasInterruptsOnly(cause)) throw Cause.squash(cause);
  throw new DevboxError('cancelled', 'devbox operation cancelled', { cause: signal?.reason });
}

/** A failure carried as it was thrown, for a holder that reports it, or hands it on, in the thrower's own words. */
class Caught extends Data.TaggedError('Caught')<{ readonly thrown: unknown }> {}

/** Promise work's value, or what it threw, as thrown: for the holders that log, report or record a failure and go on. */
export async function caught<A>(run: () => PromiseLike<A>): Promise<{ readonly value: A } | { readonly cause: unknown }> {
  const exit = await hold(Effect.tryPromise({ try: run, catch: (thrown) => new Caught({ thrown }) }));

  if (Exit.isSuccess(exit)) return { value: exit.value };
  const failed = Cause.squash(exit.cause);

  return { cause: failed instanceof Caught ? failed.thrown : failed };
}

/** Promise work nobody awaits: what it threw, as thrown, goes to `lost`. */
export function whenLost(work: PromiseLike<unknown>, lost: (thrown: { readonly cause: unknown }) => void): void {
  Effect.runCallback(Effect.tryPromise({ try: async () => work, catch: (thrown) => new Caught({ thrown }) }), { scheduler: withinOneEvent, onExit(exit) {
    if (Exit.isSuccess(exit)) return;
    const failed = Cause.squash(exit.cause);

    lost({ cause: failed instanceof Caught ? failed.thrown : failed });
  } });
}

/** A run whose exit is stored and read where it is used: it never rejects, and its holder decides what the exit means. */
export function hold<A, E extends Error>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return settle(Effect.exit(effect));
}

export async function settle<A, E extends Error>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal }): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { scheduler: withinOneEvent, signal: options?.signal });

  if (Exit.isSuccess(exit)) return exit.value;

  return reject(exit.cause, options?.signal);
}

export function settleSync<A, E extends Error>(effect: Effect.Effect<A, E>): A {
  const exit = Effect.runSyncExit(effect);

  if (Exit.isSuccess(exit)) return exit.value;
  const defect = Cause.squash(exit.cause);

  if (Cause.isAsyncFiberError(defect)) Effect.runFork(Fiber.interrupt(defect.fiber));

  return reject(exit.cause);
}

/** A native clock or socket owns the returned cancellation for its asynchronous lifetime. */
export function observe<A>(program: Effect.Effect<A, DevboxError>, observer: { readonly success: (value: A) => void; readonly failure: (cause: DevboxError) => void }): () => void {
  return Effect.runCallback(program, { scheduler: withinOneEvent, onExit(exit) {
    if (Exit.isSuccess(exit)) observer.success(exit.value);
    else if (!Cause.hasInterruptsOnly(exit.cause)) observer.failure(failure('io', { cause: Cause.squash(exit.cause) }));
  } });
}

export function startOverrun(label: string, budgetMs: number): DevboxError {
  return new DevboxError('start-overrun', `${label} exceeded its ${budgetMs}ms budget and was abandoned; the work it left running inside the container cannot be fenced from here.`);
}

export function startInterrupted(): DevboxError {
  return new DevboxError('start-interrupted', 'the previous restoration was interrupted before settlement; its container work may still be running');
}

export function chainAdvanced(expectedRev: number | null, storedRev: number | null): DevboxError {
  return new DevboxError('chain-advanced', `another writer advanced the chain record to rev ${storedRev ?? 'none'} after this one read rev ${expectedRev ?? 'none'}`, { expectedRev, storedRev });
}
