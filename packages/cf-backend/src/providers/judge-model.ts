// Cross-family judge selection against a live agent provider registry.
//
// The policy AND the candidate list live in core (`selectJudgeModel`,
// `selectEnsembleJudges`, `availableJudgeSpecs`); this is the adapter that
// points them at the registry the agent already owns.

import {
  availableJudgeSpecs, selectEnsembleJudges, selectJudgeModel,
  type EnsembleJudgeSelection, type JudgeModelSelection,
} from '@kinu.run/core';
import type { AgentProviderRegistry } from './agent-registry';

const candidatesFor = (registry: AgentProviderRegistry) => (): Promise<string[]> =>
  availableJudgeSpecs(registry.registry, registry.deps);

/**
 * Resolve a REVIEWING producer's model: the owner's pin for that producer when
 * set, else a different-vendor model when one is connected, else the chat model
 * (same-model reviewing — the documented single-vendor fallback). Specs come
 * back normalized and registry-resolvable.
 *
 * Two producers review: `judge` grades the agent's own output, and `advisor`
 * reads a finished turn and may say one thing about it. They share this one
 * resolver because they share the whole reason for the cross-vendor default —
 * assessing your own output has a bias the smaller sibling shares — and a
 * second copy of that policy would be a second place for it to change.
 *
 * The MECHANICAL producers deliberately do NOT come through here. `selectFastModel`
 * is synchronous, and their seams need a synchronous answer at construction
 * time to decide whether to wire a distinct client at all; this one has to await
 * a live credential listing. One resolver over both would carry a branch neither
 * caller can reach.
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
