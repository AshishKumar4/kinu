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
 * The merge MODEL is not one of those parameters, and used to be. Both call
 * sites passed their own stored chat spec, so a synthesis filed as `judge`
 * spend ran on whatever model the conversation was set to. It resolves through
 * `MODEL_ROUTE_POLICY` now — one route, one effort, both from the profile the
 * caller hands in.
 */

import {
  generateJson,
  MergeOutputSchema,
  resolveModelRoute,
  type HeadGrounding,
  type HeadRuntime,
  type MergeOutput,
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
   *  registry — that was the duplication. */
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
   *  filed. Rides `spend` beside `report`: two facts about ONE call, and a
   *  caller that wired them separately could report a cost for an operation
   *  it never opened. */
  readonly operations?: ModelOperationSink;
  /** Omit ⇒ n=1 merge and empty head scores (`HeadRuntime.grounding`). */
  readonly grounding?: HeadGrounding;
}

export function createHeadRuntime(deps: HeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    spawnHead: async (input) => spawnHeadFacet(deps.host, input, await deps.identity()),
    mergeLLM: async (prompt) => {
      // The `'judge'` literal appears once and feeds BOTH the route and the
      // spend label below, so the model and its attribution cannot drift apart.
      // `reasoningEffort` comes from the resolution too: the tier that chose the
      // model chose how hard to run it, where a constant here was a second
      // decision nobody made.
      const route = resolveModelRoute('judge', await deps.profile());
      if (!route) throw new Error('the head merge cannot use the fixed platform model route');
      const { model, providerOptions } = deps.models.resolveModelWithEffort(
        route.model, route.reasoningEffort,
      );
      const options: Parameters<typeof generateJson<MergeOutput>>[0] = {
        model,
        schema: MergeOutputSchema,
        prompt,
        spend: { source: 'judge', report: deps.reportModelCall, operations: deps.operations },
      };
      if (providerOptions) options.providerOptions = providerOptions;
      return generateJson(options);
    },
  };
  if (deps.grounding) runtime.grounding = deps.grounding;
  return runtime;
}
