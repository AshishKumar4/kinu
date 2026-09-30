import type { ActorReference } from '../identity/actor-handle';
import { Effect } from 'effect';
import { diagnostics, KinuError, settle, toKinuError } from '../obs/index';
import { FallbackRoute, type CallFailure } from '../providers/fallback-route';
import type { ReasoningEffort } from '../providers/effort';
import { describeProviderError, providerRefusalCode, toProviderError } from '../providers/util';
import type { LLM } from '../types/primitives';
import type { ResolvedTurnProfile } from './resolve';
import { resolveModelRoute, type ModelRouteResolution, type ProfileRoutedSource } from './model-route';
import { currentOperationProfile, operationProfileStream, resolveOperationProfile, runOperationProfile } from './operation';
import type { TierRefusals } from './tier-refusals';

export interface RouteCallComponents {
  llm(resolution: ModelRouteResolution): LLM;
  readonly credentialOf?: (spec: string) => Promise<string | null>;
  readonly refusals?: TierRefusals;
}

export interface ModelLaneComponents extends RouteCallComponents {
  resolveProfile(): Promise<ResolvedTurnProfile>;
}

interface ChainEntry {
  readonly spec: string;
  readonly reasoningEffort: ReasoningEffort | null;
}

/** The route's model, then its configured chain, as a turn walks it. */
export async function completeOnRoute(route: ModelRouteResolution, lane: RouteCallComponents, prompt: string): Promise<string> {
  const chain = new FallbackRoute<ChainEntry>({
    modelSpec: route.model,
    fallbacks: route.fallbacks.map((fallback) => ({ spec: fallback.model, reasoningEffort: fallback.reasoningEffort })),
    ...(lane.credentialOf !== undefined && { credentialOf: lane.credentialOf }),
  });

  const cooled = chain.cooledStart();

  if (cooled !== undefined) chain.tried.push(cooled.spec);

  const call = (serving: ChainEntry): Effect.Effect<string, KinuError> => Effect.tryPromise({
    try: () => lane.llm({ ...route, model: serving.spec, reasoningEffort: serving.reasoningEffort }).complete(prompt),
    catch: (cause) => toProviderError({ doing: `calling the ${route.tier} tier`, cause, provider: serving.spec }),
  }).pipe(
    Effect.tap(() => Effect.sync(() => { lane.refusals?.answered(route.tier); })),
    Effect.catch((error) => Effect.gen(function* () {
      const failure: CallFailure = { cause: error.cause, streamed: false, error };
      const next = yield* Effect.promise(() => chain.next(serving.spec, failure));

      if (next === undefined) {
        const refused = providerRefusalCode({ cause: error });

        if (refused === 'denied' || refused === 'budget') lane.refusals?.refused({ tier: route.tier, model: route.model, cause: error.cause });

        const exhausted = chain.exhausted(failure);

        return yield* Effect.fail(exhausted instanceof KinuError
          ? exhausted
          : toKinuError({ doing: `calling the ${route.tier} tier`, cause: exhausted, otherwise: 'unavailable' }));
      }

      diagnostics.event('llm_call.fallback', { source: route.source, from: serving.spec, to: next.spec, reason: describeProviderError({ cause: error.cause }) });
      chain.tried.push(next.spec);

      return yield* call(next);
    })),
  );

  return await settle(call(cooled ?? { spec: route.model, reasoningEffort: route.reasoningEffort }));
}

export function createRoutedModelLane(actor: ActorReference, source: ProfileRoutedSource, binding: ModelLaneComponents): LLM {
  return {
    async complete(prompt) {
      const context = await resolveOperationProfile({ actor, resolve: () => binding.resolveProfile() });

      return runOperationProfile(context, () => completeOnRoute(resolveModelRoute(source, context.profile), binding, prompt));
    },
    stream(options) {
      // Capture the caller's scope now; a generator body first runs in the consumer's next().
      const issued = currentOperationProfile(actor);

      return operationProfileStream((async function* () {
        const context = await resolveOperationProfile({ actor, resolve: () => binding.resolveProfile() });
        const events = runOperationProfile(context, () => binding.llm(resolveModelRoute(source, context.profile)).stream(options));
        yield* operationProfileStream(events, context);
      })(), issued);
    },
  };
}
