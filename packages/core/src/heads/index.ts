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
} from './types';

export {
  DEFAULT_HEAD_BUDGET,
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
  budgetExhausted,
  HEAD_BUILTIN_TOOLS,
  keepBuiltins,
} from './types';

export {
  HeadFileChanges, formatHeadFileChanges, HEAD_FILE_CHANGE_PROVENANCE,
} from './file-changes';
export { initHeadsTables } from './schema';
export {
  HeadJournal, type HeadJournalRow, type LiveHeadRun, type AbandonedHeadRun,
} from './journal';
export {
  reconcileInterruptedForks, forkInterruptedWake,
  FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
  type RunEventLedger,
} from './reconcile';
export { MergeOutputSchema, DecisionSchema, type MergeOutput } from './merge-schema';
export {
  HeadController,
  RECLAIMED_RUN_REASON,
  type HeadRuntime,
  type HeadGrounding,
  type SpawnedHead,
  type MergeLLMFn,
  type SplitPhaseEvent,
  type HeadJournalPort,
} from './controller';
export {
  extractHeadSteps, extractFinalText, synthesizeHeadSummary, headProducedFindings,
} from './head-summary';
export {
  HeadCapture, runHeadInference, buildHeadAccumulatorTools,
  buildHeadSystemPrompt, buildHeadMessages, withHeadCaptureRecording,
  type HeadInferenceDeps, type HeadWorkspaceLayout,
} from './head-inference';
export {
  buildHeadToolSet,
  type HeadToolDeps, type HeadSplitRequest, type HeadSplitResult,
} from './head-tools';
