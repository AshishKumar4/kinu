/**
 * Branching heads — public surface.
 */

export type {
  HeadId,
  HeadBudget,
  HeadInput,
  HeadReport,
  HeadStep,
  HeadStepToolCall,
  HeadRunView,
  HeadRunHeadView,
  Evidence,
  Decision,
  ArtifactRef,
  SplitRequest,
  MergeResult,
  HeadScore,
  MergeStrategy,
  BudgetSplit,
  SerializedMessage,
} from './types.js';

export {
  DEFAULT_HEAD_BUDGET,
  DEFAULT_MERGE_STRATEGY,
  NOMINAL_HEAD_STEPS,
  NOMINAL_STEP_TOKENS,
  MAX_FORK_WIDTH,
  deriveChildBudget,
  budgetExhausted,
} from './types.js';

export { initHeadsTables } from './schema.js';
export { HeadJournal, type HeadJournalRow, type LiveHeadRun } from './journal.js';
export { MergeOutputSchema, DecisionSchema, type MergeOutput } from './merge-schema.js';
export {
  HeadController,
  type HeadRuntime,
  type HeadGrounding,
  type SpawnedHead,
  type MergeLLMFn,
  type SplitPhaseEvent,
} from './controller.js';
export {
  extractHeadSteps, extractFinalText, synthesizeHeadSummary, headProducedFindings,
} from './head-summary.js';
export {
  HeadCapture, runHeadInference, buildHeadAccumulatorTools,
  buildHeadSystemPrompt, buildHeadMessages, withHeadCaptureRecording,
  type HeadInferenceDeps,
} from './head-inference.js';
export {
  buildHeadToolSet, HEAD_BUILTIN_TOOLS,
  type HeadToolDeps, type HeadSplitRequest, type HeadSplitResult,
} from './head-tools.js';
