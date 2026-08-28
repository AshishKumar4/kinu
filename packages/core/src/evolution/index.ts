export { EvolutionEngine } from './engine';
export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig,
  type EvolutionEvent,
  type EvolutionListener,
  type CompletedTurn,
  type CompletedSession,
  type ToolCallRecord,
} from './types';
export {
  delegationFeatures, renderDelegationFeatures, executionPathSignals,
  type DelegationFeatures, type ExecutionPathSignals,
} from './delegation-features';
export {
  alignmentConvergence, renderAlignmentConvergence, type AlignmentConvergence, type AlignmentSegment, type AlignmentTotals,
  type AlignmentTrend, type RateInterval,
} from './alignment';
export {
  feedbackToQuality, outcomeToFeedback, outcomeQuality,
  isTrivialTurn, classifyTurnOutcome, buildOutcomeClassifierPrompt,
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, hasNegativeOutcome, takePickOutcome,
  NEGATIVE_TURN_OUTCOMES,
  realOutcomeScaffoldRates, blendRealOutcomeRates,
  buildOutcomeEvalSplit, describeSplitDegeneracy, CRITIC_PROSE,
  recordLesson, listLessons, corroborateLessonsForTurn,
  isNegativeOutcome, isUserVerdictSource, executionVerdict, executionVerdictOutcome,
  isPureLookupCall, TURN_OUTCOME_SOURCES,
  recordOutcomeLabels, listOutcomeLabels, goldLabels,
  type OutcomeLabel, type OutcomeLabelRow,
  type TurnOutcome, type TurnOutcomeSource, type TurnOutcomeRow, type ExecutionVerdict,
  type OutcomeClassification, type RecordTurnOutcomeInput, type RealOutcomeRate,
  type OutcomeEvalExpectation, type OutcomeEvalInstance, type OutcomeEvalSplit,
  type OutcomeSplitDegeneracy, type AdvisorNegativeRow,
  type LessonRow, type LessonSource, type LessonStatus, LESSON_SOURCES,
} from './outcomes';
export {
  recordRecoveryFinding, listRecoveryFindings, recoveryFindingText,
  MAX_RECOVERY_FINDINGS, type RecoveryFinding,
} from './recovery';
// C8/C11 — the hand-labeled calibration set and the bias-corrected estimates
// it buys. Without it every rate this system reports about itself is a
// classifier's opinion of the truth rather than the truth.
export {
  sampleForLabeling, renderLabelingFile, parseLabelingFile, allocateLabelBudget,
  ingestOutcomeLabels, type LabelIngestResult,
  calibrationReport, renderCalibrationReport, DEFAULT_LABEL_BUDGET,
  type LabelingItem, type ParsedLabelFile, type CalibrationReport,
  type CalibrationStratum, type CalibratedSegment,
} from './calibration';
export {
  classifierAccuracy, correctedRate, designWeightedKappa, describeCalibrationGap,
  type CalibrationGap, type ClassifierAccuracy, type CorrectedRate, type CorrectedRateResult,
  type ClassifierAccuracyResult, type GoldStratum, type KappaEstimate,
  type MeasuredProportion, type PredictionStratum,
} from './ppi';
// The LLM panel that re-judges the hand-labeled turns, and the pre-registered
// bar it must clear before a recalibration may lean on it instead of the owner.
export {
  runEnsemble, ensembleReport, renderEnsembleReport, describeEnsembleGap,
  buildEnsembleJudgePrompt, panelVerdict, STAND_IN_THRESHOLDS,
  type EnsembleJudge, type EnsembleRun, type EnsembleRunResult, type EnsembleGap,
  type EnsembleReport, type EnsembleMember, type StandInCondition,
} from './ensemble';
// Behavioural weak labels — turns judged by what the user DID (interrupts,
// refusals, re-asks, approvals), and the harness that scores the classifier and
// the panel against them. Complements the on-distribution calibration above; it
// never replaces it.
export {
  BEHAVIOR_RULES, weakLabel, corpusStats, runCorpusEval, renderCorpusReport,
  type BehaviorRule, type CorpusTurn, type TurnSignals, type WeakLabel,
  type CorpusStats, type CorpusEvalInput, type CorpusEvalReport, type RaterScore,
  type RaterCost,
} from './behavior-labels';
export {
  renderScaffoldHandbook, indexScaffoldSites, type ScaffoldSite,
} from './scaffold-handbook';
export {
  COMPLAINT_CLASSES, RESPONSE_MODES, PATHOLOGY_TAG_EXAMPLE,
  clusterPathologies, complaintClass, classifyResponseMode, pathologyId, isPathologyId,
  describePathology, labelPathologyClusters, buildPathologyLabelPrompt,
  parsePathologyTag, renderPathologyBlock,
  type ComplaintClass, type ResponseMode, type PathologyInput, type PathologyCluster,
} from './pathology';
export {
  initReplayTables, runReplayEval, listReplayEvals,
  DEFAULT_REPLAY_SAMPLE_SIZE,
  type ReplayEvalSummary, type ReplayInstanceResult, type RunReplayEvalOpts,
} from './replay';
export {
  initCompletedTurnTable, createCompletedTurnStore, CompletedTurnSchema,
  MAX_TURN_REVIEWS_PER_OPEN,
  type CompletedTurnStore, type ClaimedWindow, type PendingTurnReview,
  type DeferredTurnReview, type RefusedTurnReview, type TakenTurnReviews,
  type EnqueueOutcome, type DeferredReviewDrain, type AppendTurnOpts,
} from './session-window';
export {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogEntryKind, type BuildChangelogOptions,
  type ChangelogRevertAction,
  type ChangelogRevertContext, type ChangelogRevertResult,
} from './changelog';
// CONTINUAL REFINEMENT — the request ledger, its stage machine, and the lane
// that routes a refiner's typed edits into the authorities that already own
// each artifact. Nothing here is a second store for a prompt, a fact, a skill
// or an agent spec; the routes are pointers into the owners.
export {
  REFINEMENT_DISPOSITIONS, REFINEMENT_EDIT_KINDS, REFINEMENT_SCOPES,
  REFINEMENT_STAGES, REFINEMENT_TRIGGERS, RefinementProposalSchema,
  createRefinementStore, evolutionDebt, initRefinementTables, refinementRequestView,
  refinementStagingPath,
  type EvolutionDebt, type OpenRefinementInput, type RefinementDisposition,
  type RefinementEdit, type RefinementEditKind, type RefinementProposal,
  type RefinementDeps, type RefinementRequest, type RefinementRequestView, type RefinementRoute,
  type RefinementScope, type RefinementStage, type RefinementStore, type RefinementTrigger,
  type SettleRefinementPatch,
} from './refinement';
export {
  advanceRefinementLane, refinementDebt, refinementDebtRequest, requestRefinement,
  type RefinementLaneStep, type RequestRefinementInput,
} from './refinement-lane';
// Proposed skills: staged where nothing reads them, shown whole, and promoted
// only by the owner. Its own module because the decision path is the longest
// single thing in this lane and the only one an owner drives.
export {
  REFINEMENT_DECISIONS,
  decideRefinementRoute, showRefinementRoute,
  type RefinementDecision, type RefinementDecisionInput, type RefinementDecisionResult,
  type StagedSkillResult, type StagedSkillView,
} from './refinement-skill';
