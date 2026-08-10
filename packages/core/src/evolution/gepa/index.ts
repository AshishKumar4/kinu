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
 * Spec: docs/COMPETITIVE-ANALYSIS-2026-05-29.md §3.
 * Paper: Agrawal et al., ICLR 2026 — https://arxiv.org/abs/2507.19457
 */

export * from './types.js';
export { computeParetoFront, sampleParentByWeight, bestAggregate, parentSelectionWeights } from './pareto.js';
export { rolloutMinibatch, renderReflectionPrompt, stripMarkdownFences, proposeMutation } from './mutate.js';
export { runGepa } from './engine.js';
export {
  findComplementaryPair, renderMergePrompt, proposeMerge,
  type MergePair,
} from './merge.js';
export {
  runScaffoldGepa,
  type RunScaffoldGepaOpts, type RunScaffoldGepaResult,
} from './scaffold-bridge.js';
export {
  initGepaTables, startGepaRun, finishGepaRun,
  persistGepaCandidate, persistGepaParetoSnapshot,
  updateGepaRunCounters,
  listGepaRuns, loadGepaCandidates,
  makePersistingHook,
  type GepaRunSummary,
} from './persistence.js';
