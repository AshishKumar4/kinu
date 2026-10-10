import type { LanguageModel } from 'ai';

/** One resolved attempt: pacing shares its billed route; parking also names the model. */
export interface ModelAttemptIdentity {
  readonly lane: string;
  readonly modelId: string;
  /** The stored login and its snapshot, without secret material; aliases resolve to the same identity. */
  readonly credential: string | null;
  readonly ref: string | null;
}

export function attemptKey(identity: ModelAttemptIdentity): string {
  return JSON.stringify([identity.lane, identity.modelId]);
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
