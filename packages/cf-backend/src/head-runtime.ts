/**
 * The one `HeadRuntime` — where a child head comes from, and what model merges
 * the children once they report.
 *
 * There were two of these, and neither difference was policy: the orchestrator's
 * built its own provider registry, config store and effort derivation, while the
 * recursive split inlined a second one over the `OwnedModelServices` the facet
 * already held. The drift was measurable — the root's merge synthesis reported
 * its cost NOWHERE while a facet's reported it to the workspace event log, and
 * the root carried a second `AgentProviderRegistry` for the life of the DO.
 * `head_merge_results.cost_total_tokens` sums the HEADS, not the call that merged
 * them, so `reportModelCall` is the only record of what a merge cost.
 *
 * What genuinely differs is a PARAMETER, visible at each call site: `grounding`,
 * and where the spend is filed (a root writes its own log; a facet's SQLite is one
 * Durable Object away from the total, so it reports over RPC).
 *
 * The merge MODEL, EFFORT and SPEND LABEL are not among those parameters, and
 * they are no longer decided here at all. `headMergeLLM` in core owns them, so
 * this backend and the local one resolve one policy rather than two agreeing by
 * inspection — they did not agree: the local merge ran the session's chat model
 * at a hardcoded effort and filed it as `judge` anyway. All that is left on this
 * side is `bindMergeModel`, which turns the routed (spec, effort) pair into a
 * client through the owner's provider registry, because normalising a spec
 * against that registry is genuinely this backend's job and nothing else here is.
 */

import {
  headMergeLLM,
  type HeadGrounding,
  type HeadRuntime,
  type ModelCallSink,
  type ModelOperationSink,
  type ResolvedTurnProfile,
} from "@kinu.run/core";
import { spawnHeadFacet, type ExplorationFacetIdentity, type FacetHost } from "./facet-spawn";
import type { OwnedModelServices } from "./owned-model-services";

interface HeadRuntimeDeps {
  /** The facet substrate children are spawned on: the workspace DO for a
   *  top-level split, the head itself for a recursive one. */
  readonly host: FacetHost;
  /** Owner, capability token and ROOT workspace every child facet is seeded with.
   *  A thunk, and resolved per spawn: the token is reissued out of band, and the
   *  root must be propagated UNCHANGED so an intermediate head never becomes the
   *  tree's workspace. */
  readonly identity: () => Promise<ExplorationFacetIdentity>;
  /** The owner-scoped model services this actor already owns. Never a second
   *  registry — that was the duplication. The merge's only use of them is
   *  binding the route core resolved. */
  readonly models: Pick<OwnedModelServices, 'resolveModelWithEffort'>;
  /** The profile the merge's `judge` route resolves against.
   *
   *  A profile rather than a spec, because the merge is not free to pick a
   *  model: it files its spend as `judge`, and `MODEL_ROUTE_POLICY.judge` is
   *  the account-wide `deep` tier. This used to be the caller's stored chat
   *  model — the actor's at the root, the parent head's in a recursive split —
   *  so a synthesis reported as deep-tier grading ran on whatever the
   *  conversation happened to be set to. */
  readonly profile: () => Promise<ResolvedTurnProfile>;
  /** Where the merge call's cost is filed. */
  readonly reportModelCall: ModelCallSink;
  /** Where the merge call's operation lifecycle — its start/end rows — is
   *  filed. Rides `spend` beside the cost sink inside the policy: two facts
   *  about ONE call, and a caller that wired them separately could report a
   *  cost for an operation it never opened. */
  readonly operations?: ModelOperationSink;
  /** Omit ⇒ n=1 merge and empty head scores (`HeadRuntime.grounding`). */
  readonly grounding?: HeadGrounding;
}

export function createHeadRuntime(deps: HeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    spawnHead: async (input) => spawnHeadFacet(deps.host, input, await deps.identity()),
    mergeLLM: headMergeLLM({
      profile: deps.profile,
      // The one backend-local decision: a spec is normalised against the
      // OWNER's provider registry before its family decides the provider
      // options, which is why core hands the route over instead of resolving
      // the client itself. Effort included, from the same resolution — the tier
      // that chose the model chose how hard to run it, and a constant here was a
      // second decision nobody made.
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
