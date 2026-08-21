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
 */

import {
  generateJson,
  MergeOutputSchema,
  type HeadGrounding,
  type HeadRuntime,
  type MergeOutput,
  type ModelCallSink,
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
  /** The spec the merge synthesis runs on: the actor's stored model at the root,
   *  the parent head's in a recursive split. */
  readonly mergeModelSpec: () => string | null;
  /** Where the merge call's cost is filed. */
  readonly reportModelCall: ModelCallSink;
  /** Omit ⇒ n=1 merge and empty head scores (`HeadRuntime.grounding`). */
  readonly grounding?: HeadGrounding;
}

export function createHeadRuntime(deps: HeadRuntimeDeps): HeadRuntime {
  const runtime: HeadRuntime = {
    spawnHead: async (input) => spawnHeadFacet(deps.host, input, await deps.identity()),
    mergeLLM: async (prompt) => {
      const { model, providerOptions } = deps.models.resolveModelWithEffort(deps.mergeModelSpec(), 'low');
      const options: Parameters<typeof generateJson<MergeOutput>>[0] = {
        model,
        schema: MergeOutputSchema,
        prompt,
        spend: { source: 'judge', report: deps.reportModelCall },
      };
      if (providerOptions) options.providerOptions = providerOptions;
      return generateJson(options);
    },
  };
  if (deps.grounding) runtime.grounding = deps.grounding;
  return runtime;
}
