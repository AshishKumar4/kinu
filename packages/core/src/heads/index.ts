/**
 * Branching heads — public surface.
 */

export type {
  HeadId,
  HeadBudget,
  HeadInput,
  HeadReport,
  HeadReportStatus,
  HeadUnsettledStatus,
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
  headStatusUnsettled,
  storedHeadReportStatus,
} from './types';

export { HeadFileChanges } from './file-changes';
export { initHeadsTables } from './schema';
export {
  HeadJournal, UNREPORTED_AT_MERGE_REASON,
  type HeadJournalRow, type LiveHeadRun, type AbandonedHeadRun,
} from './journal';
export { LiveHeadJournal, type AnnounceHeadActivity } from './live-journal';
export {
  type HeadStreamFrame, type HeadStreamKind,
  type ReportHeadDelta, type PublishHeadStream,
} from './head-stream';
export {
  reconcileInterruptedForks, forkInterruptedWake, jobRedriveResumeGate, resumableForkRoots,
  FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
  type RunEventLedger,
} from './reconcile';
export { MergeOutputSchema, DecisionSchema, type MergeOutput } from './merge-schema';
export {
  headMergeLLM,
  type HeadMergeModelBinder, type HeadMergeModelBinding, type HeadMergePolicyDeps,
} from './merge-policy';
export {
  HeadController,
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
