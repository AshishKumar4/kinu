// Identity
export { initActorTables, initAllTables, initFiberTable, tableExists } from './identity/schema';

export { WorkspacePlanReferenceSchema, type WorkspacePlanReference, SubordinateInspectionRequestSchema, SubordinateInspectionResultSchema, readSubordinateInspection, missingSubordinateHistory, type SubordinateInspectionRequest, type SubordinateInspectionResult } from './subordinates/inspection';

export { inspectSubordinateStorage, type SubordinateInspectionAuthority, type SubordinateInspectionAccess } from './subordinates/inspection-path';

// Backend-neutral terminal-turn state machine: the DO and the CLI supply only effect bodies and a wake.
export {
  declareTerminalRoster, owesShadowTrial,
  type TerminalTurnFacts, type TerminalTurnParts,
} from './orchestrator/terminal-roster';

export {
  TerminalTransitions, TERMINAL_TRANSITION_CALL_ID,
  type TerminalTransition, type TerminalDisposition, type TerminalTransitionDeps,
} from './orchestrator/terminal-transition';

export {
  TerminalEffectLedger, initTerminalEffectTable, terminalEffect, overflowRetryTerminalEffect,
  outputLimitContinuationTerminalEffect, taskReminderTerminalEffect,
  takesTerminalEffect, branchesTerminalEffect, turnRecordTerminalEffect,
  eventDrainTerminalEffect, shadowTrialTerminalEffect,
  terminalEffectKey, terminalEffectBackoffMs, keyedScope, TerminalEffectInterrupt,
  TERMINAL_EFFECT_KEY_VERSION,
  TERMINAL_EFFECT_RETRY_BASE_MS, TERMINAL_EFFECT_RETRY_CEILING_MS,
  RunEndReasonSchema,
  type TerminalEffect, type TerminalEffectTable, type TerminalEffectName,
  type TerminalEffectOutcome, type TerminalEffectStatus, type TerminalEffectPhase,
  type TerminalEffectFault, type OwedEffect, type OwedTerminalEffect,
  type TerminalSequenceRun,
} from './orchestrator/terminal-effects';

// Records that keyed work happened, kept after its row is retired.
export {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone, oncePerTick, type TickedPass,
} from './identity/effect-tombstones';

export { readActivityLog, writeActivityLog, type ActivityLogEntry } from './identity/activity-log';

export { ChatHistoryEntrySchema } from './types/chat';

// Every composition root calls this and nothing else (tests/contract-workspace-schema.test.ts).
export { initWorkspaceSchema, initActorStateSchema, type WorkspaceSchemaSql } from './state/workspace-schema';

export { initUserTables, PROFILE_CATALOG_CONFIG_KEY } from './state/user-schema';

export {
  DEFAULT_SOUL_MD,
  SOUL_PATH,
  WORKSPACE_CREATED_EVENT,
  UNTITLED_WORKSPACE_NAME,
  isPlaceholderMission,
  workspaceGenesisSignal,
  readSoul,
  readMission,
  renderSoulMarkdown,
  seedSoul,
  summarizeSoul,
  summarizeSoulBytes,
  writeSoul,
} from './identity/soul';

export { WORKSPACE_IDENTITY_DDL } from './identity/schema';

export { validateSwarmProfileSnapshot } from './profiles';

export type { ProfileProvenance, SwarmProfileSnapshot } from './profiles';

export { DEFAULT_WORKERS_AI_MODEL_SPEC } from './providers/workers-ai';

export {
  forkWorkspaceStorage, snapshotWorkspaceForFork, readForkLineage,
  type ForkOpts, type ForkLineageRow, type ForkSnapshotSource,
} from './identity/fork';

export {
  ForkSnapshotSchema,
  type ForkSnapshot, type ForkSnapshotHead,
  type ForkMemoryChunkRow, type ForkCraftedToolRow, type ForkConfigRow, type ForkFile,
} from './identity/fork-rows';

export {
  writeForkSnapshot, ForkTargetWriter,
  type ForkResult, type ForkWriteTarget, type ForkStagedCounts,
} from './identity/fork-writer';

export { ForkStagingState, type ForkStaging } from './identity/fork-staging';

export {
  FORK_TRANSFER_VERSION, FORK_FRAME_BYTES, FORK_ROW_SECTIONS, FORK_STREAM_SEED,
  ForkFrameSchema, ForkTransferReceiver, forkTransferFrames, sealForkFrame,
  forkFramePreimage, foldForkStream,
  type ForkFrame, type ForkBeginFrame, type ForkFileFrame, type ForkRowFrame,
  type ForkRowSection, type ForkSectionCounts, type ForkFrameOutcome,
  type UnsealedForkFrame,
  type ForkFileSource, type ForkTransferSource,
} from './identity/fork-transfer';

export {
  NativeSinkPlan,
  type ForkFileSink, type ForkFileCommit, type ForkNativeFilePort,
} from './identity/fork-sink';

export {
  forkPointExists, answersForDrainTurns, conversationCount, conversationTurnPair,
  type ConversationTurnPair,
} from './identity/conversation-store';

export { CHAT_SESSION_ID, MCTS_SESSION_ID } from './session/transcript-schema';

export {
  forkWorkspace, type ForkTransport, type ForkDriverDeps, type ForkOutcome,
} from './identity/fork-driver';

// Workspace archive: one backup format for both backends.
export {
  WORKSPACE_ARCHIVE_EXTENSION, WORKSPACE_ARCHIVE_VERSION,
  archiveSqlFromDatabase, readWorkspaceArchivePage, restoreWorkspaceArchive, writeWorkspaceArchive,
  ArchiveCursorSchema,
  type ArchiveCursor, type ArchiveSqlCursor, type ArchiveFilesCursor,
  type ArchiveExportOptions, type ArchivePage,
  type ArchiveFileEntry, type ArchiveFileSource, type ArchiveFileTarget,
  type ArchiveRestoreOptions, type ArchiveRestoreResult,
} from './identity/archive';

export {
  WORKSPACE_TITLE_SYSTEM_PROMPT,
  workspaceTitlePrompt,
  applyWorkspaceTitle,
  deriveWorkspaceTitle,
  fallbackWorkspaceIdentity,
  mintSubordinateName,
  parseWorkspaceTitle,
  planWorkspaceTitle, autoTitleMayReplace, nameOriginOf, persistAutoTitle, titleActorFromMessage,
  resolveWorkspaceTitle,
  suggestWorkspaceTitle,
  workspaceSlug, workspaceAddressRefusal, isPlaceholderWorkspaceTitle, codenameFor,
  workspaceTitleFromMission,
  type NameOrigin,
  type SuggestedWorkspaceIdentity,
  type WorkspaceTitlePlan,
  type WorkspaceTitleState,
  isWorkspaceName,
  validateWorkspaceName,
} from './identity/naming';

export { workspaceDisplayTitle, workspaceTitleDraft } from './read-models/workspace-title';

// Evolution
export {
  EvolutionEngine, buildScaffoldProposalPrompt,
  type ProposalArchiveContext,
} from './evolution/engine';

export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig, type EvolutionEvent, type EvolutionListener,
  type CompletedTurn, type CompletedSession, type ToolCallRecord,
  type ShadowTrialDrain, type ShadowTrialPlan, type ShadowTrialQueueOutcome, type ShadowTrialTurn,
} from './evolution/types';

export {
  delegationFeatures, renderDelegationFeatures, executionPathSignals,
  type DelegationFeatures, type ExecutionPathSignals,
} from './evolution/delegation-features';

// K_align: corrections per 100 graded turns per scaffold version, with 95% Wilson intervals.
export {
  alignmentConvergence, renderAlignmentConvergence, type AlignmentConvergence, type AlignmentSegment, type AlignmentTotals,
  type AlignmentTrend, type RateInterval,
} from './evolution/alignment';

// Turn outcomes and lessons: the ledgers every evolution surface reads.
export {
  outcomeToFeedback, outcomeQuality, feedbackToQuality, isTrivialTurn,
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, takePickOutcome,
  realOutcomeScaffoldRates, blendRealOutcomeRates,
  describeSplitDegeneracy, CRITIC_PROSE,
  recordLesson, recordedTurnVerdict, listLessons, corroborateLessonsForTurn,
  isNegativeOutcome, isUserVerdictSource, executionVerdict, executionVerdictOutcome,
  isPureLookupCall, TURN_OUTCOME_SOURCES,
  recordOutcomeLabels, listOutcomeLabels, goldLabels,
  recordEnsembleLabels, ensembleLabels, type EnsembleLabelRow,
  type OutcomeLabel, type OutcomeLabelRow,
  type TurnOutcome, type TurnOutcomeSource, type TurnOutcomeRow, type ExecutionVerdict,
  type OutcomeEvalExpectation, type OutcomeEvalInstance, type OutcomeEvalSplit,
  type OutcomeSplitDegeneracy,
  type LessonRow, type LessonSource, type LessonStatus, type RealOutcomeRate,
} from './evolution/outcomes';

export { buildOutcomeEvalSplit, type AdvisorNegativeRow } from './evolution/eval-split';

export {
  recordRecoveryFinding, listRecoveryFindings, recoveryFindingText,
  MAX_RECOVERY_FINDINGS, type RecoveryFinding,
} from './evolution/recovery';

// C8/C11 calibration: uncalibrated rates are reported as such, never approximated.
export {
  sampleForLabeling, renderLabelingFile, parseLabelingFile, allocateLabelBudget,
  ingestOutcomeLabels, type LabelIngestResult,
  calibrationReport, renderCalibrationReport, DEFAULT_LABEL_BUDGET,
  type LabelingItem, type ParsedLabelFile, type CalibrationReport,
  type CalibrationStratum, type CalibratedSegment,
} from './evolution/calibration';

export {
  classifierAccuracy, correctedRate, designWeightedKappa, describeCalibrationGap,
  type CalibrationGap, type ClassifierAccuracy, type CorrectedRate, type CorrectedRateResult,
  type ClassifierAccuracyResult, type GoldStratum, type KappaEstimate,
  type MeasuredProportion, type PredictionStratum,
} from './evolution/ppi';

// The panel must clear STAND_IN_THRESHOLDS before a recalibration may lean on it.
export {
  runEnsemble, ensembleReport, renderEnsembleReport, describeEnsembleGap,
  buildEnsembleJudgePrompt, panelVerdict, STAND_IN_THRESHOLDS,
  type EnsembleJudge, type EnsembleRun, type EnsembleRunResult, type EnsembleGap,
  type EnsembleReport, type EnsembleMember, type StandInCondition,
} from './evolution/ensemble';

// Behavioural weak labels complement the calibration set; they never replace it.
export {
  BEHAVIOR_RULES, weakLabel, corpusStats, runCorpusEval, renderCorpusReport,
  type BehaviorRule, type CorpusTurn, type TurnSignals, type WeakLabel,
  type CorpusStats, type CorpusEvalInput, type CorpusEvalReport, type RaterScore,
  type RaterCost,
} from './evolution/behavior-labels';

export {
  initReplayTables, runReplayEval, listReplayEvals, DEFAULT_REPLAY_SAMPLE_SIZE,
  type ReplayEvalSummary, type ReplayInstanceResult, type RunReplayEvalOpts,
} from './evolution/replay';

// One row per turn, owned by EvolutionEngine.
export {
  initCompletedTurnTable, createCompletedTurnStore, CompletedTurnSchema,
  MAX_TURN_REVIEWS_PER_OPEN,
  type CompletedTurnStore, type ClaimedWindow, type PendingTurnReview,
  type DeferredTurnReview, type RefusedTurnReview, type TakenTurnReviews,
  type EnqueueOutcome, type DeferredReviewDrain, type AppendTurnOpts,
} from './evolution/session-window';

export {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogEntryKind, type BuildChangelogOptions,
  type ChangelogRevertAction,
  type ChangelogRevertContext, type ChangelogRevertResult,
} from './evolution/changelog';

// Configuration
export { DEFAULT_CONFIG } from './config';

export { UNBOUNDED_STEPS } from './chat';

export {
  createAgentConfigStore, initAgentConfigTable,
  canonicalConversationId,
  AGENT_CONFIG_KEYS, DEFAULT_AUTO_GEPA_EVERY_N_TURNS,
  DEFAULT_GEPA_EVAL_BUDGET, clampGepaEvalBudget,
  type AgentConfigStore, type MctsOverrides, type ShellApprovalMode,
} from './config/index';

// Types
export type * from './types/primitives';

export { VfsRevisionSchema } from './types/primitives';

export { REAL_CLOCK, waitOn, every, type Clock } from './types/clock';

export { referenceRoots, formatReference, type ReferenceRoot } from './vfs/references';

export type * from './types/agent-runtime';

export type * from './types/backend-host';

export type * from './types/signals';

export { SIGNAL_ID_METADATA_KEY } from './types/signals';

export type * from './types/mcts';

export type * from './types/craft';

export type * from './types/evaluation';

// Slate stores live in `@kinu.run/core/slates`: they touch `node:util`, and client
// code value-imports this barrel. Keep worker-only modules off it.
export {
  parseSlateProject, describeBindings, credentialedBindings,
  type SlateProject, type SlateBinding, type SlateBindingKind, type SlateBindingDeclaration,
} from './slates/project';

export {
  SHARE_KINDS, SHARE_VIEWER_REQUESTS_PER_MINUTE, SHARE_SPEND_CAP_USD_PER_DAY, shareSpendLabel, VIEWER_EXCHANGE_PATH,
  formatBlueprintId, parseBlueprintId, blueprintPagePath,
  BlueprintInspectionSchema, BlueprintViewSchema, BlueprintForkSchema, BlueprintBundleSchema, PublishedBlueprintSchema,
  SharedLibrarySchema, SlateShareRecordSchema,
  ShareGrantSchema, SlateCapabilityGraphSchema,
  LiveShareRecordSchema, LiveShareCreatedSchema, ViewerCallSchema, ViewerRequestRecordSchema, ShareViewerClaimSchema,
  type ShareKind, type LiveShareVisibility, type BlueprintAddress, type BlueprintInspection, type BlueprintView,
  type BlueprintFork, type BlueprintBundle,
  type PublishedBlueprint, type SharedLibrary, type SharedRow, type OwnedSlate, type SlateShareRecord, type BlueprintEntry, type BlueprintWarning,
  type ShareGrantMember, type ShareGrant, type SlateCapability,
  type SlateGraphMember, type SlateGraphBinding, type SlateCapabilityGraph,
  type LiveShareRecord, type LiveShareCreated, type ViewerCall, type ViewerRequestRecord, type ShareViewerClaim,
} from './slates/sharing';

export {
  memberEffect, toolActionMember, toolActionEffect, toolMembers,
  type SlateMemberEffect,
} from './slates/members';

export {
  slateCapabilityGraph, cutShareGrant, grantAdmits, type SlateBindingCatalog,
} from './slates/capability-graph';

export {
  SlateBindingRequestSchema, routeSlateBindingCall, issuedSlateInvocation, routeViewerBindingCall,
  type SlateBindingRequest, type SlateBindingRoute, type SlateInvocation, type SlateViewer, type ViewerBindingCall,
} from './slates/bindings';

export { SLATE_READ_MODELS, type SlateReadModel } from './slates/read-models';

export type { SlateProcess } from './slates/process';

export {
  isSlateMethodName, SLATE_METHOD_NAME_SOURCE, SlateOperationSchema, requireSlateWorkMode, type SlateOperation, SLATES_CHANGED_EVENT, type SlateCallResult, type SlateAnswer,
  type SlateSummary, type SlateProblem, type SlatesChangedEvent,
} from './slates/rpc';

export { initSlateStateTable, SLATE_HOST_BINDING, SLATE_STORAGE_BINDING, routeSlateStorageCall, type SlateStorageOp } from './slates/state';

// Browser-safe slate vocabulary, so it belongs on this value-imported barrel.
export {
  buildSlateHostContext, isSlateFrameMessage, slateFrameSrc, slateInlineHeight, slateLinkId,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_INLINE_HEIGHT, SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE, SLATE_THEME_TOKENS,
  SlateFrameMessageSchema, type SlateHostContext,
} from './slates/host-context';

// Release lane (separate from scaffold evolution)
export {
  assertReleaseTransition,
  RELEASE_STATUSES,
  ReleaseEngine,
  ReleaseStore,
  approvalTypeForEnvironment,
  createReleaseStore,
  createSandboxReleaseExec,
  deployApprovalDigest,
  deployTargetAsCommand,
  initReleaseTables,
  isEngineOwnedTransitionTarget,
  isSecretReleasePath,
  normalizeReleasePath,
  parseDeployOutput,
  releaseSqlFromExec,
  redactReleaseDiff,
  validateReleasePatchPath,
  type ApplyResult,
  type CheckRunResult,
  type DeployApprovalBinding,
  type DeployResult,
  type PreviewResult,
  type ReleaseBoard,
  type ReleaseApproval,
  type ReleaseCheck,
  type ReleaseDetail,
  type ReleaseEngineOptions,
  type ReleaseExec,
  type ReleaseLedger,
  type ReleaseChange,
  type ReleaseSqlStore,
  type ReleaseStatus,
  type ReleaseStoreOptions,
  type ReleaseTransitionResult,
  type ReleaseDeployment,
  type ReleasePathValidation,
  type ReleaseSource,
  type ReleaseSourceInput,
  type ReleaseSourceKind,
  type RollbackResult,
  type RunChecksResult,
} from './release/index';

// Cross-workspace experience transfer
export {
  createExperienceLibrary,
  findPublishable,
  runExperienceAction,
  EXPERIENCE_ACTIONS,
  EXPERIENCE_KINDS,
  type ExperienceAction,
  type ExperienceActionDeps,
  type ExperienceActionInput,
  type ExperienceLibraryClient,
  initExperienceLibraryTables,
  initImportedExperienceTable,
  listImportedExperience,
  listPublishable,
  parseExperiencePayload,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperienceLibraryStore,
  type ExperiencePayload,
  type ExperienceSearchOptions,
  type ImportStatus,
  type ImportedExperienceRow,
  type PublishRefusal,
  type PublishSources,
  type PublishableCandidate,
} from './experience/index';

// Chat engine
export {
  runChat, INTERRUPTED_TURN, isRateLimitedTurnError,
  type ChatEvent, type ChatOptions, type ChatToolOutput, type ObservedCall, type ObserveStream,
} from './chat';

// Extension seam (public plugin API)
export {
  ExtensionHost,
  type KinuExtension,
  type TurnStartContext,
  type ToolCallContext,
  type ToolResultContext,
  type TurnEndContext,
  type PrepareStepContext,
  type TransformContext,
} from './extension';

export {
  composePrepareStep,
  type StepCachePlan,
  type StepContextPlane,
  type StepDynamicContext,
  type StepPipeline,
  type StepPrepareResult, type StepPrepareContext,
} from './prompting/prepare-step';

export { toolPairingGaps } from './session/tool-pairing';

export { STAGED_CONTEXT_DEFERRALS, type StagedContextDeferral, type ContextProposalClosure, type ContextEditEffect, type ContextEventRecorder, type ContextEditEvent } from './types/context-plane';

export { SessionHistory, type SessionHistoryDependencies } from './session/history';

export type { ContextSelection, ContextEntry } from './session/context';

export type { ContextProposal, ContextChange } from './session/proposals';

export {
  contextMount,
  type ActorContextStores, type ChildContextResolver, type ContextMountDeps, type ContextFileHeader,
} from './vfs/context-plane';

export type { SessionFilePlane } from './session/payload';

export type { MessageReference, MessagePartReference, ActorReadAuthority } from './session/messages';

export { SessionTranscript, SessionTranscriptReader, readSessionTranscript, type ConversationEntry, type ConversationProjection, type PreparedConversationEntry } from './session/transcript';

export { encodeModelMessageValues, decodeModelMessageValues } from './session/message-codec';

export {
  pruneStepToolOutputs,
  stepContextLimit,
  outputReserveTokens,
  type ModelWindow,
  type ResolvedModelWindow,
  type StepPruneBudget,
} from './prompting/step-prune';

export {
  settleUnpairedToolCalls,
  INTERRUPTED_TOOL_RESULT,
} from './prompting/interrupted-tool-calls';

export { StepInjections, type RecordedInjection } from './prompting/step-injections';

export {
  classifyTurnFailure,
  planOverflowRecovery,
  OVERFLOW_RETRY_EVENT,
  OVERFLOW_RETRY_TEXT,
  type TurnFailureClass,
  type TurnFailureSignals,
  type OverflowRecoveryInput,
  type OverflowRecoveryDecision,
} from './turn-failure';

// LLM
export {
  createVercelAILLM, collectStepText, createChatModel, createCompletionLLM, estimateTokens,
  // Surfaces import this instead of retyping the number.
  CHARS_PER_TOKEN,
} from './llm';

export type { LLMProviderConfig, ChatModelConfig, LLMUsage } from './llm';

// Every surface that counts tokens speaks this usage report.
export {
  USAGE_FIELDS,
  UsageSchema,
  addUsage,
  normalizeUsage,
  usageReported,
  usageTotal,
} from './usage';

export type { Usage } from './usage';

export { contextWindowForModel, type ContextWindowEstimate } from './context-window';

// The per-turn bulk ledger: the cumulative clamp budget + the M1 trip counters.
export {
  TurnContextBudget,
  citesSpillAddress,
  SPILL_DIRS,
  type BulkProducer,
  type ContextBudgetSnapshot,
  type SpillTrip,
} from './context-budget';

// Label-scoped spend governor. Opt-in: no label, no cap, no storage traffic.
export {
  MissionGovernor,
  MissionBudgetExhausted,
  MISSION_LABELS_METADATA_KEY,
  readMissionLabels,
  readMissionLimits,
  localMissionPort,
  // A surface that prices a call must use this, exactly as the ledger debits it.
  priceCall,
  localMissionScope,
  listMissionSpend,
  type MissionBudgetPort,
  type MissionScope,
  type MissionBudgetLimits,
  type MissionBudgetRefusal,
  type MissionBudgetSnapshot,
  type MissionGovernorDeps,
  type MissionSeam,
  type MissionSpendProvenance,
} from './mission-budget';

export {
  buildCompactionSummaryPrompt,
  wrapCompactionSummary,
  stripCheckpointPreamble,
  CONTEXT_CHECKPOINT_PREFIX,
  type CompactionSummaryPromptInput,
} from './compaction';

// Tool registry
export {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOL_SPECS,
  replayPolicyFor,
  type ReplayPolicy,
  AGENTS_TOOL_ACTIONS,
  TASKS_TOOL_ACTIONS,
  WEB_TOOL_ACTIONS,
  FILE_TOOL_ACTIONS,
  memoryActionsFor,
  type WebToolAction,
  type FileToolAction,
  type TasksToolAction,
  DELEGATION_FRAME,
  DELEGATION_INHERITANCE,
  DELEGATION_RUNGS,
  DELEGATION_CONVERSE,
  renderToolSchemaDescription,
  renderCodemodeDescription, CODEMODE_CODE_DESCRIPTION,
  TOOL_REACH,
  isBuiltinToolName,
  narrowToolSurface,
  codemodeCapabilitiesFor,
  type ToolSurfaceNarrowing,
  type ToolReach,
  type AgentsToolAction,
  type BuiltinToolName,
  type BuiltinToolSpec,
  REPORT_TOOL, SUBMIT_PLAN_TOOL, DEPS_GATED_TOOLS,
} from './tools/registry';

export {
  CRAFTED_TOOL_NAMESPACE,
  craftedToolDescription, firstSentence, jsonSchemaToTs, nativeToolInputSchema, codemodeInputSchema,
  renderToolsDeclaration, nativeToolFunctions, codemodeFunction, craftedFailureFunctions, slateToolReach, callCodemodeMember,
  withCraftedToolDeclarations, craftedToolDeclarations,
  type CraftedDeclaration,
  type CodemodeProvider, type CodemodeResult,
} from './tools/sandbox-contract';

export { STATE_NAMESPACE, STATE_TYPES, createStateCodemodeProvider } from './tools/state-codemode';

export { initCodemodeStateTable, createProgramStateStore, type ProgramStateStore } from './identity/program-state';

export {
  APP_TABLE_SCOPES, APP_MUTATIONS,
  initAgentDataTables, createAppDataStore, createDbCodemodeProvider,
  type AppColumn, type AppColumnType, type AppTableScope, type AppMutation,
  type AppTableSpec, type AppTableRecord, type AppPredicate, type AppWhere,
  type AppSelect, type AppOp, type AppOpResult, type AppRow,
  type AppDataStore, type AppDataStoreDeps, type DbOpRecord,
} from './tools/db-codemode';

export { ActorReferenceSchema, actorReferenceOf, bindActorHandle, sameActorReference, type ActorReference, type ActorIdentity, type ActorHandle } from './identity/actor-handle';

export { explorationActorKey, isExplorationActorKey, parseActorKey, requireSubordinateActorName } from './identity/actor-key';

export { finishSubordinateBirth, recoverSubordinateLifecycles, SubordinateBirthSchema, type SubordinateBirth, type SubordinateSeed } from './subordinates/birth';

export { SubordinateInheritedContextSchema, type SubordinateInheritedContext } from './types/subordinates';

export { subordinateForkContext, subordinateTurnContext } from './subordinates/support';

export { drainAssignments, type AdmittedAssignment, type DrainAssignmentsOptions } from './subordinates/assignments';

export { inheritedAsModelMessage } from './heads/head-inference';

export { initWorkspaceActorTable, WorkspaceActorDirectory, actorScaffoldPath, actorStateRoot, openWorkspaceMainActor, ChildActorOperationSchema, type ChildActorOperation, type ActorDirectoryResult, type WorkspaceActorAuthority, type WorkspaceActor, type CreateWorkspaceActor } from './identity/workspace-actors';

// open-38: one physical workspace SQLite for every logical actor.
export {
  createActorHost, recoverActorTurns, childContextResolver,
  type ActorHost, type ActorHostDeps, type BoundActor, type HostedActor,
  type LoopSeed, type ActorRetirement, type ResumableActorTurn,
} from './state/actor-host';

export { seedActorLoop, defaultLoopOrigin, type LoopOrigin } from './scaffold/bootstrap';

export { admitCraftedSource, parsesAsExpression, type CraftedSourceAdmission } from './craft/source';

export { mcpToolKey, isMcpToolKey } from './tools/mcp-naming';

export { toolSchemaDialect, withToolSchemaDialect, type ToolSchemaDialect } from './tools/tool-schema';

export {
  describeMcpTool, admitMcpDescriptors, toolSurfaceTokens, omitEmptyOptionalArgs,
  buildMcpToolSet, listMcpToolsLeniently,
  SerializableToolDescriptorSchema, McpToolSurfaceSchema,
  type SerializableToolDescriptor, type RemoteMcpTool, type McpToolRefusal, type ListedMcpTools,
  type McpSurfaceBudget, type McpDescriptorAdmission, type McpToolBuild,
} from './tools/mcp-surface';

export {
  createAgentsTool, agentsActionsFor, renderAgentsToolDescription, resumableAgentsInput,
  parseAgentsToolInput, agentsProfileContext,
  AGENTS_ACTION_FIELDS, AGENTS_ACTION_REQUIRED_FIELDS, AGENTS_FIELD_TS_TYPES,
  type AgentsToolInput, type AgentsProfileContext, type DelegatedProfile,
} from './delegation/agents-tool';

export {
  createLocalPeerEndpoint, samePeerGroup,
  type HostedAgentRef, type LocalPeerEndpoint, type LocalPeerEndpointDeps,
} from './tools/local-peer';

export { createAgentsCodemodeProvider } from './delegation/agents-codemode';

export { createAgentSelfProvider, type AgentSelfHost } from './tools/agent-self';

export { agentSelfHost } from './orchestrator/agent-self-host';

// Platform-neutral: a backend supplies only SubordinateRuntime.
export { SubordinateRosterStore } from './subordinates/roster';

export {
  SubordinateIdentityStore,
  admitSubordinateReport,
  admitSubordinateTask,
  createTeamToolDeps,
  describeSubordinateHandoff,
  normalizeReportContent,
  parentAdmitsSubordinateReport,
  readSubordinateLiveStatus,
  subordinateDescriptorSource,
  subordinateRelaysTurnEnd,
  type SubordinateDescriptor,
  type SubordinateDescriptorSource,
  type SubordinateIdentity,
  type SubordinateLiveStatus,
  type SubordinateReportOrigin,
  type SubordinateRuntime,
  type SubordinatesChangedEvent,
} from './subordinates/support';

export {
  SUBORDINATE_LIFETIMES,
  TEMPORARY_LIFETIME,
  TASK_TURN_ENDINGS,
  createTemporaryAgentPort,
  renderTemporaryTaskBrief,
  temporaryRunSettles,
  terminalTaskReport,
  type SubordinateLifetime,
  type TemporaryAgentPort,
  type TemporaryRunOutcome,
  type TemporaryRunRefusal,
  type TaskTurnEnding,
  type TemporaryRunRequest,
} from './subordinates/temporary';

// The depth cap is derived per child, never stated by one.
export {
  DELEGATION_MAX_DEPTH,
  ROOT_DELEGATION_BUDGET,
  delegationBudgetAtDepth, delegationBudgetOf,
  delegationDepthRefusal,
  delegationExhausted,
  deriveChildDelegationBudget,
  type DelegationBudget,
  type DelegationDepthRefusal,
} from './subordinates/depth';

export {
  buildBuiltinTools,
  type BuiltinToolDeps,
  type CraftedToolSet, type CodemodeBuilder, type CodemodeSurface,
  type ReportToolDeps,
} from './tools/builtins';

// An actor surface is buildBuiltinTools plus `agents`; see tools/actor-tools.ts.
export {
  buildActorTools, PEER_REPLY_TOPIC,
  type ActorToolsetDeps,
  type AgentsToolDeps, type AgentsSwarmDeps,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type SubordinateDelivery, type SubordinatePhase, type SubordinateHandoff,
  type PeersToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './tools/actor-tools';

// Applied inside buildActorTools; backends never wrap tools themselves.
export {
  initToolEffectClaimTable, claimToolEffect, settleToolEffect,
  withEffectClaims,
  type EffectClaimDeps, type ToolEffectClaim, type ToolEffectKey,
} from './tools/effect-claim';

// Web search + fetch
export * from './web/index';

// Codemode-only, no native tool: see tools/builtins.ts.
export {
  createReleaseCodemodeProvider, runReleaseAction,
  type ReleaseToolDeps, type ReleaseActionInput,
} from './tools/release-codemode';

export { createMemoryCodemodeProvider } from './tools/memory-codemode';

export { createMemoryDispatcher, type MemoryToolDeps, type MemoryToolInput } from './tools/memory-tool';

export { createTasksCodemodeProvider } from './tools/tasks-codemode';

export { createTasksDispatcher, type TasksToolInput } from './tools/tasks-tool';

export { createReportCodemodeProvider } from './delegation/report-codemode';

export { createFileDispatcher, type FileToolDeps, type FileToolInput } from './tools/file-tool';

export {
  summarizeToolCall, describeToolCall, describeCommand,
  toolCallEffect, clip,
  type ToolCallEffect,
} from './tools/tool-call-summary';

export { ToolOutcomeSchema, failedToolOutcome, successfulToolOutcome, withCodemodeProgram, type ToolOutcome } from './tools/outcome';

export { repairToolCall } from './tools/repair-tool-call';

export { McpToolError, McpProtocolFailureSchema } from './tools/mcp-error';

export {
  clampToolResult,
  clampSerializedToolResult,
  withClampedToolResult,
  withClampedToolResults,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_OUTPUT_DIR,
  type ClampToolResultOptions,
} from './tools/clamp';

export { handRolledFileWrite, createFileToolSteer } from './tools/shell-file-steer';

export {
  toCraftedToolSource,
  selectInjectableCraftedTools,
  type CraftedToolExecute,
  type CraftedToolExecuteFn,
  type CraftedToolSource,
} from './tools/crafted-executor';

export {
  assignedTurnFraming,
  buildSystemPromptSync,
  currentDateForPrompt,
  FALLBACK_PURPOSE,
  renderUnverifiedInstructions,
  unverifiedInstructionsMessage,
  WORKSPACE_INSTRUCTIONS_HEADER,
  type UnverifiedInstructions,
  type AssignedTurnFraming,
  type SystemPromptOptions,
} from './prompt';

export {
  splitPromptSections,
  DYNAMIC_CONTEXT_OPEN_TAG,
  SOUL_SECTION_TITLE,
  type PromptSection,
} from './prompting/sections';

// A local estimate, carried beside the provider totals, never reconciled into them.
export {
  TurnContextMeter,
  measureContext,
  type ContextComposition,
  type ContextPlane,
  type ContextSegment,
  type ToolDefsLike,
} from './context-meter';

export { isWorkMode, WorkModeSchema, type TurnProvenance, type WorkMode } from './types/turn';

export {
  compilePromptSurface,
  executorIsSelectable,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  uniqueBuiltinTools,
  uniqueExternalTools,
  uniquePromptExecutors,
  type PromptBackend,
  type PromptExecutorInfo,
  type PromptExternalToolInfo,
  type PromptIdentity,
  type PromptSurface,
  type PromptSurfaceOptions,
} from './prompting/surface';

export {
  assertToolsSupportedByModel,
  modelSupportsTools,
  resolvePromptModelProfile,
  type PromptModelCapability,
  type PromptModelContext,
  type PromptModelFamily,
  type PromptModelProfile,
} from './prompting/model-profile';

export {
  renderAgentsMdSection,
  collectWorkspaceAgentsMd,
  admitAgentsMd,
  advisorWorkspaceGuidance,
  renderInstructionOmission,
  type AdvisorWorkspace,
  type AgentsMdFile,
  type AgentsMdReference,
  type AgentsMdSources,
  type AgentsMdUnavailable,
  type InstructionPlacement,
} from './prompting/agents-md';

export {
  acceptedMediaForModel,
  sanitizeAttachmentsForModel,
  type AttachmentPolicy,
  type MediaModality,
} from './prompting/attachment-sanitizer';

export {
  DynamicContextLedger,
  agentDynamicContext,
  executorAvailabilityLabel,
  searchDelegates,
  observeSystemPromptHash,
  renderDynamicContextBlock,
  renderTurnLocalContext,
  turnLocalContextMessage,
  DYNAMIC_CONTEXT_HEADER,
  TURN_CONTEXT_HEADER,
  type DynamicApproval,
  type ActiveRoster,
  type DynamicContext,
  type DynamicDelegate,
  type DynamicJob,
  type DynamicTask,
  type MissingCapability,
  type TurnLocalContext,
} from './prompting/volatile-context';

export {
  applyCacheBreakpoints,
  cacheableSystem,
  hasCacheMarkers,
  markCacheTail,
  markLastToolForAnthropicCache,
  promptCacheOptions,
  promptCachePlan,
  resolvePromptCacheStrategy,
  ANTHROPIC_MAX_BREAKPOINTS,
  type CacheBreakpointInput,
  type CacheBreakpointPlan,
  type PromptCachePlan,
  type PromptCachePlanInput,
  type PromptCacheStrategy,
} from './prompting/cache-breakpoints';

export {
  extractJsonArray,
  extractJsonObject,
  generateJson,
  jsonArrayOnlyInstruction,
  jsonObjectOnlyInstruction,
  stripMarkdownFences,
} from './prompts/structured';

export { EVIDENCE_BUDGETS, evidenceWindow, renderToolResult } from './prompts/evidence-window';

// Runtime builder
export { buildRuntime } from './runtime-builder';

export type { RuntimeComponents } from './runtime-builder';

export { createAgentStores } from './state/agent-stores';

export type { AgentStores } from './state/agent-stores';

export { collectDynamicContext, subordinateDelegatesOf } from './state/dynamic-context';

export type { DynamicContextInput } from './state/dynamic-context';

// MCTS
export { runMCTS, SEARCH_FIBER_NAME, BranchExplorationSchema, BranchReflectionSchema } from './mcts/engine';

export { selectNode } from './mcts/uct';

export { backpropagate } from './mcts/backpropagation';

export { recordNode } from './mcts/record-node';

export type { SessionWriter, SessionMessage, SessionMessagePart } from './mcts/record-node';

export { converge } from './mcts/convergence';

export { pruneLowValueBranches } from './mcts/pruning';

export { diversityDirective, diversityAngle, siblingAngles } from './mcts/diversity';

export {
  explorePrompt, reflectionPrompt,
  type ExplorePrompt, type ExplorePromptInput, type ExploreToolHint,
} from './mcts/explore-prompt';

export { exploreRollout, reflectRollout, type BranchRoute } from './mcts/rollout';

export {
  canonicalLanguage, fencedBlocks, readProposalCode,
  type FencedBlock, type ProposalCode,
} from './execution/code-fence';

export {
  formatInheritedContext, DEFAULT_INHERITED_MESSAGES,
  type InheritedMessage,
} from './mcts/inherited-context';

export { selectWinnerByTest, type TestSelectionDeps } from './mcts/test-selection';

export {
  evaluateWithMultiModelJudging, median,
  type EvaluateBranchOptions, type BranchEvaluation,
} from './mcts/evaluation';

export type { EvaluationGrounding } from './types/evaluation';

export { estimateCost } from './mcts/cost';

// Alternate Takes
export {
  initAlternateTakesTable, captureAlternateTakes, claimAlternateTakesForTurn,
  purgeUnclaimedAlternateTakes, unclaimedAlternateTakeIds,
  listAlternateTakeSets, latestAlternateTakeSet, recordTakePick,
  recordBranchTakeSet, buildTakeContinuationPrompt, takeEvidence,
  type AlternateTakeCandidate, type AlternateTakeSet, type AlternateTakeSource,
  type TakePickRecord, type TakePickOutcome,
} from './mcts/takes';

// Steer-as-Branch
export {
  BRANCH_HEAD_BUDGET, BRANCH_RATIONALE, STEER_BRANCH_RUN_ID_PREFIX,
  newBranchId, isSteerBranchRunId, branchHeadId,
  startBranchHead, settleBranchIntoTakes, settlePendingBranch,
  branchOutcomeFromJournal,
  type BranchStatusEvent, type BranchStartInput, type SteerBranchHandle,
  type BranchSettleOutcome, type BranchOutcome, type PendingBranch,
} from './steer-branch';

// Inbox: the one way anything reaches an agent.
export {
  Inbox, readSignalId, PromptFileSchema,
  STEER_METADATA_KEY, STEER_STEP_METADATA_KEY,
  describeLandedSteers, initPendingSendTables, PendingSendStore,
  type UserSteerDeps, type AcceptedSteer,
  type UserSteer, type SteerStatusEvent, type SteerStatusDetail,
  type LandedSteerRow, type PendingSendRow,
} from './orchestrator/inbox';

export {
  buildTranscript, extendTranscript, sealTranscript, segmentBySteers,
  EMPTY_TRANSCRIPT_FOLD,
  type InlineSteer, type PlacedSteer, type Transcript, type TranscriptEntry,
  type TranscriptFold, type TranscriptPart, type TurnSegment,
} from './read-models/transcript';

// Schemas
export { initSearchTables } from './mcts/schemas';

export { initSwarmNodeRecords } from './strategy/swarm-resume';

export {
  MctsSearchStore,
  initMctsSearchTable,
  persistableMCTSConfig,
  type PersistedMCTSConfig,
  type ResumableSearch,
  type MctsSearchRunSummary,
} from './mcts/search-store';

export { initScaffoldTables } from './scaffold/schemas';

// Scaffolds
export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap';

export { modifyScaffold, type ModifyResult, type ModifyScaffoldOpts } from './scaffold/modify';

export { rollbackScaffold } from './scaffold/rollback';

export { createScaffoldSurface, type ScaffoldSurfaceOpts } from './scaffold/surface';

// Misevolution gate: fixed safety criteria over every evolution surface.
export {
  checkMisevolution, checkMisevolutionForSurface, recordMisevolutionVeto,
  type MisevolutionSurface, type MisevolutionVerdict, type MisevolutionViolation,
} from './scaffold/misevolution';

// Variant archive over scaffold_versions/scaffold_evaluations (no parallel store).
export {
  listScaffoldArchive, listRejectedProposals, selectEvolutionBase,
  type ScaffoldArchiveEntry, type EvolutionBaseSelection,
  type RejectedProposal, type RejectionKind,
} from './scaffold/archive';

// Shadow-mode rollout
export {
  runScaffold,
  scaffoldEventText,
  type ScaffoldRunOptions,
  type ScaffoldRunResult, type ScaffoldRunReport, type ScaffoldJsonEvent, scaffoldRunReport,
  type ScaffoldDefaultInferenceChunk,
  type ScaffoldEvent, type ScaffoldModelEvent, type ScaffoldToolOutput,
  type ScaffoldEmitFn,
} from './scaffold/executor';

export { pumpScaffoldEvents } from './scaffold/event-pump';

export { scaffoldChatTransform } from './scaffold/chat-transform';

export {
  initShadowTables,
  getPendingScaffold,
  getCurrentScaffoldVersion,
  readScaffoldVersion,
  readVersionedScaffoldSource,
  readShadowVerdict,
  recordShadowEvaluation, scoredShadowTrial, trimTrialContext,
  decidePromotion,
  applyPromotionDecision,
  DEFAULT_SHADOW_CONFIG,
  // Kept out of scaffold_evaluations so unrun trials can never walk the calibrated ladder.
  queueShadowTrial,
  listQueuedShadowTrials,
  countQueuedShadowTrials,
  dropQueuedShadowTrial,
  purgeQueuedShadowTrials,
  MAX_QUEUED_SHADOW_TRIALS,
  SHADOW_TRIAL_CONTEXT_CHARS,
  type PendingScaffold,
  type QueuedShadowTrial,
  type ShadowEvaluationRow,
  type ShadowVerdict,
  type ShadowVerdictTrial,
  type ShadowConfig,
  type ScaffoldStatus,
  type ShadowTrialVerdict,
} from './scaffold/shadow';

// Auto-judge shadow evaluation
export {
  runAutoShadowEval,
  JudgeOutputSchema,
  DEFAULT_AUTO_JUDGE_CONFIG,
  type AutoJudgeConfig,
  type AutoShadowEvalResult,
  type JudgeOutput,
  type StructuredJudgeFn,
  type RunAutoShadowEvalOpts,
} from './scaffold/auto-judge';

// CraftStore quality
export { emaUpdate, effectiveScore, filterByEffectiveScore, updateCraftScores } from './craft/ema';

export { craftFailureMarker, CRAFT_NEUTRAL_PRIOR } from './craft/in-episode';

export {
  attributeCraftedFailure,
} from './craft/attribution';

export { maybeStoreCraftedTool } from './craft/discovery';

export { periodicCraftConsolidation } from './craft/consolidation';

export { checkConflictsBeforeAdding, upsertCraftedTool } from './craft/conflict';

// Execution
export {
  DefaultExecutionRouter,
  createInlineExecutor,
  withApprovalGatedShell, gateProviderExec,
  createSandboxExecutor, type SandboxHandle, isSandboxTransientError,
  WORKSPACE_BACKUP_DIR,
  createDeviceTunnelExecutor, type DeviceTransport,
  explainNativeToolReferenceError,
  devicePresence, parseDevicePresence, deviceChangeNotice, observeDevicePresence,
  deviceToolchainAnswer, freshDeviceToolchain,
  connectedDevices, deviceByName, deviceFleetAsk,
  effectiveDeviceMode, parseDeviceTier, parseSandboxCapability, parseSandboxReason,
  sandboxReasonFix, sandboxCause, describeGpuNodes,
  DEVICE_PRESENCE_CONFIG_KEY, DEVICE_TOOLCHAIN_TTL_MS,
  DEVICE_TIERS, DEVICE_SANDBOX_CAPABILITIES, DEVICE_SANDBOX_REASONS,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
  type DeviceToolchain, type DeviceFleet, type DeviceFleetEntry,
  type DeviceTier, type DeviceMode, type DeviceSandboxStatus,
  type DeviceSandboxCapability, type DeviceSandboxReason,
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_PROBED_CAPABILITIES,
  TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
  DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  WORKSPACE_HAS_NO_OWNER, isWorkspaceUnattachedError,
  SEVERAL_DEVICES_CONNECTED, isDeviceAmbiguityError,
  SANDBOX_UNAVAILABLE, isSandboxUnavailableError,
  DEVICE_UNKNOWN_METHOD, isDeviceUnknownMethodError, DEVICE_TOKEN_ROTATION, DEVICE_TOKEN_ROTATION_ACK,
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_CANCEL_VERSION_REFUSAL, DEVICE_EXEC_ACK_METHOD,
  DEVICE_DUPLICATE_REQUEST, DeviceCancelResultSchema, nextDeviceRequestId,
  DEVICE_CANCEL_MISPAIRED, parseDeviceCancelAnswer,
  DEVICE_PTY_OPEN_METHOD, DEVICE_PTY_INPUT, DEVICE_PTY_RESIZE, DEVICE_PTY_CLOSE,
  DEVICE_PTY_OUTPUT, DEVICE_PTY_EXIT, DEVICE_PTY_MAX_AXIS,
  type DeviceCancelResult,
  DeviceSocketHub, deviceIdFromSocket,
  DEVICE_KEEPALIVE_PING, DEVICE_KEEPALIVE_PONG,
  type DeviceSocket, type DeviceSocketCtx,
  DeviceRequestLedger, initDeviceInflightTable,
  type ClaimedDeviceRequest, type SweptDeviceRequest,
  type DeviceCancelOutcome, type DeviceTransferOutcome,
  DeviceTerminalHub, terminalFromSocket,
  type TerminalHolder,
  createNimbusExecutor, createNimbusWorkspaceExecutor, nimbusSessionShell,
  type NimbusExecutorOpts, type NimbusWorkspaceExecutorOpts, type NimbusSandboxHandle,
  type NimbusStartResult, type NimbusExecOptions, type NimbusExecResult, type NimbusPortInfo,
  EXECUTOR_CAPABILITIES, NO_TIMER_DEADLINE_MS,
  type ExecutorCapability, type ExecutorKind, type ExecutorProvider,
  type ExecutorLifecycleStatus, type ExecutorStatus,
  type ExecutorInfo, type ExecutionRouter, type InlineExecutorDeps, type ResourceLimits,
  commandResult, CommandResultSchema, COMMAND_RESULT_TYPE, type CommandResult, formatExecResult, answeredRefusal, type ExecOutcome, STDOUT_LABEL, STDERR_LABEL, NO_OUTPUT,
  BoundedOutput, COMMAND_OUTPUT_LIMITS, type CommandOutputLimits, type OutputSpill, type SpillOutcome,
  unsandboxedCommandEnvironment,
  TurnEscalationLedger, ESCALATION_OUTCOMES,
  type EscalationDecision, type EscalationOutcome, type EscalationSnapshot,
  createParentExecutor, createParentWorkspaceVfs, sandboxFiles, nimbusSessionFiles, deviceFiles,
  type ParentWorkspaceHandle, type ParentExecResult, type DeviceFileConsent, type DeviceFileScope,
  type ParentRpcResult, type ParentRpcWrite, type ParentRpcError,
} from './execution/index';

export { currentWorkMode, inWorkMode, runWorkModeInvocation, permitInPlan, requireBuild, requireWorkModePermission, toolsInWorkMode, toolsForInvocation, providersInWorkMode } from './execution/work-mode';

// Client-safe only: the Nimbus workspace host is exported from
// `@kinu.run/core/workspace` so a browser bundle cannot pull in the server runtime.
export {
  canonicalWorkspacePath, workspacePath, LEGACY_WORKSPACE_ROOT, WORKSPACE_ROOT,
} from './vfs/workspace-path';

export {
  agentHome, agentArtifactDirectory, agentTmpRoot, agentCred, agentIdentity,
  provisionAgentHome, confineAgentTmp, releaseAgentHome, restoreAgentTmpConfinements, settleWorkspaceRoot,
  subordinateAgentName, headAgentName,
  MAIN_AGENT, AGENT_HOME_MODE, AGENT_TMP_MODE, SESSION_UID, AGENT_UID_FLOOR,
  type AgentIdentity, type HomeRootVfs, type RootMoveVfs, type TmpConfiner,
} from './vfs/agent-home';

export type {
  WorkspaceAgent, WorkspaceAgentPlane, WorkspaceBundle, WorkspaceOptions,
  WorkspaceSession, WorkspaceVFS,
} from './vfs/nimbus-workspace';

export {
  writeWorkspaceSoul, createWorkspaceForkSink, createWorkspaceForkSource, workspaceArchiveFiles, archiveFileTree,
} from './vfs/workspace-planes';

export {
  makeVfsError, isVfsError, ERRNO, withVfsErrorHint, vfsAddressingHint,
  type VfsError, type VfsErrorCode,
} from './vfs/errno';

export { observeWrites, type WriteEvent, type WriteObserver } from './vfs/observe';

export { ensureDir } from './utils/vfs-helpers';

export { mossaicVfs, type MossaicClient, type MossaicVfs, type MossaicStat, type MossaicChild } from './vfs/mossaic-vfs';

export {
  sharedDriveMount, SHARED_SKILLS_DIR, DRIVE_SKILLS_DIR, DRIVE_BLUEPRINTS_DIR, DRIVE_RESERVED_DIRS,
  SHARED_DRIVE_UNCLAIMED, SHARED_DRIVE_UNBOUND,
} from './vfs/shared-drive';

export { packZip, unpackZip, looksLikeZip, type ZipEntry } from './utils/zip';

export {
  normalizeDrivePath, listDrive, makeDriveFolder, renameDriveEntry,
  deleteDriveEntry, markAsSkill, addSkill, receiveDriveUpload, packDriveFolder, driveFailure,
  DriveListingSchema, MarkedSkillSchema, DriveUploadTargetSchema,
  type DriveEntry, type DriveListing, type MarkedSkill, type DriveFailure, type DriveUploadTarget, type DriveUploadOutcome,
} from './skills/drive';

export {
  withMountTable, standardMounts, EXECUTOR_MOUNTS, MOUNT_EXECUTORS, RESERVED_REFERENCE_ROOTS,
  readBoundedWithVfsOps, readTailWithVfsOps, listWithVfsOps,
  type VfsMount, type MountableProvider,
  type VfsNativeMutations, type VfsNativeReads, type VfsListedEntry,
} from './vfs/mounts';

// File checkpoints
export {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_NO_DEVICE, CHECKPOINTS_UNAVAILABLE_NO_GIT, CHECKPOINTS_UNCONFIGURED, summarizeRestorePlan,
  checkpointAvailability, deviceHistoryNote, fileCheckpointListing,
  CheckpointAvailabilitySchema, FileCheckpointEntrySchema, FileRestorePlanSchema, FileRestoreResultSchema,
  type FileCheckpoints, type FileCheckpointReads, type CheckpointTurnMeta, type CheckpointAvailability,
  type FileCheckpointEntry, type FileCheckpointListing, type FileRestoreChange, type FileRestoreKind,
  type FileRestorePlan, type FileRestoreResult, type DeviceCheckpointHint,
} from './checkpoints/types';

export { deviceFileCheckpoints, type DeviceRpcHub, type DeviceCheckpointsInput } from './checkpoints/device';

// Shadow-git store format: cross-engine contract, pinned by the pc-agent parity test.
export {
  CHECKPOINT_REF_PREFIX, CHECKPOINT_WORKDIR_MARKER, CHECKPOINT_EXCLUDES,
  checkpointSubject, parseCheckpointSubject, checkpointRefTimestampMs,
  checkpointReason, diagnoseStaging, type StagingDiagnosis,
} from './checkpoints/format';

// Semantic memory
export {
  reciprocalRankFusion,
  createCloudflareVectorStore,
  createWorkersAIEmbedder,
  createNoopVectorStore,
  VECTOR_BACKEND_COOLDOWN_MS,
  type VectorStore,
  type Embedder,
  type VectorizeIndex,
  type VectorRecord,
  type VectorMatch,
  type IndexedChunk,
  type VectorSearchHit,
} from './memory/vector-store';

export {
  hybridSearch,
  memorySnippetRehydrator,
  type SnippetRehydrator,
  type LexicalHit,
  type HybridHit,
  type LexicalSearchFn,
  type HybridSearchOptions,
} from './memory/hybrid-search';

// Memory writes
export { memoryBytes } from './memory/note';

export { appendMemoryNote, parseMemoryNotes, readMemoryTail, MEMORY_TAIL_MAX_CHARS, type MemoryNote } from './memory/note';

export {
  ConversationSearchStore, invalidateConversationSearchIndex,
  type ConversationSearchHit, type ConversationScrollMessage,
  type ConversationScrollResult, type ConversationSummary,
} from './memory/conversation-search';

// Top-K recent agent_facts render into the system prompt every turn.
export {
  initFactsTable, createFactsStore, renderFactsBlock, searchFacts, normalizeFactKey,
  type Fact, type FactsStore, type FactSearchHit, type FactUpsertResult,
} from './memory/facts';

export {
  JsonValueSchema, JsonObjectSchema, JsonArraySchema,
  parseJsonValue, parseJsonObject, parseJsonArray, safeJsonParse, decodeJsonValue, projectJsonValue, nonEmptyString,
  type JsonPrimitive, type JsonObject, type JsonValue,
} from './utils/json';

// Sleep-time compute
export {
  runSleepTimeCompute, applySleepTimeUpdate,
  SleepTimeUpdateSchema,
  SLEEP_TIME_CADENCE,
  sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type SleepTimeInput, type SleepTimeUpdate, type SleepTimeTrigger, type SleepTimeTurn, type SleepTimeWindow,
} from './memory/sleep-time-compute';

// Run-event log (`run_events`), separate from the EventsHub `agent_log`.
export type {
  RunEvent, RunEventBase, RunEventInput, RunEventType, StepCost,
  CompletionGateRecord, TurnSteeringRecord, TurnSteeringTrigger, CraftCycleRecord,
  ExecutionRecoveryRecord,
  ContextEditVia, ContextEditStatus, ContextEditBoundary,
  CacheHitStats, StepTelemetry,
} from './events/index';

export {
  FAILURE_WITHOUT_ERROR,
  CONTEXT_EDIT_VIA, CONTEXT_EDIT_STATUSES, CONTEXT_EDIT_BOUNDARIES,
  initRunEventTables,
  parseStoredRunEvent,
  RunEventSchema,
  recordModelOperations,
  RunEventRecorder,
  boundRunEventQuery,
  RUN_EVENT_LIMIT_DEFAULT,
  RUN_EVENT_LIMIT_MAX,
  summarizeSteps,
  CACHE_HIT_EMA_ALPHA,
  SPEND_SOURCES,
  SPEND_SOURCE_LABEL,
  SPEND_SOURCE_DETAIL,
  WORKSPACE_RUN_ID,
  MODEL_OPERATION_KINDS,
  MODEL_OPERATION_PHASES,
  MODEL_OPERATION_OUTCOMES,
  beginModelOperation,
  buildModelCallEvent,
  type ModelCallReport,
  type ModelCallSpend,
  type ModelCallSink,
  type ModelOperation,
  type ModelOperationEvent,
  type ModelOperationKind,
  type ModelOperationOutcome,
  type ModelOperationPhase,
  type ModelOperationSink,
  type SpendSource,
  type SpendTally,
  type DeferredRunEvent,
  type RunEventListener,
  type RunEventQuery,
  type BoundedRunEventQuery,
} from './events/index';

// Durable retry outbox; spec: `events/outbox.ts`.
export {
  scheduledOutbox,
  type Outbox,
  type OutboxDeadLetter,
  type OutboxDisposition,
  type OutboxDrainResult,
  type OutboxRecord,
  type ScheduledOutboxPolicy,
} from './events/index';

// EventsHub. Spec: docs/ARCHITECTURE.md "Events and ingress".
export * from './events/hub/index';

// Ingress
export * from './events/ingress/index';

// Swarm
export * from './strategy/index';

// Eval harness
export * from './eval/index';

// Bench harness: pure math; the runner lives in scripts/bench.ts.
export * from './bench/index';

// Curriculum
export * from './curriculum/index';

// Providers. Secrets stay inside UserDO and never enter the provider layer.
export * from './providers/index';

export type { Credential, BearerCredential, OAuthCredential, OpenAICompatCredential } from './credentials/store';

// Credential store policy
export {
  createCredentialCipher,
  isSealedCredential,
  type CredentialCipher,
  type CredentialEncryptionEnv,
} from './credentials/envelope';

export {
  credentialToHeaders,
  type CredentialHeaders,
} from './credentials/headers';

export {
  validateCredential,
  validateCredentialKey,
} from './credentials/validate';

// Plan review
export {
  MAX_PLAN_ANNOTATIONS_BYTES,
  MAX_PLAN_CONTENT_BYTES,
  PlanReviewActions,
  PlanReviewStore,
  PlanReviewSchema,
  admitPlanReviewAnnotations,
  applyPlanEdits,
  formatPlanWithLineNumbers,
  initPlanReviewTable,
  listPendingPlanReviews,
  planReviewAwaitingDecision,
  workModeUnderReview,
  planTitle,
  validatePlanEdits,
  type PlanDecisionOutcome,
  type PlanEdit,
  type PlanAnnotationMathTarget,
  type PlanAnnotationTextPosition,
  type PlanReview,
  type PlanReviewAnnotation,
  type PlanReviewDecision,
  type PlanReviewResult,
  type PlanReviewStatus,
  type PlanReviewStoreOptions,
  type SubmitPlanToolDeps,
} from './plans/index';

export {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  DEV_IDENTITY_HEADER,
  DEVICE_CONNECT_PATH,
  DEVICE_TERMINAL_PATH,
  ORCHESTRATOR_AGENT_SLUG,
} from './cloud-wire';

// Platform facts: prose cites an entry by its id and never restates the number.
export {
  PLATFORM_CATALOG,
  PLATFORM_FACT_IDS,
  PROVEN_LABELS,
  injectableFaults,
  platformFact,
  platformFactEntries,
  type BoundsKind,
  type EvidenceLabel,
  type LimitUnit,
  type PlatformFact,
  type PlatformFactEntry,
  type PlatformFactId,
  type PlatformMeasurement,
  type PlatformObservable,
  type PlatformQuantity,
} from './platform-catalog';

// Terminal chrome vocabulary, shared so depictions of the TUI cannot drift.
export {
  CHANGE_KIND_GLYPH,
  composerVisibleRows,
  TUI_ADVERTISED_PRESET_BINDINGS,
  TUI_ADVERTISED_HINTS,
  TUI_COMPOSER_PLACEHOLDER,
  TUI_COMPOSER_STEERING_PLACEHOLDER,
  TUI_MARKS,
} from './tui-presentation';

// Safety
export {
  reviewCommand,
  formatApproval,
  gatedGrants,
  formatApprovalGrant, holdsGrant,
  parseApprovalGrant,
  approvalGrants,
  gateExec,
  grantsAreSubset,
  resolveInheritedGrants,
  createInheritedApprovalPolicy,
  STRICT_NO_CHANNEL_POLICY,
  type ApprovalDecision,
  type ApprovalRuleHit,
  type ApprovalResult,
  type ApprovalHarm,
  type ApprovalGrant,
  type ShellApprovalRequest,
  type ShellApprovalOutcome,
  type ShellApprovalPolicy,
  type InheritedApprovalSource,
  type DeferredApprovalChannel,
  type ApprovalSpend,
  EGRESS_PLACEHOLDER_PREFIX,
  EGRESS_PLACEHOLDER_BYTES,
  PLACEHOLDER_BODY_LENGTH,
  isEgressPlaceholder,
  EGRESS_EXECUTOR,
  grantedEgressBindings,
  findEgressPlaceholders,
  egressSecretRule,
  parseEgressSecretRule,
  egressHostMatches,
  reviewEgressBinding,
  egressBindingAction,
  planEgress,
  scrubText,
  createScrubStream,
  type EgressSecretBinding,
  type EgressRequestFacts,
  type EgressSubstitution,
  type EgressPlan,
  type ScrubReplacement,
  DeferredApprovalQueue,
  DeferredApprovalStore,
  initDeferredApprovalsTable,
  queuedActionMessage,
  deniedActionMessage,
  decisionWakeMessage,
  DEFERRED_APPROVAL_SIGNAL,
  DENIAL_STANDING_MS,
  type DeferredApproval,
  type DeferredApprovalStatus,
  type DeferredApprovalAnswer,
  type DeferredApprovalVerdict,
  type DeferredApprovalNotice,
  initEgressVaultTables,
  listEgressSecrets,
  putEgressSecret,
  revokeEgressSecret,
  resolveEgressInjection,
  rewrapEgressSecrets,
  type EgressSecretSummary,
  type PutEgressSecretInput,
  type EgressInjection,
  type EgressInjectionResult,
  type EgressVaultDeps,
  ownerCaller,
  OwnerCapabilityUnavailableError,
  CapabilityDeniedError,
  initWorkspaceCapabilityTables,
  pendingCapabilityReconcile,
  armCapabilityReconcile,
  clearCapabilityReconcile,
  workspaceCapabilityHash,
  freshWorkspaceCapability,
  commitWorkspaceCapability,
  revokeWorkspaceCapability,
  requireTier,
  type CapabilityFloor,
  type WorkspaceCapability,
  type UserCaller,
  type ResolvedCaller,
  type OwnerCapabilityEnv,
  type CapabilityDenialReason,
  argumentDigest,
  sha256Hex,
  stableStringify,
  InstructionApprovalStore,
  initInstructionApprovalsTable,
  instructionDigest,
  trustOfInstructionApprovals,
  admitInstructionDecision,
  type InstructionTrust,
  type InstructionDecision,
  type InstructionApproval,
  type InstructionTrustResolver,
  type VerifiedInstructionTrust,
  type AdmittedInstructionDecision,
  DeviceConsentRegistry,
  DeviceConsentStore,
  initDeviceConsentRequestsTable,
  DEVICE_CONSENT_DENIED,
  DEVICE_CONSENT_UNANSWERED,
  DEVICE_CONSENT_TIMEOUT_MS,
  DEVICE_CONNECT_DISCLOSURE,
  summarizeDeviceAction,
  type DeviceConsentDecision,
  type DeviceConsentAnswer,
  type DeviceActionSummary,
  type DeviceConsentRequest,
  type PendingDeviceConsent,
  type PendingConsentRow,
  type DeviceConsentNotice,
  SECRET_PATTERNS,
  scanText,
  countDetections,
  secretSightings,
  type SecretPattern,
  type SecretFinding,
  type SecretSighting,
} from './safety/index';

export {
  refusedHostname,
} from './safety/egress-destination';

// Utils
export { fnv1a64, Fnv1a64 } from './utils/fnv1a';

export { nanoid } from './utils/nanoid';

export { abortCause } from './utils/abort';

export { hmacSha256Hex, randomToken, timingSafeEqual } from './utils/crypto';

export { labelSigner, type LabelSigner, type LabelSignerEnv } from './utils/label-signer';

export { shellQuote } from './utils/shell';

export {
  wilsonInterval, scoreInterval, lossInterval, formatScoreInterval, seededRandom,
  type ScoreInterval,
} from './utils/stats';

export { isoDate, today, nowMs } from './utils/date';

// Branching heads
export type {
  HeadId, HeadBudget, HeadInput, HeadReport, HeadReportStatus, HeadUnsettledStatus,
  HeadStep, HeadStepToolCall, HeadRunView, HeadRunHeadView,
  Evidence, Decision, ArtifactRef,
  SplitRequest, MergeResult, HeadScore, MergeStrategy,
  HeadFileChange, HeadFileChangeSet,
  SerializedMessage,
} from './heads/index';

export {
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget, budgetExhausted,
  headStatusUnsettled, storedHeadReportStatus,
  initHeadsTables,
  HeadJournal, type HeadJournalRow, type LiveHeadRun, type AbandonedHeadRun,
  LiveHeadJournal, type AnnounceHeadActivity,
  type HeadStreamFrame, type HeadStreamKind,
  type ReportHeadDelta, type PublishHeadStream,
  reconcileInterruptedForks, forkInterruptedWake, jobRedriveResumeGate, resumableForkRoots,
  FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
  HeadController, type HeadRuntime, type HeadGrounding, type SpawnedHead, type MergeLLMFn,
  type SplitPhaseEvent,
  type HeadJournalPort,
  MergeOutputSchema, DecisionSchema, type MergeOutput,
  // Resolved here so both backends resolve it identically.
  headMergeLLM,
  type HeadMergeModelBinder, type HeadMergeModelBinding, type HeadMergePolicyDeps,
  extractFinalText, synthesizeHeadSummary, headProducedFindings,
  HeadCapture, runHeadInference, buildHeadAccumulatorTools,
  buildHeadSystemPrompt, buildHeadMessages, withHeadCaptureRecording,
  type HeadInferenceDeps, type HeadWorkspaceLayout,
  buildHeadToolSet, HEAD_BUILTIN_TOOLS, keepBuiltins,
  type HeadToolDeps, type HeadSplitRequest, type HeadSplitResult,
  HeadFileChanges,
} from './heads/index';

// Background jobs
export {
  BackgroundJobStore, initBackgroundJobsTable, serializeJobResult, withBackgroundThreshold, withSpawnDetach,
  backgroundJobNotice,
  isBackgroundHandle, SPAWN_STARTED_OPTION, readSpawnStarted,
  DEVICE_REQUEST_OPTION, readDeviceRequestChannel, DeviceRequestOwnership,
  BackgroundJobRunner, JobNotResumable, EVICTION_INTERRUPT_ERROR, BACKGROUND_POLICY, MAX_CONCURRENT_DETACHED_JOBS,
  invocationBackgroundPolicy,
  backgroundJobWakeTrigger, BACKGROUND_FIBER_PREFIX,
  type BackgroundJob, type BackgroundJobStatus, type BackgroundHandle, type BackgroundRefusal, type ThresholdDeps,
  type BackgroundPolicy, type DetachOutcome, type InvocationSurface,
  type BackgroundJobRunnerDeps, type JobResumer, type JobClaim, type DeviceRequestChannel,
} from './jobs/index';

// Tasks
export {
  TaskListStore, initTaskListTable, TASK_STATUSES, MAX_TASK_TITLE_CHARS,
  type AgentTask, type AgentTaskTree, type TaskStatus,
  type TaskAddResult, type TaskAddRejection,
} from './tasks/store';

export { withTaskPlan, bindTaskPlan, type TaskPlan, type TaskPlanContext } from './tasks/plan-scope';

export {
  TaskReminders, TASK_REMINDER_EVENT,
  taskReminderIdempotencyKey,
} from './tasks/reminder';

// Orchestration
export {
  TurnAccumulator,
  type StepLike, type ToolResultLike, type TurnSinks,
} from './orchestrator/turn-accumulator';

export { readWorkspaceWork, hasWorkspaceWork, actorReadHandle } from './read-models/workspace-work';

export type { WorkspaceWork, OwnedPlan, OwnedTask, WorkspaceWorkOwner } from './read-models/workspace-work';

export {
  AgentOrchestrator, type AgentOrchestratorDeps,
  type TurnContinuity,
} from './orchestrator/agent-orchestrator';

export { ActorSession, type ActorSessionOptions, type ActorTurnLease, type ActorExecutionInput, type ActorExecutionResult } from './orchestrator/actor-session';

export {
  ChatSession, turnInputMessage, partialFlushCadence, type PartialFlushCadence, type PartialFlushSignal, type ChatSessionOptions, type ChatSessionPorts, type ChatTransport, type ChatTurnInput,
  type PreparedTurn, type OwedTerminalEffectsInput, type SessionEvent, type SendOptions, type SendLandingWaiter,
} from './orchestrator/chat-session';

export { startActorTurn, type ActorTurnInput } from './orchestrator/actor-turn';

export {
  ActorClaimStore, initActorClaimTables, programIdentityOf, verifyClaimedProgram,
  type ActorProgramIdentity, type ActorTurnClaim, type StoredActorClaim,
  type ContextRevision, type ConsumedContext, type ClaimOutcome, type ClaimRecovery,
} from './orchestrator/actor-claims';

export { prepareActorProgram, type ActorTurnProgram } from './orchestrator/actor-program';

export { USER_MESSAGE_SIGNAL_KIND } from './types/signals';

export {
  TurnSteering, isFailingToolResult, TURN_STEERING_HEADER,
  IDENTICAL_CALLS_BEFORE_STEER, CONSECUTIVE_FAILURES_BEFORE_STEER,
  STEPS_WITHOUT_PROGRESS_BEFORE_STEER,
  type TurnProgressInputs,
} from './orchestrator/turn-steering';

export { CraftCycle } from './orchestrator/craft-cycle';

export {
  CompletionGate, observeCompletionState, completionGateText,
  COMPLETION_GATE_EVENT, COMPLETION_GATE_HEADER, COMPLETION_PROBE_COMMANDS,
  COMPLETION_TASK_ECHO_MAX_CHARS,
  type TurnCompletionFacts,
} from './orchestrator/completion-gate';

export {
  assembleTurnMessages, measureCompactionTrigger,
  type TurnContextInput, type CompactionTriggerReader, type MeasuredCompactionTrigger,
  type TurnAdmission,
} from './orchestrator/turn-context';

export {
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery, creditedTurnId,
  classifyRunEnd, RUN_END_REASONS, TOOL_CALLS_PENDING, OUTPUT_LIMIT_REACHED, TURN_ENDED_MID_WORK,
  owesOutputLimitContinuation, OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT,
  type CompactionTriggerState, type SettledTurn, type OutputContinuationFacts,
  type RunEndReason, type RunEndFacts, type RunEndClassification,
} from './orchestrator/turn-lifecycle';

export {
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  SCAFFOLD_HISTORY_DEFAULT_LIMIT, SCAFFOLD_HISTORY_MAX_LIMIT,
  SCAFFOLD_HISTORY_DEFAULT_MESSAGE_CHARS, SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS,
  SCAFFOLD_HISTORY_MAX_PAGE_CHARS,
  type ScaffoldBridgeOpts, type ScaffoldHistoryQuery, type ScaffoldHistoryReader,
  type ScaffoldHistoryEntry, type ScaffoldHistoryPage,
} from './orchestrator/scaffold-host';

export { createScaffoldCandidateSurface, type ScaffoldCandidateBinding } from './evolution/scaffold-candidate';

export { captureOperationProfile, currentOperationProfile, resolveOperationProfile, runOperationProfile,
  withOperationProfile, operationProfileStream, type OperationProfile } from './profiles/operation';

export { createRoutedModelLane } from './profiles/model-lane';

export {
  BACKGROUNDABLE_TOOLS, resumeBackgroundJob, harvestBackgroundJob, type SwarmHarvestDeps,
} from './orchestrator/background-tools';

export {
  wrapToolsForBackground, CONFINED_BACKGROUNDABLE_TOOLS, type BackgroundableTool,
} from './jobs/background-wrap';

export { createDurableMctsSession } from './orchestrator/mcts-session';

export {
  resolveTurnSkills, steerSkillsBlock, filterToolNamesBySkills, filterToolSetBySkills,
  renderFactsForTurn, type TurnSkillsConfig, type TurnSkillSurface,
} from './orchestrator/turn-surface';

export { ModelCatalogSession, resolveEffectiveModelSpec } from './orchestrator/model-catalog';

export {
  serializeContentForHeads, narrowInheritedRole,
  inheritedContextFromHistory, inheritedContextFromTranscript,
  inheritedContextOmissionNote,
} from './orchestrator/heads-support';

// Skills
export {
  parseSkillFile, stringifySkillFile, skillNameProblem,
  discoverSkills, readSkillFile, readSkillBody, skillPath, compareSkillNames, skillBodyChars,
  BUILTIN_SKILLS, BUILTIN_SKILL_HEADERS, BUILTIN_SKILL_NAMES,
  resolveActiveSkills, extractExplicitInvocations, admitSkillsIndex, admitActiveSkills,
  renderActiveSkillsSection, renderSkillsIndexSection, skillIndexLine, unreadSkillLine,
  unionAllowedTools, toolAllowedBySkills, trustedActiveSkills,
  SkillError, SKILLS_DIR, SKILL_FOLDER_FILE,
} from './skills/index';

export type {
  SkillHeader, ParsedSkill, DiscoveredSkill, ActiveSkill, SkillBodyRef,
  SkillsIndex, SkillSource, ActiveSkillSet, ActivationReason,
  SkillParseResult, SkillErrorCode,
  SkillsVfs, DiscoverOpts, SkillsDiscovery, UnreadSkillFile,
  LoadActiveSkillsOpts, ActivatedSkill,
} from './skills/index';

// GEPA (Agrawal et al., ICLR 2026, arxiv 2507.19457)
export {
  applyScaffoldDecision, createJsonJudge, createLlmJsonJudge, getShadowStatus, listScaffoldVersions,
  previewScaffoldLive, proposeScaffold, queueTurnShadowTrial, shadowTrialPlan, runQueuedShadowTrials,
  runScaffoldCaptureText, runScaffoldGepaOptimization, runScaffoldOnce,
  advancePromptSectionLane, proposeMeasuredPromptSection,
  type GepaOptimizationResult, type JsonGenerator, type ScaffoldControl,
  type ScaffoldDecisionResult, type ScaffoldReplayContext, type ScaffoldSurface,
  type ScaffoldVersionView, type ShadowStatus,
  type PromptSectionOptimizationResult, type PromptSectionTrialResult,
  type PromptSectionLaneStep, type MeasuredSectionProposal,
} from './evolution/control';

// Continual refinement: each proposed edit routes to the authority that owns the artifact.
export {
  REFINEMENT_DISPOSITIONS, REFINEMENT_EDIT_KINDS, REFINEMENT_SCOPES,
  REFINEMENT_STAGES, REFINEMENT_TRIGGERS, RefinementProposalSchema,
  createRefinementStore, evolutionDebt, initRefinementTables, refinementRequestView,
  refinementStagingPath,
  type EvolutionDebt, type OpenRefinementInput, type RefinementDeps,
  type RefinementDisposition, type RefinementEdit, type RefinementEditKind,
  type RefinementProposal, type RefinementRequest,
  type RefinementRequestView, type RefinementRoute, type RefinementScope,
  type RefinementStage, type RefinementStore, type RefinementTrigger,
  type SettleRefinementPatch,
} from './evolution/refinement';

export { type RefinementLaneStep } from './evolution/refinement-lane';

export { listRefinements, refinementPass, requestOwnerRefinement } from './evolution/refinement-host';

export {
  REFINEMENT_DECISIONS, decideRefinementRoute, showRefinementRoute,
  type RefinementDecision, type RefinementDecisionInput, type RefinementDecisionResult,
  type StagedSkillResult, type StagedSkillView,
} from './evolution/refinement-skill';

export {
  runGepa, runScaffoldGepa, runSectionGepa,
  PROMPT_SECTION_TARGETS, findPromptSectionTarget,
  DEFAULT_GEPA_BUDGET,
  initGepaTables, startGepaRun, finishGepaRun,
  listGepaRuns, loadGepaCandidates, loadGepaParetoFront, makePersistingHooks,
} from './evolution/gepa/index';

export type {
  EvalInstance, MetricOutcome, GepaMetric, ReflectionLM,
  GepaCandidate, GepaConstraints, GepaBudget, GepaConfig,
  GepaIterationState, GepaProgressHooks, GepaResult,
  RunScaffoldGepaOpts, RunScaffoldGepaResult,
  RunSectionGepaOpts, RunSectionGepaResult,
  GepaRunSummary,
  GepaParetoEntry,
} from './evolution/gepa/index';

// Evolved prompt sections
export {
  activePromptSectionOverrides, firstPendingPromptSection,
} from './prompting/section-store';

export type { PromptSectionOverrides } from './prompting/section-templates';

// Layer gate
export {
  LAYERS, FAULTS, LOCKED_BASELINE,
  LOCALIZATION_OWN_MIN_PP, LOCALIZATION_OTHER_MAX_PP,
  createPipelineSubjects, SUBJECT_SOURCE,
  observePipeline, scoreAgainstBaseline, runLayerGate, lockBaseline,
  renderLayerGateReport, runFaultMatrix, renderFaultMatrix,
} from './layergate/index';

export type {
  Layer, Probe, PipelineSubjects, SubjectName,
  Baseline, LayerGateReport, LayerScore, Fault, FaultImpact,
} from './layergate/index';

// Backend conformance gate
export {
  BACKEND_CONFORMANCE, CONFORMANCE_PLANES, CONFORMANCE_PRODUCERS, CONFORMANCE_ROOTS, PLANE_UNIVERSE, WIRED,
  compareSurface, normalizeObservedTables, observedActionEnum, phantomCallables, wiredProducers,
  renderConformanceFindings,
} from './conformance/index';

export type {
  CapabilityStatus, ConformanceFinding, ConformanceFindingKind, ConformanceManifest,
  ConformancePlane, ConformanceReport, ConformanceRoot, ObservedSurface, RootStatuses,
} from './conformance/index';

// Read models
export {
  classifyEvolutionType, getRunTimeline, runEventToSpan, toolKindFor,
  RUN_TIMELINE_DEFAULT, RUN_TIMELINE_MAX,
} from './read-models/timeline';

export type { RunTimelineDeps, TimelineKind, TimelineSpan } from './read-models/timeline';

// The one bound a caller-supplied row count passes before SQL; CLI read models import it.
export { boundedInt } from './utils/bounds';

// The retry curve of every durable recovery lane; backends import it, never copy it.
export { recoveryBackoffMs } from './utils/recovery-backoff';

export { getRunEvents, getRunSummaries, listRuns } from './read-models/runs';

export type { RunListEntry, RunSummary } from './read-models/runs';

export { workspaceSpend } from './read-models/workspace-spend';

export type {
  ProducerSpend, SpendCoverage, WorkspaceSpend, WorkspaceSpendDeps,
} from './read-models/workspace-spend';

export {
  censusToolFailures, classifyToolFailure, toolFailureKey, toolFailurePartOfKey,
} from './read-models/tool-failures';

export type {
  ToolFailure, ToolFailureCensus, ToolFailurePart,
} from './read-models/tool-failures';

export {
  getExecutorDiff, getWorkspaceDiff, initWorkspaceBaselineTable, resetWorkspaceBaseline,
  walkWorkspaceTextFiles,
} from './read-models/workspace-diff';

export type { ExecutorDiffResult, WorkspaceDiffResult } from './read-models/workspace-diff';

export {
  diffLines, fileDiff, parseGitDiff, MAX_LINES_PER_FILE,
} from './vfs/diff';

export type { DiffLine, FileDiff, FileStatus, LineDiff } from './vfs/diff';

export {
  getExecutorFiles, readExecutorFile, sortDirEntries, executorFiles, writeExecutorFileOp,
  readExecutorFileBytes, statExecutorFile, renameExecutorPathOp, deleteExecutorPathOp,
  listEnvironments, normalizeDir, joinDir, parentDir,
  FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES,
  ExecutorFileUpload, ExecutorFileDownload, ChunkedUpload, pumpUploadChunks,
} from './read-models/files';

export type {
  DirEntry, ExecutorFileLookup, ExecutorRowLookup, ExecutorWriteResult,
  EnvironmentInfo, MountInfo,
} from './read-models/files';

export { inlineFileType } from './read-models/file-types';

export {
  readLatestSearchTree, readSearchTree, readSearchNodeDetail,
  type SearchNodeDetail, type SearchTreeRow,
} from './read-models/search-tree';

export { readExplorationCanvas, readExplorationRun } from './read-models/exploration-canvas';

export type { ExplorationCanvasRun } from './read-models/exploration-canvas';

export {
  activateMctsProgressActor, applyMctsProgress, createMctsProgressState,
} from './read-models/mcts-progress';

export type {
  MctsProgressOrder, MctsProgressStamp, MctsProgressState,
} from './read-models/mcts-progress';

export type { ForkRunParams, SearchRunParams } from './read-models/fork-params';

export { listForkRuns } from './read-models/fork-runs';

export type { ForkRunSummary } from './read-models/fork-runs';

export {
  listRecordCells, listRecordObjectives, readRecordCell,
} from './read-models/exploration-records';

export type {
  RecordCellSummary, RecordObjectiveSummary,
} from './read-models/exploration-records';

// The real writer is exported so cf-backend tests seed rows production would write.
export { initExplorationRecordsTable, recordExploration } from './strategy/records';

export type {
  ExplorationWrite, RecordCellHandle, RecordObjectiveHandle,
} from './strategy/records';

export { readNodeTranscript } from './read-models/node-transcript';

export type {
  NodeTranscriptView, NodeTranscriptCrumb, NodeTranscriptOrigin,
} from './read-models/node-transcript';

export { buildPendingActions } from './read-models/pending-actions';

export {
  listInstructionApprovals, readInstructionSource, openInstructionSource,
  previewInstruction, gatherApprovableInstructions,
} from './read-models/instruction-approvals';

export { InstructionApprovalDesk } from './read-models/instruction-desk';

export type {
  InstructionSourceKind, InstructionSourceMeta, InstructionSourceRow,
  InstructionSourceView,
} from './read-models/instruction-approvals';

export { getAgentStatus, getChatHistoryPage, getToolList } from './read-models/status';

export { mapPage, pageSchema, seekPage, SeekCursorSchema, StaleCursorError } from './session/page';

export type { Page, PageRequest, SeekCursor } from './session/page';

export {
  mergeTranscript, restoredRows, transcriptRole,
  PROGRAMMATIC_MESSAGE_ID_PREFIX, TURN_AUTHOR_METADATA_KEY, stampTurnAuthor, turnAuthor,
} from './utils/ui-message';

export type { TurnAuthor } from './utils/ui-message';

export type { PendingAction, PendingActionKind, PendingActionInputs } from './read-models/pending-actions';

export { buildWorkspaceOverview, overviewHeadline, rosterActivity, WorkspaceOverviewSchema } from './read-models/workspace-overview';

export type { RosterActivity, WorkspaceHeadline, WorkspaceOverview, WorkspaceOverviewSlate, WorkspaceStatus } from './read-models/workspace-overview';

export type {
  AgentStatus, AgentStatusDeps, ChatHistoryEntry, ToolListEntry,
} from './read-models/status';

export {
  cancelBackgroundJob, cancelCurrentWork, clearBackgroundJobs, dismissBackgroundJob,
  jobResult, listBackgroundJobs, retryBackgroundJob,
} from './read-models/background-jobs';

export type {
  BackgroundJobControl, BackgroundJobPlaneDeps, CancelWorkDeps, CancelWorkOutcome, RetryOutcome,
} from './read-models/background-jobs';

export {
  getAlwaysActiveSkills, getEvolutionConfig, getMctsConfig, getReasoningEffort,
  getShellApprovalMode, getShellApprovalGrants, revokeShellApprovalGrants,
  getStoredModelSpec, setAlwaysActiveSkills, setEvolutionConfig,
  setMctsConfig, setModel, setReasoningEffort, setShellApprovalMode,
} from './read-models/config-plane';

export type {
  EvolutionConfigView, MctsConfigView, SetModelDeps,
} from './read-models/config-plane';

// Advisor
export {
  ADVISOR_EVENT_TYPE,
  ADVISOR_NOTE_MAX_CHARS,
  ADVISOR_SEVERITIES,
  ADVISOR_CLASS_LABEL,
  AdvisorRowDataSchema,
  ADVISOR_SEVERITY_LABEL,
  ADVISOR_SEVERITY_METADATA_KEY,
  ADVISOR_SIGNAL_KIND,
  CONTENT_FREE_NOTES,
  DEFAULT_ADVISOR_MIN_SEVERITY,
  ADVISOR_DEDUPE_WINDOW,
  ADVISOR_HEADER,
  advisorSignalText,
  ADVISOR_LANE_FIBER,
  reviewRecordedTurn,
  AdvisorRecoverySnapshotSchema,
  buildAdvisorPrompt,
  isAdvisorSeverity,
  isContentFree,
  isDuplicateNote,
  judgeNote,
  normalizeNote,
  parseAdvisorReply,
  reviewCompletedTurn,
  type AdvisorDisposition,
  type AdvisorRecoverySnapshot,
  type AdvisorNote,
  type AdvisorSeverity,
  type AdvisorNoteClass,
  type AdvisorRowData,
  type NoteVerdict,
  type SuppressionRule,
} from './advisor/review';

export {
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
} from './read-models/evolution-views';

export type { EvolutionChangelogView, TakePickDeps } from './read-models/evolution-views';

// Profile catalogs
export {
  TIER_IDS, TierIdSchema, tierIdsOf, isTierId, ROLE_ID_RE,
  isValidRoleId, validateProfileCatalog, validateProfileCatalogEnvelope,
  profileCatalogCanonical, profileCatalogDigest, deriveRoleLabel, effectiveRoleCatalog,
  BUILTIN_ROLE_DEFINITIONS, BUILTIN_PROFILE_CATALOG,
  ProfileCatalogEnvelopeSchema,
} from './profiles';

export type {
  TierId, BuiltinTierId, BuiltinRoleId, RoleId,
  TierAssignment, TierAssignments, RoleDefinition, RoleCatalog, ProfileCatalog,
  ProfileAuthority, ProfileCatalogEnvelope,
} from './profiles';

export {
  resolveModelRoute,
  loadProfileAuthorityInputs, resolveTurnProfile, resolveAgentTurnProfile, resolveRoutingProfile,
  type ProfileAuthorityInputs, type ProviderCatalogSnapshot, type TierSource,
  type ResolveTurnProfileInput, type ResolveAgentTurnProfileInput, type ResolvedTurnProfile,
  type ModelRoutePolicy, type ProfileRoutedSource, type ModelRouteResolution,
  type FixedTierSource,
  DEFAULT_ROLE_ID,
  buildProviderCatalogSnapshot, ProviderListingCache,
  type ProviderListing, type ProviderCacheOutcome, type ProviderSnapshotRead,
  changeRoleAsOwner,
  type RoleChangeActor, type RoleChangePolicy, type RoleChangeOutcome,
  type RoleChangeRefusal, type RoleStateStore,
} from './profiles';

export type { ReasoningEffort } from './strategy/effort';

export { REASONING_EFFORTS, REASONING_EFFORT_FOR_STAGE } from './strategy/effort';

export type { NamedSwarmPreset, SwarmNodeAssignment } from './strategy/swarm';

export { SWARM_PRESET_DOCTRINE } from './strategy/swarm';

export { fmtPct, fmtTokens, fmtUsd, formatBytes, shortAge, timeAgo } from './utils/format';

export { classifyTransientDO, retryTransientDO, type DOTransientClass } from './utils/do-rpc';

export {
  type ActivitySnapshot, type ExecutorCommandResult, type ForkNode, type ForkNodeLifecycle,
  type MemoryEntry, type PendingConsent, type Rpc, type SubordinateActivityEvent,
  type TabPresence, type ToolInfo,
} from './protocol';

export { resumeIndexFromLastEventId } from './protocol/run-events-cursor';

export { buildTree, explorationForkTree, type MctsRow } from './read-models/fork-tree-rows';

export {
  executorLabel, executorSortKey, isActiveExecutionDevice, isExecutorActive,
  pickDefaultExecutor, releaseSubstrate, type ExecutorAvailability, type ReleaseSubstrate,
} from './read-models/executors';

export {
  BUSY, LINE_MODE_LABEL, LineTerminalState, type TerminalLane, type TerminalPaneOutput,
  type TerminalWriter, clearBusy, feedInput, terminalLane, writeOutputRow, writePrompt,
} from './execution/terminal-lane';

export {
  WORKSPACE_TERMINAL_PATH, WORKSPACE_TERMINAL_TAG, WorkspaceTerminalInputSchema, WorkspaceTerminalOutputSchema,
  isWorkspaceTerminal,
} from './execution/workspace-terminal';

export {
  type WorkspacePreviewHost, type WorkspacePreviewUrl, buildWorkspacePreviewHost, parseWorkspacePreviewLabel,
} from './preview/nimbus-preview-host';

export {
  buildSlateShareHost, parseSlateShareLabel, type SlateShareLabel,
} from './preview/slate-share-host';

export {
  PREVIEW_SANDBOX, containPreviewResponse, extractPreviewUrl, hostOf, isPreviewHostRequest,
  isPreviewUrl, previewHostSuffix, previewSuffixMetaName, sandboxPreviewLabelOf,
  type PreviewHostEnv, type PreviewSuffixEnv, type SandboxPreviewLabel,
} from './preview/preview-origin';

export {
  reconcilePreviewPorts,
  type ExecutorPortRefresh, type ExposedPortList, type PinnedPreviewPort, type PreviewPortState,
} from './preview/preview-ports';

export {
  sandboxPreviewExposed, sandboxPreviewExposures,
  type SandboxPreviewClaim, type SandboxPreviewExposures,
} from './preview/preview-exposures';

export {
  err, escapeHtml, fileResponseHeaders, firstResponse, json,
  readBounded, readBoundedStream, reoriginateRequest, requestUrl, safeJson,
} from './http/http';

export { KINU_USER_AGENT, kinuUserAgent } from './utils/user-agent';

export { PRIVATE_NO_STORE, publicHtmlHeaders, withAppSecurityHeaders } from './http/security-headers';

export { ingressAdmitted, ingressDenied, peerIp } from './http/ingress-budget';

export {
  CLI_DIST_PATHS, CLI_RUNTIME_PATH, CLI_VERSION_PATH,
  fetchDeployedAsset, readBuildStamp, type AssetFetcher, type BuildStamp,
} from './http/deployed-assets';

export {
  handleReleaseArtifactRequest, type ReleaseArtifactObject, type ReleaseArtifactStore,
} from './http/release-artifact';

export {
  RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SIGNING_PUBLIC_KEY_ENV, SignedReleaseSchema,
  signRelease, verifyRelease, generateReleaseSigningKey, type ReleaseChecksums, type SignedRelease,
} from './http/release-signing';

export {
  DEVICE_UPDATE, DEVICE_UPDATE_STATES, cliArtifactPath, deviceUpdateState, isSameBuild,
  type DeviceUpdateFrame, type DeviceUpdateState,
} from './http/device-update';

export {
  COPY_SCRIPT, GITHUB_ICON, KINU_MARK, MARK_IDS, REPO_URL,
  mark, markDocument, publicFooter, publicPage,
  type MarkId, type Mode, type PublicPageOptions, type PublicToken, type RadiusRole, type TokenSet,
} from './http/public-shell';

export {
  approvalDocument, authDocument, installDocument, loginDocument, type LoginProvider,
} from './http/public-pages';

export {
  currentTakeIndex, takeChipLabel, cycleTakeIndex, hasComparableTakes,
} from './read-models/alternate-takes';

export {
  classifyProgrammaticTurn, messageSignalId, isSteeredMessage, endedMidWork, TURN_END_METADATA_KEY, applySignalCard,
  parseSignalCardEvent, parseDrainedEvents, eventVariantLabel, eventSourceLabel,
  metadataBroadcastEvent,
  type ClassifiedProgrammaticTurn, type SignalCard, type DrainedEvent,
} from './read-models/background-event';

export {
  appendHeadDelta, retireHeadDelta, stepAsMessage, deltaAsMessage, NO_HEAD_DELTAS,
  type HeadDelta, type HeadDeltaKind, type HeadDeltas,
} from './read-models/head-chat';

export { drawnText, threadLiveTail, toolCallRunning, type LiveTail } from './read-models/message-live-tail';

export { turnLiveness, type TurnClaimState, type TurnLiveness } from './read-models/turn-liveness';

export {
  breakdownView, shareOfMeasured,
  type BreakdownRow, type BreakdownPlane, type BreakdownView,
} from './read-models/activity-breakdown';

export {
  PLANE, viewerKindOf, FileWriteConflict, textRenderOf, fileTextEditable,
  entryRevision, nextTreeCache, sandboxedHtml, putFileBytes,
  type FileText, type ViewerKind, type TextRender, type CachedDir,
} from './read-models/files-plane';

export {
  createPlanAnnotationSaveQueue, type PlanAnnotationSaveQueue,
} from './plans/plan-annotation-save';

export {
  swarmResolutionOf, swarmAxisRows, fanInArity, fanInVertices, nodeRationales,
  runRefusal, runLiveness, formatEvidenceValue,
  type SwarmAxis, type SwarmAxisRow, type SwarmResolution, type RunRefusal,
  type RunLevel, type RunLiveness,
} from './read-models/swarm-resolution';

export { terminalChatError, type ChatTurnError, type TerminalFrame } from './utils/chat-turn-error';

export {
  newSendLatch, admitTurn, abandonTurn, abandonTurnIfOwner, type SendLatch,
} from './utils/send-admission';

export {
  createSessionRecovery, fetchDeployedBuildSha, pageDeployedBuildSha,
  primePageDeployedBuildSha, isNewerDeployedBuild,
  type SessionRecoveryCallbacks, type SessionRecoveryOptions, type SessionRecovery,
} from './utils/session-recovery';

export {
  isModelInferenceCredentialKey,
} from './providers/inference-credentials';

export {
  MY_GATEWAY_PROVIDER_ID,
  createMyGatewayProvider,
} from './providers/my-gateway';

export {
  type WorkersAIOptions,
  createWorkersAIProvider,
} from './providers/workers-ai-provider';

export {
  scoreBand,
  type ExplorerSelection,
  cleanNodeLabel,
  clipToWidth,
  isCompeted,
  principalVariation,
  ancestorIds,
  findForkNode,
  terminalForkNode,
  treeStats,
  maxVisits,
  subtreeCount,
  losingBranchIds,
  NODE_R_MAX,
  NODE_R_UNSCORED,
  nodeRadius,
  linkWidth,
  LABEL_MIN_SCALE,
  viewNoteFor,
} from './read-models/swarm-tree-model';

export {
  type AnyToolPart,
  type PartBlock,
  groupMessageParts,
  parseProvisionError,
  partOutput,
  partInput,
  partEffect,
  callFailed,
} from './read-models/tool-call-grouping';

export {
  type SlateSurfaceKind,
  type SurfaceContent,
  type SurfaceKind,
  ACTIVITY_SURFACE,
  SLATE_PREFIX,
  SURFACES,
  landedSurface,
  openPortOf,
  pruneSlateReloads,
  surfaceHasContent,
} from './read-models/surface-presence';

export {
  ACCESS_TOKEN_SCOPES,
  type AccessTokenScope,
  type AccessTokenRecord,
  type AccessTokenMint,
  type AccessTokenVerification,
  initAccessTokenTable,
  parseAccessTokenUserId,
  normalizeAccessTokenScopes,
  mintAccessToken,
  verifyAccessToken,
  listAccessTokens,
  type AccessTokenRevocation,
  revokeAccessToken,
  getActiveAccessTokenScopes,
} from './cli/access-tokens';

export {
  bunResolutionShell,
  cliPlatformShell,
} from './cli/bun-runtime';

export {
  type CliInstallCommandOptions,
  normalizeCliOrigin,
  buildCliInstallCommand,
  buildCliSetupCommand,
  buildCliAuthCommand,
} from './cli/install-command';

export {
  FEEDBACK_ENDPOINT,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_MAX_REQUEST_BYTES,
  FEEDBACK_MAX_NOTE_CHARS,
  FEEDBACK_MAX_ROUTE_CHARS,
  FEEDBACK_MAX_USER_AGENT_CHARS,
  FEEDBACK_SCREENSHOT_TYPE,
  FEEDBACK_REDACT_ATTR,
  FEEDBACK_OMIT_ATTR,
  FEEDBACK_FIELDS,
  type FeedbackAccepted,
  type FeedbackRecord,
} from './feedback/contract';

export {
  type PngFault,
  type SanitizedPng,
  type PngRejection,
  sanitizePng,
} from './feedback/png';

export {
  type AgentModelEntry,
  type AgentModelMenu,
  EMPTY_MODEL_MENU,
  filterModels,
  type ModelSpecValidation,
  validateModelSpec,
  normalizeModelMenu,
  contextWindowForSpec,
} from './providers/model-menu';

export {
  type TextForContextEstimate,
  modelDisplayName,
  estimateContextTokens,
  formatContextUsage,
} from './tui/context-status';

export {
  clipText,
  agentDisplayLabel,
} from './tui/format';

export {
  ESC_ESC_BEAT_MS,
  type InputState,
  initialInputState,
  type InputMachineEvent,
  type InputEffect,
  type InputTransition,
  reduceInput,
} from './tui/input-state';

export {
  type WaitOptions,
  type StoppableWaitOptions,
  waitForAnswer,
} from './utils/wait';

export {
  sandboxIdForWorkspace,
  isKinuSandboxId,
} from './preview/sandbox-id';

export {
  actorConnectionTag,
  actorFromConnectionTags,
  extractOrchestratorAgentName,
  extractTicketOrchestratorAgentName,
  isForeignAgentNamespacePath,
  hostedActorRoute,
  hostedActorSocketPath,
} from './http/agent-routing';

export {
  APP_ROUTES,
  type ReportedRoute,
  REPORTED_ROUTES,
  routeTemplateOf,
} from './read-models/app-routes';

export {
  type AccountOnboarding,
  needsOnboarding,
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from './read-models/account';

export { DISPLAY_NAME_MAX, confirmsAccountDelete, displayNameProblem } from './read-models/account';

export {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_RENDER_FAILED,
  CLIENT_ERROR_MAX_REQUEST_BYTES,
  STACK_FRAME,
  COMPONENT_STACK_FRAME,
  stackFrames,
  ClientErrorReportSchema,
  type ClientErrorReport,
  fitClientErrorReport,
  type ReleaseMatch,
} from './read-models/client-error-contract';

export {
  type PageIdentity,
  reportRenderFailure,
} from './read-models/client-error-report';

export {
  KINU_NODE_MODULE_NAME,
  KINU_NODE_MODULE_SOURCE,
} from './execution/codemode-node-shim';

export {
  type DeviceHubClient,
  type DeviceRpcOptions,
  type HubDeviceTransportOpts,
  createHubDeviceTransport,
} from './execution/hub-device-transport';

export {
  type OutboundEmailMessage,
  type OutboundSendResult,
  EmailOutbox,
} from './events/email-outbox';

export {
  type WebhookRouteEnv,
  WEBHOOK_ROUTE_UNAVAILABLE,
  webhookRouteSecret,
  type WebhookRouteIdentity,
  type WebhookRouteMatch,
  type SignedWebhookRoute,
  webhookRoutePath,
  matchWebhookDeliveryPath,
  verifyWebhookRoute,
} from './events/webhook-route';

export {
  handleHealthRequest,
} from './http/health-route';

export {
  adaptMemory,
  backfillMemoryVectors,
} from './memory/vector-sync';

export {
  type ProbeOutcome,
  type ProbeDeps,
  runSyntheticProbes,
} from './http/synthetic-probes';

export {
  type HostedNodeHome,
  withHostedNodeExecution,
} from './execution/node-home';

export {
  type PcUserStub,
  type ObjectNamespace,
  type PcUserNamespace,
  type PcIngressEnv,
  handlePcRequest,
} from './http/pc-ingress';

export {
  type DriverKind,
  type DriverLeaseHolder,
  type LeaseProcess,
  type DriverLeaseRefusal,
  type DriverLeaseDeps,
  DriverLeaseHold,
} from './execution/driver-lease';

export {
  BRANCH_EXPLORE,
  BRANCH_REFLECT,
  BRANCH_READY,
  BRANCH_METHODS,
  BranchCallSchema,
  BranchReplySchema,
  BranchCallAttributionSchema,
  type BranchCall,
  type BranchReply,
  type BranchMethod,
  type BranchCallReply,
} from './protocol/branch';

export {
  type OrphanedFiber,
  createSqlFiber,
  detectOrphanedFibers,
} from './execution/fiber';

export {
  readAllOutcome,
} from './utils/spawned-output';

export { MCP_PRESETS, mcpPresetById, type McpPreset, type McpPresetId } from './mcp/presets';
