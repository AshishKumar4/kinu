import type { LanguageModel } from 'ai';
import type { ActorReference } from '../identity/actor-handle';
import { Effect } from 'effect';
import { diagnostics, KinuError, settle, toKinuError } from '../obs/index';
import { accountOf, MAIN_ACCOUNT } from '../credentials/accounts';
import { credentialOrUnknown, FallbackRoute, type CallFailure } from '../providers/fallback-route';
import { reasoningEffortOptions, type ProviderOptions, type ReasoningEffort } from '../providers/effort';
import { generateReported, type GenerateRequest } from '../providers/model-invocation';
import type { ModelCallSpend } from '../events/model-call';
import { PROVIDER_RETRIES_HEADER } from '../providers/rate-limit-retry';
import { formatModelSpec, parseModelSpec } from '../providers/types';
import { describeProviderError, OWNER_FIXABLE_REFUSALS, providerRefusalCode, toProviderError } from '../providers/util';
import type { LLM } from '../types/primitives';
import type { ResolvedTurnProfile } from './resolve';
import { resolveModelRoute, type ModelRouteResolution, type ProfileRoutedSource } from './model-route';
import { currentOperationProfile, operationProfileStream, resolveOperationProfile, runOperationProfile } from './operation';
import type { TierRefusal, TierRefusals } from '../types/refusals';

/** What a route walk reads besides the route: which credential pays a spec, and where owner-fixable refusals are said. */
export interface RouteWalk {
  readonly credentialOf?: (spec: string) => Promise<string | null>;
  readonly refusals?: TierRefusals;
}

export interface RouteCallComponents extends RouteWalk {
  llm(resolution: ModelRouteResolution): LLM;
}

/** A backend's whole say in a routed call: the client and effort options for one (spec, effort), the spec normalised against its registry. */
export interface RouteModelBinding {
  readonly model: LanguageModel;
  readonly providerOptions?: ProviderOptions;
}

export type RouteModelBinder = (route: ModelRouteResolution) => RouteModelBinding;

/** A registry's binding: the effort options are the provider's the spec names once normalised. */
export function bindRoute(
  registry: { normalize(spec: string): string; resolve(spec: string): LanguageModel },
  route: Pick<ModelRouteResolution, 'model' | 'reasoningEffort'>,
): RouteModelBinding {
  const spec = registry.normalize(route.model);
  const model = registry.resolve(spec);
  const providerOptions = reasoningEffortOptions(route.reasoningEffort, parseModelSpec(spec).provider);

  return providerOptions === undefined ? { model } : { model, providerOptions };
}

export interface ModelLaneComponents extends RouteCallComponents {
  resolveProfile(): Promise<ResolvedTurnProfile>;
}

interface ChainEntry {
  readonly spec: string;
  readonly reasoningEffort: ReasoningEffort | null;
}

function asCalled(spec: string, credentialOf: RouteCallComponents['credentialOf']): Effect.Effect<string> {
  const parsed = parseModelSpec(spec);

  if (credentialOf === undefined || parsed.account !== undefined) return Effect.succeed(spec);

  return credentialOrUnknown(credentialOf, spec).pipe(Effect.map((key) => {
    const account = key === null ? MAIN_ACCOUNT : accountOf(key);

    return account === MAIN_ACCOUNT ? spec : formatModelSpec({ ...parsed, account });
  }));
}

/** The route's retry allowance, at the SDK and at the transport. */
export function routeRetryOptions(call: Pick<ModelRouteResolution, 'retries'>) {
  return { maxRetries: call.retries, headers: { [PROVIDER_RETRIES_HEADER]: String(call.retries) } };
}

export function routedCallOptions(call: Pick<ModelRouteResolution, 'reasoningEffort' | 'retries'>, spec: string) {
  const providerOptions = reasoningEffortOptions(call.reasoningEffort, parseModelSpec(spec).provider);

  return { ...routeRetryOptions(call), ...(providerOptions !== undefined && { providerOptions }) };
}

/** One routed call as an {@link LLM}, billed under the route's source once it completes. */
export function routedLlm(bind: RouteModelBinder, route: ModelRouteResolution, spend: Omit<ModelCallSpend, 'source'>, system?: string): LLM {
  return {
    async *stream() { yield ''; },
    async complete(prompt) {
      const { model, providerOptions } = bind(route);
      const request: GenerateRequest = { model, prompt, ...routeRetryOptions(route) };

      if (providerOptions !== undefined) request.providerOptions = providerOptions;

      if (system !== undefined) request.system = system;

      return (await generateReported(request, { spend: { ...spend, source: route.source }, spec: route.model })).text.trim();
    },
  };
}

export function completeOnRoute(route: ModelRouteResolution, lane: RouteCallComponents, prompt: string): Promise<string> {
  return onRoute(route, lane, (serving) => lane.llm(serving).complete(prompt));
}

/** The route's model, then its configured chain, as a turn walks it; `invoke` is one call on the serving entry. */
export async function onRoute<T>(route: ModelRouteResolution, lane: RouteWalk, invoke: (serving: ModelRouteResolution) => Promise<T>): Promise<T> {
  const chain = new FallbackRoute<ChainEntry>({
    modelSpec: route.model,
    fallbacks: route.fallbacks.map((fallback) => ({ spec: fallback.model, reasoningEffort: fallback.reasoningEffort })),
    retries: route.retries,
    ...(lane.credentialOf !== undefined && { credentialOf: lane.credentialOf }),
  });

  const cooled = chain.cooledStart();

  if (cooled !== undefined) chain.tried.push(cooled.spec);

  const refused: { readonly spec: string; readonly cause: unknown }[] = [];
  const notices = lane.refusals;
  const since = notices?.changes() ?? 0;

  const call = (serving: ChainEntry): Effect.Effect<T, KinuError> => Effect.tryPromise({
    try: () => invoke({ ...route, model: serving.spec, reasoningEffort: serving.reasoningEffort, retries: chain.callRetries }),
    catch: (cause) => toProviderError({ doing: `calling the ${route.tier} tier`, cause, provider: serving.spec }),
  }).pipe(
    Effect.tap(() => Effect.sync(() => { lane.refusals?.answered(route.tier); })),
    Effect.catch((error) => Effect.gen(function* () {
      const failure: CallFailure = { cause: error.cause, streamed: false, error };
      const code = providerRefusalCode({ cause: error });
      const ownerMustFix = code !== null && OWNER_FIXABLE_REFUSALS.has(code);

      if (ownerMustFix) refused.push({ spec: serving.spec, cause: error.cause });

      const next = yield* Effect.promise(() => chain.next(serving.spec, failure));

      if (next === undefined) {
        if (ownerMustFix && notices !== undefined) {
          const refusals: TierRefusal[] = yield* Effect.all(refused.map(({ spec, cause }) => asCalled(spec, lane.credentialOf).pipe(
            Effect.map((model) => ({ model, cause })),
          )));

          notices.refused({ tier: route.tier, since, refusals });
        }

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
