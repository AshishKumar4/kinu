import { Cause, Data, Effect, Exit, Fiber, Scheduler } from 'effect';
import * as v from 'valibot';

export const DevboxErrorCode = v.picklist([
  'io', 'configuration', 'invalid-input', 'not-ready', 'cancelled', 'missing',
  'file', 'process', 'start-overrun', 'start-interrupted', 'container-changed',
  'layer-unreadable', 'chain-advanced', 'delta-namespace', 'mount-marker', 'refused', 'indeterminate',
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

export function attemptSync<A>(code: DevboxErrorCode, run: () => A, doing?: string): Effect.Effect<A, DevboxError> {
  return Effect.try({ try: run, catch: cause => failure(code, { cause }, doing) });
}

/** The file adapter may return its platform errno error; every owned failure is DevboxError. */
function reject<E extends Error>(cause: Cause.Cause<E>, signal?: AbortSignal): never {
  if (!Cause.hasInterruptsOnly(cause)) throw Cause.squash(cause);
  throw new DevboxError('cancelled', 'devbox operation cancelled', { cause: signal?.reason });
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

export function containerChanged(): DevboxError {
  return new DevboxError('container-changed', 'the container generation changed while snapshot-chain attached its lower layers');
}

export function layerUnreadable(layer: string, generation: string, thrown: ErrorOptions): DevboxError {
  return new DevboxError('layer-unreadable', `the ${layer} layer of generation ${generation} could not be read`, thrown);
}

export function deltaNamespaceFailed(code: string): DevboxError {
  return new DevboxError('delta-namespace', `opaque-directory namespace could not be observed (probe ${code})`);
}
