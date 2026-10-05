/**
 * What model merges a set of heads, at what effort, and whose spend it is: one policy for both backends.
 * The route, effort and `judge` spend label are one decision, walked down the deep tier's chain like
 * every fixed-tier call; the backend only binds a routed (spec, effort) pair to a client.
 */

import { Effect } from 'effect';
import { settle } from '../obs/effect';
import * as v from 'valibot';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../providers/structured';
import { generateReported, type GenerateRequest } from '../providers/model-invocation';
import { resolveModelRoute, type ModelRouteResolution } from '../profiles/model-route';
import { onRoute, routeRetryOptions, type RouteModelBinder } from '../profiles/model-lane';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import type { ModelCallSink, ModelOperationSink } from '../events/model-call';
import { MergeOutputSchema } from './merge-schema';
import type { MergeLLMFn } from './controller';

/** One literal feeds both the route lookup and the spend label, so they cannot drift apart. */
const HEAD_MERGE_SOURCE = 'judge';

export interface HeadMergePolicyDeps {
  /** A thunk, asked per merge, so a moved deep tier takes effect without a new runtime. */
  readonly profile: () => Promise<ResolvedTurnProfile>;
  readonly bindMergeModel: RouteModelBinder;
  /** Required: merge spend is counted nowhere else (`summarizeCost` sums only heads). */
  readonly reportModelCall: ModelCallSink;
  /** Rides beside the cost sink so a cost cannot be reported for an unopened operation. */
  readonly operations?: ModelOperationSink;
}

/** Throws rather than answering null: `judge` is a `fixed`-tier producer. Private so no backend can resolve the route and bind something else. */
function resolveHeadMergeRoute(profile: ResolvedTurnProfile): Effect.Effect<ModelRouteResolution> {
  return Effect.gen(function* () {
    const route = resolveModelRoute(HEAD_MERGE_SOURCE, profile);

    if (!route) return yield* Effect.die(new Error('the head merge cannot use the fixed platform model route'));

    return route;
  });
}

/** Billed as the serving entry before its reply is parsed: a reply that fails the schema was paid for, and is no refusal to hand over on. */
export function headMergeLLM(deps: HeadMergePolicyDeps): MergeLLMFn {
  return (prompt) => settle(Effect.gen(function* () {
    const profile = yield* Effect.promise(() => deps.profile());
    const route = yield* resolveHeadMergeRoute(profile);

    const text = yield* Effect.promise(() => onRoute(route, {}, async (serving) => {
      const { model, providerOptions } = deps.bindMergeModel(serving);
      const request: GenerateRequest = { model, prompt: `${prompt}\n\n${jsonObjectOnlyInstruction()}`, ...routeRetryOptions(serving) };

      if (providerOptions !== undefined) request.providerOptions = providerOptions;
      const spend = { source: HEAD_MERGE_SOURCE, report: deps.reportModelCall, operations: deps.operations } as const;

      return (await generateReported(request, { spend, spec: serving.model }, 'generate_json')).text;
    }));

    return v.parse(MergeOutputSchema, extractJsonObject(text));
  }));
}
