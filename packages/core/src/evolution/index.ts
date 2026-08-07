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
  NEGATIVE_TURN_OUTCOMES,
  realOutcomeScaffoldRates, blendRealOutcomeRates,
  buildOutcomeEvalSplit, describeSplitDegeneracy,
  recordLesson, listLessons, corroborateLessonsForTurn,
  isNegativeOutcome, recordOutcomeLabels, listOutcomeLabels, goldLabels,
  type OutcomeLabel, type OutcomeLabelRow,
  type TurnOutcome, type TurnOutcomeSource, type TurnOutcomeRow,
  type OutcomeClassification, type RecordTurnOutcomeInput, type RealOutcomeRate,
  type OutcomeEvalExpectation, type OutcomeEvalInstance, type OutcomeEvalSplit,
  type OutcomeSplitDegeneracy,
  type LessonRow, type LessonSource, type LessonStatus,
} from './outcomes.js';
// C8/C11 — the hand-labeled calibration set and the bias-corrected estimates
// it buys. Without it every rate this system reports about itself is a
// classifier's opinion of the truth rather than the truth.
export {
  sampleForLabeling, renderLabelingFile, parseLabelingFile, allocateLabelBudget,
  ingestOutcomeLabels, type LabelIngestResult,
  calibrationReport, renderCalibrationReport, DEFAULT_LABEL_BUDGET,
  type LabelingItem, type ParsedLabelFile, type CalibrationReport,
  type CalibrationStratum, type CalibratedSegment,
} from './calibration.js';
export {
  classifierAccuracy, correctedRate, designWeightedKappa, describeCalibrationGap,
  type CalibrationGap, type ClassifierAccuracy, type CorrectedRate, type CorrectedRateResult,
  type ClassifierAccuracyResult, type GoldStratum, type KappaEstimate,
  type MeasuredProportion, type PredictionStratum,
} from './ppi.js';
// The LLM panel that re-judges the hand-labeled turns, and the pre-registered
// bar it must clear before a recalibration may lean on it instead of the owner.
export {
  runEnsemble, ensembleReport, renderEnsembleReport, describeEnsembleGap,
  buildEnsembleJudgePrompt, panelVerdict, STAND_IN_THRESHOLDS,
  type EnsembleJudge, type EnsembleRun, type EnsembleRunResult, type EnsembleGap,
  type EnsembleReport, type EnsembleMember, type StandInCondition,
} from './ensemble.js';
export {
  renderScaffoldHandbook, indexScaffoldSites, type ScaffoldSite,
} from './scaffold-handbook.js';
export {
  COMPLAINT_CLASSES, RESPONSE_SHAPES, PATHOLOGY_TAG_EXAMPLE,
  clusterPathologies, complaintClass, responseShape, pathologyId, isPathologyId,
  describePathology, labelPathologyClusters, buildPathologyLabelPrompt,
  parsePathologyTag, renderPathologyBlock,
  type ComplaintClass, type ResponseShape, type PathologyInput, type PathologyCluster,
} from './pathology.js';
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
