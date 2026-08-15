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
  HeadFileChange,
  HeadFileChangeSet,
  HeadScore,
  MergeStrategy,
  SerializedMessage,
} from './types.js';

export {
  DEFAULT_HEAD_BUDGET,
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
  budgetExhausted,
} from './types.js';

export {
  HeadFileChanges, formatHeadFileChanges, HEAD_FILE_CHANGE_PROVENANCE,
} from './file-changes.js';
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
  type HeadInferenceDeps, type HeadWorkspaceLayout,
} from './head-inference.js';
export {
  buildHeadToolSet, HEAD_BUILTIN_TOOLS,
  type HeadToolDeps, type HeadSplitRequest, type HeadSplitResult,
} from './head-tools.js';
