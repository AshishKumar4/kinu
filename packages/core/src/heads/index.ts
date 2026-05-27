/**
 * Branching heads — public surface.
 */

export type {
  HeadId,
  HeadBudget,
  HeadInput,
  HeadReport,
  Evidence,
  Decision,
  ArtifactRef,
  SplitRequest,
  MergeResult,
  MergeStrategy,
  BudgetSplit,
  SerializedMessage,
} from './types.js';

export {
  DEFAULT_HEAD_BUDGET,
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
  budgetExhausted,
} from './types.js';

export { initHeadsTables } from './schema.js';
export { HeadJournal, type HeadJournalRow } from './journal.js';
export { MergeOutputSchema, EvidenceItemSchema, DecisionSchema, type MergeOutput } from './merge-schema.js';
export {
  HeadController,
  type HeadRuntime,
  type SpawnedHead,
  type MergeLLMFn,
} from './controller.js';

export {
  createSplitHeadsTool,
  type SplitHeadsInput,
  type SplitHeadsToolDeps,
} from './split-heads-tool.js';
