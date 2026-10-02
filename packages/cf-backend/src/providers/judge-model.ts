// Cross-family judge panels: policy and candidates live in core; this adapter points them at the agent's registry.

import { availableJudgeSpecs, selectEnsembleJudges, type EnsembleJudgeSelection } from '@kinu.run/core';
import type { AgentProviderRegistry } from './agent-registry';

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
    candidates: () => availableJudgeSpecs(registry.registry, registry.deps),
  });

  return { ...selection, specs: selection.specs.map((spec) => registry.normalizeSpecSync(spec)) };
}
