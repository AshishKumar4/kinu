/**
 * What model merges a set of heads, at what effort, and whose spend it is: one policy for both backends.
 * The route, effort and `judge` spend label are one decision; the backend only binds a routed
 * (spec, effort) pair to a client ({@link HeadMergeModelBinder}).
 */

import type { LanguageModel } from 'ai';
import type { ProviderOptions } from '../providers/effort';
import { generateJson } from '../providers/structured';
import { resolveModelRoute, type ModelRouteResolution } from '../profiles/model-route';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import type { ModelCallSink, ModelOperationSink } from '../events/model-call';
import { MergeOutputSchema, type MergeOutput } from './merge-schema';
import type { MergeLLMFn } from './controller';

/** One literal feeds both the route lookup and the spend label, so they cannot drift apart. */
const HEAD_MERGE_SOURCE = 'judge';

/** Absent options mean this provider family has no reasoning knob. */
export interface HeadMergeModelBinding {
  readonly model: LanguageModel;
  readonly providerOptions?: ProviderOptions;
}

/** Takes the whole resolution, so the effort cannot come from anywhere else. */
export type HeadMergeModelBinder = (route: ModelRouteResolution) => HeadMergeModelBinding;

export interface HeadMergePolicyDeps {
  /** A thunk, asked per merge, so a moved deep tier takes effect without a new runtime. */
  readonly profile: () => Promise<ResolvedTurnProfile>;
  readonly bindMergeModel: HeadMergeModelBinder;
  /** Required: merge spend is counted nowhere else (`summarizeCost` and `cost_total_tokens` sum only heads). */
  readonly reportModelCall: ModelCallSink;
  /** Rides beside the cost sink so a cost cannot be reported for an unopened operation. */
  readonly operations?: ModelOperationSink;
}

/** Throws rather than answering null: `judge` is a `fixed`-tier producer. Private so no backend can resolve the route and bind something else. */
function resolveHeadMergeRoute(profile: ResolvedTurnProfile): ModelRouteResolution {
  const route = resolveModelRoute(HEAD_MERGE_SOURCE, profile);

  if (!route) throw new Error('the head merge cannot use the fixed platform model route');

  return route;
}

/** Routed model, the tier's own effort, `judge` spend; `generateJson` keeps the JSON-only instruction, report-before-parse and the operation frame together. */
export function headMergeLLM(deps: HeadMergePolicyDeps): MergeLLMFn {
  return async (prompt) => {
    const { model, providerOptions } = deps.bindMergeModel(
      resolveHeadMergeRoute(await deps.profile()),
    );

    const options: Parameters<typeof generateJson<MergeOutput>>[0] = {
      model,
      schema: MergeOutputSchema,
      prompt,
      spend: {
        source: HEAD_MERGE_SOURCE,
        report: deps.reportModelCall,
        operations: deps.operations,
      },
    };

    if (providerOptions) options.providerOptions = providerOptions;

    return generateJson(options);
  };
}
