import type { ActorReference } from '../identity/actor-handle';
import type { LLM } from '../types/primitives';
import type { ResolvedTurnProfile } from './resolve';
import { resolveModelRoute, type ModelRouteResolution, type ProfileRoutedSource } from './model-route';
import { currentOperationProfile, operationProfileStream, resolveOperationProfile, runOperationProfile } from './operation';

export interface ModelLaneComponents {
  resolveProfile(): Promise<ResolvedTurnProfile>;
  llm(resolution: ModelRouteResolution): LLM;
}

export function createRoutedModelLane(actor: ActorReference, source: ProfileRoutedSource, binding: ModelLaneComponents): LLM {
  return {
    async complete(prompt) {
      const context = await resolveOperationProfile({ actor, resolve: () => binding.resolveProfile() });

      return runOperationProfile(context, () => binding.llm(resolveModelRoute(source, context.profile)).complete(prompt));
    },
    stream(options) {
      // The issuer is whoever CALLS stream(): an async generator body would
      // not see this scope until the first next(), which is the consumer's.
      const issued = currentOperationProfile(actor);

      return operationProfileStream((async function* () {
        const context = await resolveOperationProfile({ actor, resolve: () => binding.resolveProfile() });
        const events = runOperationProfile(context, () => binding.llm(resolveModelRoute(source, context.profile)).stream(options));
        yield* operationProfileStream(events, context);
      })(), issued);
    },
  };
}
