/**
 * GEPA — Genetic-Pareto Prompt Evolution.
 *
 * Offline batch optimisation of any string-addressable agent artifact —
 * scaffold source, crafted tool implementations, system-prompt sections —
 * via reflective LLM mutation + Pareto-by-instance candidate preservation.
 *
 * Use case: produce a higher-scoring scaffold candidate from a held-out
 * eval set, then hand off to `modifyScaffold` for the standard shadow-
 * eval + promotion pipeline. Complementary to the runtime mutable-scaffold
 * loop; not a replacement.
 *
 * Paper: Agrawal et al., ICLR 2026 — https://arxiv.org/abs/2507.19457
 */

export * from './types';
export { computeParetoFront, sampleParentByWeight, bestAggregate, parentSelectionWeights } from './pareto';
export { rolloutMinibatch, renderReflectionPrompt, proposeMutation } from './mutate';
export { runGepa } from './engine';
export {
  findComplementaryPair, renderMergePrompt, proposeMerge,
  type MergePair,
} from './merge';
export {
  runScaffoldGepa,
  type RunScaffoldGepaOpts, type RunScaffoldGepaResult,
} from './scaffold-bridge';
export {
  runSectionGepa, findPromptSectionTarget,
  PROMPT_SECTION_TARGETS,
  type RunSectionGepaOpts, type RunSectionGepaResult,
} from './section-bridge';
export {
  initGepaTables, startGepaRun, finishGepaRun,
  persistGepaCandidate,
  updateGepaRunCounters,
  listGepaRuns, loadGepaCandidates, loadGepaParetoFront,
  makePersistingHook,
  type GepaRunSummary, type GepaParetoEntry,
} from './persistence';
