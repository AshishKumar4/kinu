/** GEPA: reflective, Pareto-by-instance optimisation of string artifacts (Agrawal et al., ICLR 2026, arXiv:2507.19457). */

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
  makePersistingHooks,
  type GepaRunSummary, type GepaParetoEntry,
} from './persistence';
