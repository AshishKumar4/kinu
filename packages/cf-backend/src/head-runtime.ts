/**
 * The one `HeadRuntime`. Merge model, effort and spend label are owned by core's `headMergeLLM`;
 * `reportModelCall` is the only record of a merge's cost (`head_merge_results` sums the heads).
 */

import {
  headMergeLLM,
  type HeadGrounding,
  type HeadRuntime,
  type ModelCallSink,
  type ModelOperationSink,
  type ResolvedTurnProfile,
} from "@kinu.run/core";
import { hostHead, type ExplorationHostSeams } from "./exploration-hosting";
import type { OwnedModelServices } from "./owned-model-services";

interface HeadRuntimeDeps {
  /** The workspace's one actor host. Children read owner, token and workspace from the seams, so an
     *  intermediate head can never become its subtree's workspace. */
  readonly host: ExplorationHostSeams;
  /** Never a second registry. */
  readonly models: Pick<OwnedModelServices, 'resolveModelWithEffort'>;
  /** A profile, not a spec: the merge files spend as `judge` (deep tier), which the caller's chat model
     *  cannot stand behind. */
  readonly profile: () => Promise<ResolvedTurnProfile>;
  readonly reportModelCall: ModelCallSink;
  /** Rides beside the cost sink so a cost is never reported for an operation never opened. */
  readonly operations?: ModelOperationSink;
  /** Omit ⇒ n=1 merge and empty head scores (`HeadRuntime.grounding`). */
  readonly grounding?: HeadGrounding;
}

export function createHeadRuntime(deps: HeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    spawnHead: (input) => hostHead(deps.host, input),
    mergeLLM: headMergeLLM({
      profile: deps.profile,
      // Specs are normalised against the owner's provider registry, so core hands the route over.
      bindMergeModel: (route) => deps.models.resolveModelWithEffort(
        route.model, route.reasoningEffort,
      ),
      reportModelCall: deps.reportModelCall,
      operations: deps.operations,
    }),
  };

  if (deps.grounding) runtime.grounding = deps.grounding;

  return runtime;
}
