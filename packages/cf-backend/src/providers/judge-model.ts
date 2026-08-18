// Cross-family judge selection against a live agent provider registry.
//
// The policy AND the candidate list live in core (`selectJudgeModel`,
// `selectEnsembleJudges`, `availableJudgeSpecs`); this is the adapter that
// points them at the registry the agent already owns.

import {
  availableJudgeSpecs, selectEnsembleJudges, selectJudgeModel,
  type EnsembleJudgeSelection, type JudgeModelSelection,
} from '@proteus/core';
import type { AgentProviderRegistry } from './agent-registry';

const candidatesFor = (registry: AgentProviderRegistry) => (): Promise<string[]> =>
  availableJudgeSpecs(registry.registry, registry.deps);

/**
 * Resolve the model that judges this agent's own output: the operator's
 * `review_model` when set, else a different-vendor model when one is
 * connected, else the chat model (same-model judging — the documented
 * single-vendor fallback). Specs come back normalized and registry-resolvable.
 */
export async function resolveJudgeModelSelection(opts: {
  registry: AgentProviderRegistry;
  reviewSpec: string | null;
  chatSpec: string | null;
}): Promise<JudgeModelSelection> {
  const { registry } = opts;
  const selection = await selectJudgeModel({
    reviewSpec: opts.reviewSpec,
    chatSpec: registry.normalizeSpecSync(opts.chatSpec),
    candidates: candidatesFor(registry),
  });
  return { ...selection, spec: registry.normalizeSpecSync(selection.spec) };
}

/**
 * Resolve the panel that re-judges the owner's calibration set: the judges they
 * named, else one model per connected vendor family other than the chat
 * model's. A short list comes back short — core's `selectEnsembleJudges` has no
 * single-vendor fallback, and the caller says so rather than padding it.
 */
export async function resolveEnsembleJudgeSelection(opts: {
  registry: AgentProviderRegistry;
  specs: ReadonlyArray<string> | null;
  chatSpec: string | null;
}): Promise<EnsembleJudgeSelection> {
  const { registry } = opts;
  const selection = await selectEnsembleJudges({
    specs: opts.specs,
    chatSpec: () => registry.normalizeSpecSync(opts.chatSpec),
    candidates: candidatesFor(registry),
  });
  return { ...selection, specs: selection.specs.map((spec) => registry.normalizeSpecSync(spec)) };
}
