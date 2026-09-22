// Cross-family judge selection: policy and candidates live in core; this adapter points them at the agent's registry.

import {
  availableJudgeSpecs, selectEnsembleJudges, selectJudgeModel,
  type EnsembleJudgeSelection, type JudgeModelSelection,
} from '@kinu.run/core';
import type { AgentProviderRegistry } from './agent-registry';

const candidatesFor = (registry: AgentProviderRegistry) => (): Promise<string[]> =>
  availableJudgeSpecs(registry.registry, registry.deps);

/**
 * Reviewing producer's model (`judge`, `advisor`): owner's pin, else a different-vendor model, else the chat model.
 * Mechanical producers resolve synchronously from the tier table and deliberately do not come through here.
 */
export async function resolveReviewingModelSelection(opts: {
  registry: AgentProviderRegistry;
  /** The owner's pin for this producer (AgentConfigStore.getRoleModel). */
  pinned: string | null;
  chatSpec: string | null;
}): Promise<JudgeModelSelection> {
  const { registry } = opts;

  const selection = await selectJudgeModel({
    reviewSpec: opts.pinned,
    chatSpec: registry.normalizeSpecSync(opts.chatSpec),
    candidates: candidatesFor(registry),
  });

  return { ...selection, spec: registry.normalizeSpecSync(selection.spec) };
}

/**
 * Calibration re-judge panel: the owner's named judges, else one model per other connected vendor family.
 * A short list comes back short: no single-vendor fallback.
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
