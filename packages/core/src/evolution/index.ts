export { EvolutionEngine } from './engine.js';
export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig,
  type EvolutionEvent,
  type EvolutionListener,
  type CompletedTurn,
  type CompletedSession,
  type ToolCallRecord,
  type TurnUsage,
} from './types.js';
export {
  delegationFeatures, renderDelegationFeatures, executionPathSignals,
  type DelegationFeatures, type ExecutionPathSignals,
} from './delegation-features.js';
export {
  alignmentConvergence, renderAlignmentConvergence, type AlignmentConvergence, type AlignmentSegment, type AlignmentTotals,
  type AlignmentTrend, type RateInterval,
} from './alignment.js';
export {
  feedbackToQuality, outcomeToFeedback, outcomeQuality,
  isTrivialTurn, classifyTurnOutcome, buildOutcomeClassifierPrompt,
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, hasNegativeOutcome, takePickOutcome,
  realOutcomeScaffoldRates, blendRealOutcomeRates,
  buildOutcomeEvalSplit, describeSplitDegeneracy,
  recordLesson, listLessons, corroborateLessonsForTurn,
  type TurnOutcome, type TurnOutcomeSource, type TurnOutcomeRow,
  type OutcomeClassification, type RecordTurnOutcomeInput, type RealOutcomeRate,
  type OutcomeEvalExpectation, type OutcomeEvalInstance, type OutcomeEvalSplit,
  type OutcomeSplitDegeneracy,
  type LessonRow, type LessonSource, type LessonStatus,
} from './outcomes.js';
export {
  initReplayTables, runReplayEval, listReplayEvals,
  DEFAULT_REPLAY_SAMPLE_SIZE,
  type ReplayEvalSummary, type ReplayInstanceResult, type RunReplayEvalOpts,
} from './replay.js';
export {
  initSessionWindowTable, createSessionWindowStore, type SessionWindowStore,
} from './session-window.js';
export {
  buildChangelog, countUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogEntryKind, type BuildChangelogOptions,
  type ChangelogRevertAction, type ChangelogRevertType,
  type ChangelogRevertContext, type ChangelogRevertResult,
} from './changelog.js';
