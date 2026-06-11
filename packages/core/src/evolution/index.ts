export { EvolutionEngine } from './engine.js';
export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig,
  type EvolutionEvent,
  type EvolutionListener,
  type CompletedTurn,
  type CompletedSession,
  type ToolCallRecord,
} from './types.js';
export {
  feedbackToQuality, outcomeToFeedback, outcomeQuality,
  isTrivialTurn, classifyTurnOutcome, buildOutcomeClassifierPrompt,
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, hasNegativeOutcome,
  realOutcomeScaffoldRates, blendRealOutcomeRates,
  buildOutcomeEvalSplit,
  recordLesson, listLessons, corroborateLessonsForTurn,
  type TurnOutcome, type TurnOutcomeSource, type TurnOutcomeRow,
  type OutcomeClassification, type RecordTurnOutcomeInput, type RealOutcomeRate,
  type OutcomeEvalExpectation, type OutcomeEvalInstance, type OutcomeEvalSplit,
  type LessonRow, type LessonSource, type LessonStatus,
} from './outcomes.js';
export {
  initReplayTables, runReplayEval, listReplayEvals,
  DEFAULT_REPLAY_SAMPLE_SIZE,
  type ReplayEvalSummary, type ReplayInstanceResult, type RunReplayEvalOpts,
} from './replay.js';
export {
  buildChangelog, countUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogEntryKind, type BuildChangelogOptions,
  type ChangelogRevertAction, type ChangelogRevertType,
  type ChangelogRevertContext, type ChangelogRevertResult,
} from './changelog.js';
