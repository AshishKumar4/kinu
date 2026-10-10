import type { LanguageModel } from 'ai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Cause } from 'effect';
import type { KinuError } from '../obs/error';

/** One resolved attempt: pacing shares its billed route; parking also names the model. */
export interface ModelAttemptIdentity {
  readonly lane: string;
  readonly modelId: string;
  /** The stored login and its snapshot, without secret material; aliases resolve to the same identity. */
  readonly credential: string | null;
  readonly ref: string | null;
}

export function attemptKey(identity: ModelAttemptIdentity): string {
  return `${identity.lane}|${JSON.stringify(identity.modelId)}`;
}

/** One SDK invocation owns the identity returned by its inference credential resolver, including renewal. */
export interface AttemptIdentityCapture { identity: ModelAttemptIdentity | null }

const current = new AsyncLocalStorage<AttemptIdentityCapture>();

const failures = new WeakMap<Error, ModelAttemptIdentity>();

export function withAttemptIdentity<T>(capture: AttemptIdentityCapture, run: () => T): T {
  return current.run(capture, run);
}

export async function captureModelAttempt(resolve: () => Promise<ModelAttemptIdentity>): Promise<void> {
  const capture = current.getStore();

  if (capture !== undefined) capture.identity = await resolve();
}

export function recordAttemptFailure(capture: AttemptIdentityCapture, cause: Cause.Cause<KinuError>): void {
  const failure = Cause.squash(cause);

  if (failure instanceof Error && capture.identity !== null) failures.set(failure, capture.identity);
}

export function failedModelAttempt(failure: Error): ModelAttemptIdentity | null {
  for (let error = failure; ; ) {
    const identity = failures.get(error);

    if (identity !== undefined) return identity;

    if (!(error.cause instanceof Error) || error.cause === error) return null;
    error = error.cause;
  }
}

const attempts = new WeakMap<object, () => Promise<ModelAttemptIdentity>>();

const directModels = new WeakMap<object, ModelAttemptIdentity>();

/** Registry models expose the exact lookup their retry middleware uses, not an independently guessed spec key. */
export function bindModelAttempt(model: LanguageModel, lookup: () => Promise<ModelAttemptIdentity>): LanguageModel {
  // SDK-global string ids have no object owner; their route supplies the explicit attempt lookup instead.
  if (typeof model !== 'string') attempts.set(model, lookup);

  return model;
}

/** A directly supplied SDK model has no Kinu credential resolver; its own instance is the attempt owner. */
export async function modelAttempt(model: LanguageModel): Promise<ModelAttemptIdentity> {
  if (typeof model === 'string') return { lane: `sdk:${model}`, modelId: model, credential: null, ref: null };

  const lookup = attempts.get(model);

  if (lookup !== undefined) return await lookup();

  const existing = directModels.get(model);

  if (existing !== undefined) return existing;

  const identity = { lane: `direct:${crypto.randomUUID()}`, modelId: model.modelId, credential: null, ref: null };

  directModels.set(model, identity);

  return identity;
}
