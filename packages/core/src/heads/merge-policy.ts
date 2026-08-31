/**
 * What model merges a set of heads, how hard it is run, and whose spend it is —
 * one policy, both backends.
 *
 * The three facts move together or not at all. `MODEL_ROUTE_POLICY.judge` is the
 * account-wide `deep` tier, a tier is a (model, effort) PAIR, and the merge files
 * its cost as `judge`; so the route, the effort and the spend label are three
 * readings of one decision, and any seam that lets a caller supply one of them
 * separately is a seam where they can disagree.
 *
 * THEY DID DISAGREE, and only one backend was right. The Cloudflare merge
 * resolved `judge` off the turn profile and ran at the tier's own effort; the
 * local merge passed the SESSION'S CHAT MODEL at a hardcoded `'low'`, hand-rolled
 * the JSON extraction, and filed the result as `judge` anyway. So the same split,
 * on the same account, was synthesised by the deep tier in the cloud and by
 * whatever `/model` happened to be set to on a laptop — both reported as
 * deep-tier grading, which is worse than either behaviour on its own, because the
 * ledger could not tell them apart.
 *
 * WHAT STAYS WITH THE BACKEND is exactly one thing: turning a routed
 * (spec, effort) pair into a client it can call. That genuinely differs —
 * Cloudflare normalises the spec through the owner's provider registry before
 * deriving provider options, the CLI resolves it through the local model
 * resolver — and it is the only parameter {@link HeadMergeModelBinder} exists
 * for. Everything above it is here.
 */

import type { LanguageModel } from 'ai';
import type { ProviderOptions } from '../strategy/effort';
import { generateJson } from '../prompts/structured';
import { resolveModelRoute, type ModelRouteResolution } from '../profiles/model-route';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import type { ModelCallSink, ModelOperationSink } from '../events/model-call';
import { MergeOutputSchema, type MergeOutput } from './merge-schema';
import type { MergeLLMFn } from './controller';

/**
 * The producer the merge IS, named once.
 *
 * One literal feeds both the route lookup and the spend label, so the model a
 * merge runs on and the label its cost is filed under cannot drift apart: they
 * are the same string read twice.
 */
const HEAD_MERGE_SOURCE = 'judge';

/** A model this backend can call, and the provider options its tier's effort
 *  asks for. Absent options mean this provider family has no reasoning knob. */
export interface HeadMergeModelBinding {
  readonly model: LanguageModel;
  readonly providerOptions?: ProviderOptions;
}

/**
 * How a backend turns the ROUTED decision into a client.
 *
 * Takes the whole resolution rather than a spec, so the effort cannot be
 * supplied from anywhere else: a binder that wanted to run the merge harder or
 * cheaper than its tier says would have to ignore an argument it was handed
 * rather than simply omit one it was never given.
 */
export type HeadMergeModelBinder = (route: ModelRouteResolution) => HeadMergeModelBinding;

export interface HeadMergePolicyDeps {
  /** The profile the `judge` route resolves against. A THUNK, asked again per
   *  merge, so an account that moves its deep tier does not need a new runtime
   *  for the change to take effect. */
  readonly profile: () => Promise<ResolvedTurnProfile>;
  /** This backend's only say in the matter. */
  readonly bindMergeModel: HeadMergeModelBinder;
  /**
   * Where the merge's cost is filed. REQUIRED, not optional, because this call
   * is counted nowhere else: `summarizeCost` folds the HEADS' reports, and
   * `head_merge_results.cost_total_tokens` sums the heads too, so an unreported
   * merge is spend that no total on either backend ever sees.
   */
  readonly reportModelCall: ModelCallSink;
  /** Where the merge's operation lifecycle — its start/end rows — is filed.
   *  Rides beside the cost sink rather than being wired separately, so a caller
   *  cannot report a cost for an operation it never opened. */
  readonly operations?: ModelOperationSink;
}

/**
 * The merge's model, as the immutable turn profile resolves it.
 *
 * Throws rather than answering null: `judge` is a `fixed`-tier producer, so
 * {@link resolveModelRoute}'s platform branch is unreachable here and a caller
 * given null would have no second policy to fall back on.
 *
 * Private, because {@link headMergeLLM} is the whole seam. Exporting the route
 * lookup would let a backend resolve the route and then bind something else —
 * which is precisely the shape of the drift this module exists to remove.
 */
function resolveHeadMergeRoute(profile: ResolvedTurnProfile): ModelRouteResolution {
  const route = resolveModelRoute(HEAD_MERGE_SOURCE, profile);
  if (!route) throw new Error('the head merge cannot use the fixed platform model route');
  return route;
}

/**
 * The merge call itself: routed model, the tier's own effort, `judge` spend,
 * structured output enforced by the one schema the controller validates against.
 *
 * `generateJson` is the substrate on purpose — the same one the scaffold judge
 * and the GEPA metric ride — so the JSON-only instruction, the
 * report-before-parse ordering and the operation frame around a call that never
 * returns are one implementation rather than a shape each backend re-derives.
 * The local merge used to re-derive them and got the frame right and the
 * instruction missing.
 */
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
