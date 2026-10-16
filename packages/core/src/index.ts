export {
  AskingAgentSchema, OwnerAnswersSchema, OwnerQuestionStore,
  type AskedQuestions, type AskingAgent, type OwnerAnswer,
} from './plans/owner-questions';

export { AskOwnerInputSchema, OTHER_OPTION, OWNER_ANSWER_SIGNAL, type OwnerQuestion } from './types/owner-questions';

export { initFiberTable, tableExists } from './identity/schema';

export { WorkspacePlanReferenceSchema, type WorkspacePlanReference, SubordinateInspectionRequestSchema, SubordinateInspectionResultSchema, readSubordinateInspection, missingSubordinateHistory, type SubordinateInspectionRequest, type SubordinateInspectionResult, type SubordinateChild } from './subordinates/inspection';

export { AgentOpenTurns, type AgentOpenTurn } from './subordinates/open-turns';

export { AgentReports, AgentSequence, type AcceptedReport } from './subordinates/report-sequence';

export { TurnFences, type ClosedExecution, type FencedRow, type OpenedAt } from './subordinates/turn-fence';

export { TurnReports, type ReportedTurn } from './subordinates/turn-reports';

export { runEventSinks } from './orchestrator/run-event-sinks';

export { inspectDescendant, inspectSubordinateStorage, readableActor, type AgentOwnInspection, type ReadableActor, type SubordinateInspectionAuthority, type SubordinateInspectionAccess } from './subordinates/inspection-path';

// Backend-neutral terminal-turn state machine: the DO and the CLI supply only effect bodies and a wake.
export {
  chatTurnParts, declareTerminalRoster, declareHandoffRoster, HandedOffTurnSchema, runSettleEffect, SettledRunSchema,
  type HandedOffTurn, type SettledRun, type TerminalActor, type TerminalTurnFacts, type TerminalTurnParts, type TurnEnd,
} from './orchestrator/terminal-roster';

export { SleepTimeLane, initSleepTimeUpdatesTable } from './orchestrator/sleep-time-lane';

export {
  assembleActorTurn, withCompactionTrigger, conversationKey, vfsTurnSkills, materializeTurnSources, turnSourcesFromBundle,
  type RunTurnSources, type TurnSourcesBundle, type TurnAssemblyRequest, type TurnAssemblySources, type TurnModelSources,
} from './orchestrator/turn-assembly';

export {
  TerminalTransitions, TERMINAL_TRANSITION_CALL_ID,
  type TerminalTransition,
} from './orchestrator/terminal-transition';

export {
  TerminalEffectLedger, initTerminalEffectTable, terminalEffect, chatTerminalEffects, turnRecordingEffects, actorTerminalEffects, branchesTerminalEffect,
  terminalEffectKey, TerminalEffectInterrupt, isDefinitiveTerminalFailure,
  TERMINAL_EFFECT_RETRY_BASE_MS, TERMINAL_EFFECT_RETRY_CEILING_MS,
  RunEndReasonSchema, type TurnReportFacts,
  type TerminalEffect, type TerminalEffectTable, type TerminalEffectName,
  type TerminalEffectOutcome, type TerminalEffectPhase,
  type TerminalEffectFault, type OwedEffect, type OwedTerminalEffect,
  type TerminalSequenceRun,
} from './orchestrator/terminal-effects';

export {
  driveExecution, type AssembledRound, type ClaimedRound,
} from './orchestrator/execution-driver';

export {
  initTurnBranchesTable, TurnBranchesStore, TurnFactsSchema, TurnFactsStore, type TurnFacts, type FrozenAuthority, type FactsKey,
} from './orchestrator/turn-facts';

export type {
  ExecutionKey, ExecutionLane, TurnCapability,
} from './orchestrator/execution';

export { inTurnSurface, scopedTurnSurface, TurnSurface } from './orchestrator/main-turn-surface';

export { turnLedgers, type TurnLedgers } from './orchestrator/turn-accumulator';

// Records that keyed work happened, kept after its row is retired.
export {
  initEffectTombstoneTable, effectAlreadyDone, recordEffectDone,
} from './identity/effect-tombstones';

export { readActivityLog, writeActivityLog, type ActivityLogEntry } from './identity/activity-log';

export { initActivationTable, listActivations, recordActivation, type Activation } from './identity/activations';

export { ChatHistoryEntrySchema } from './types/chat';

// Every composition root calls this and nothing else (tests/contract-workspace-schema.test.ts).
export { initAgentIsolateSchema, initAllTables, initWorkspaceSchema, initActorStateSchema, type WorkspaceSchemaSql } from './state/workspace-schema';

export { REGENERABLE, repairSchema, type Repair, type TableWrites, type TouchedTable } from './state/schema-repair';

export {
  censusOf, OPS_OBJECTS_PER_REQUEST, OPS_PASS_PREFIX, opsCaller, requireOps, type OpsCaller, type StoreCensus, type TableRows, type TablesAnswer,
} from './state/ops-tables';

export { initUserTables, PROFILE_CATALOG_CONFIG_KEY, WORKSPACE_KEYED_ROWS } from './state/user-schema';

export {
  DEFAULT_SOUL_MD,
  SOUL_FILE,
  SOUL_PATH,
  WORKSPACE_CREATED_EVENT,
  UNTITLED_WORKSPACE_NAME,
  isPlaceholderMission,
  workspaceGenesisSignal,
  readSoul,
  missionOf,
  renderSoulMarkdown,
  seedSoul,
  summarizeSoul,
} from './identity/soul';

export { WORKSPACE_IDENTITY_DDL } from './identity/schema';

export { validateSwarmProfileSnapshot } from './profiles';

export type { ProfileProvenance, SwarmProfileSnapshot } from './profiles';

export {
  readForkLineage, FORK_PIN_PREFIX, type ForkLineageRow, type ForkFileSource, type ForkPinnedFiles,
} from './identity/fork';

export {
  type ForkSnapshotHead, type ForkCraftedToolRow, type ForkConfigRow,
} from './identity/fork-rows';

export {
  ForkTargetWriter,
  type ForkResult, type ForkWriteTarget, type ForkStagedCounts,
} from './identity/fork-writer';

export { ForkStagingState, type ForkStaging } from './identity/fork-staging';

export {
  FORK_TRANSFER_VERSION, FORK_FRAME_BYTES, FORK_ROW_SECTIONS, FORK_STREAM_SEED,
  ForkTransferReceiver, forkTransferFrames, sealForkFrame,
  foldForkStream,
  type ForkFrame, type ForkChunksFrame, type ForkPageFrame, type ForkRowFrame,
  type ForkRowSection, type ForkSectionCounts, type ForkFrameReply,
  type UnsealedForkFrame,
  type ForkAppData,
} from './identity/fork-transfer';

export type { ForkFileSink } from './identity/fork-sink';

export {
  forkPointExists, answersForDrainTurns, conversationTurnPair, historyTurnPairs,
  type ConversationTurnPair, type TurnPairReader,
} from './identity/conversation-store';

export { CHAT_SESSION_ID, TRANSCRIPT_WINDOW } from './session/transcript-schema';

export {
  forkWorkspace, type ForkTransport, type ForkDriverDeps,
} from './identity/fork-driver';

export {
  isForkConversationSection, localForkConversationSource, localForkConversationTarget, forkConversationRowSchema,
  type ForkConversationSource, type ForkConversationTarget,
} from './identity/fork-conversation';

export { FORK_CONVERSATION_SECTIONS, FORK_SECTIONS, type ForkConversationSection, type ForkRows } from './identity/fork-sections';

export { forkArtifactPath, type ForkConversationPlan } from './identity/fork-plan';

// Workspace archive: one backup format for both backends.
export {
  WORKSPACE_ARCHIVE_EXTENSION,
  readAgentArchivePage, readWorkspaceArchivePage, type ArchiveAgentSource, restoreWorkspaceArchive, writeWorkspaceArchive,
  ArchiveCursorSchema, ARCHIVE_SNAPSHOT_ENDED,
  type ArchiveCursor, type ArchiveSqlCursor, type ArchiveAgentPage,
  type ArchivePage, type ArchiveStoreSource,
} from './identity/archive';

export { SCHEMA_RETIRED, SCHEMA_STAMPS, SCHEMA_TABLES } from './identity/schema-genesis';

export {
  durableStamps, pragmaStamps, readStamp, requireSchemaStamp, stampSchemaGenesis, StoragePredatesReleaseError, writeStamp,
  type SchemaClass, type StampReading, type StampStore,
} from './identity/schema-stamp';

export {
  WORKSPACE_TITLE_SYSTEM_PROMPT,
  workspaceTitlePrompt,
  applyWorkspaceTitle,
  fallbackWorkspaceIdentity,
  mintAgentName,
  parseWorkspaceTitle,
  planWorkspaceTitle, autoTitleMayReplace, nameOriginOf, persistAutoTitle, titleActorFromMessage,
  resolveWorkspaceTitle,
  suggestWorkspaceTitle,
  workspaceSlug, workspaceAddressRefusal, isPlaceholderWorkspaceTitle, workspaceHostLabel, codenameFor,
  type NameOrigin,
  type WorkspaceTitleState,
  isWorkspaceName,
  validateWorkspaceName,
} from './identity/naming';

export { drawWorkspaceLogo, sanitizeWorkspaceLogoSvg, WORKSPACE_LOGO_SYSTEM_PROMPT } from './identity/logo';

export { WORKSPACE_TITLE_MAX, workspaceDisplayTitle, workspaceTitleDraft, workspaceTitleProblem } from './read-models/workspace-title';

export { EvolutionEngine } from './evolution/engine';

export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig, type EvolutionEvent, type EvolutionListener,
  type CompletedTurn, type CompletedSession, type ToolCallRecord,
} from './evolution/types';

export {
  delegationFeatures, renderDelegationFeatures,
} from './evolution/delegation-features';

export { QualityDaySchema, type QualityDay, type QualityWindow } from './types/quality';

// Turn ratings: the one signal evolution decides by.
export {
  RATING_SOURCES, rateTurn, renderActions, initTurnRatingTables, recordTurnRating,
  listTurnRatings, ratingOf, hasLowRating, isLowRating, isHighRating, ratingQuality, thumbsRating, takePickRating,
  retractThumbs, listThumbs, satisfactionInterval, qualitySeries, qualityWindow, renderQualitySeries, isTrivialTurn,
  type RatingSource, type WrongReason, type RatingVerdict, type TurnRating,
  type RecordTurnRatingInput,
} from './evolution/ratings';

export {
  recordLesson, listLessons, corroborateLessonsForTurn, initLessonTables,
} from './evolution/lessons';

export {
  recordRecoveryFinding, listRecoveryFindings, recoveryFindingText,
  type RecoveryFinding,
} from './evolution/recovery';

// One row per turn, owned by EvolutionEngine.
export {
  initCompletedTurnTable, createCompletedTurnStore, CompletedTurnSchema,
  MAX_TURN_REVIEWS_PER_OPEN,
  type CompletedTurnStore, type ClaimedWindow,
  type RefusedTurnReview,
  type EnqueueOutcome, type DeferredReviewDrain,
} from './evolution/session-window';

export {
  buildChangelog, countUnseenChangelog, listUnseenChangelog,
  revertChangelogEntryById, ChangelogEntrySchema, ChangelogRevertResultSchema,
  type ChangelogEntry, type ChangelogEntryKind,
  type ChangelogRevertResult,
} from './evolution/changelog';

export { DEFAULT_CONFIG } from './config';

export {
  createAgentConfigStore, initAgentConfigTable, holdConfig,
  AGENT_CONFIG_KEYS,
  type AgentConfigStore, type ShellApprovalMode,
} from './config/index';

export type * from './types/primitives';

export { OutputSinkSchema, ShellExecOptionsSchema, VfsRevisionSchema } from './types/primitives';

export { REAL_CLOCK, waitOn, every, type Clock } from './types/clock';

export {
  cloudFileLinks, filesFocusOf, linkFileReferences, localFileLinks, type FileLinks, type FilesFocus,
} from './read-models/file-links';

export {
  cloudPlanes, findPlaneReferences, FOLDER_SUBTREE, formatPath, isWholeReference, localPlanes, machinePath, referencedPath, referencePrefixes, resolvePath, RESERVED_ROOTS,
  type PathPlanes,
} from './vfs/resolve';

export type * from './types/agent-runtime';

export type * from './types/backend-host';

export type * from './types/signals';

export { SIGNAL_ID_METADATA_KEY } from './types/signals';

export type * from './types/mcts';

export type * from './types/craft';

export type * from './types/evaluation';

// Slate stores live in `@kinu.run/core/slates`: they touch `node:util`, and client
// code value-imports this barrel. Keep worker-only modules off it.
export { parseSlateProject, slateTitle, type SlateProject } from './slates/project';

export { slateAuthority } from './slates/authority';

export {
  SHARE_VIEWER_REQUESTS_PER_MINUTE, SHARE_SPEND_CAP_USD_PER_DAY, shareSpendLabel, VIEWER_EXCHANGE_PATH, PREVIEW_ENTRY_PATH, CLI_PREVIEW_ENTRY_PATH,
  formatBlueprintId, parseBlueprintId, blueprintPagePath, liveSharePagePath,
  BlueprintInspectionSchema, BlueprintViewSchema, BlueprintForkSchema, BlueprintBundleSchema, PublishedBlueprintSchema,
  SharedLibrarySchema, SlateShareRecordSchema,
  ShareGrantSchema, SlateCapabilityGraphSchema, ShareCardSchema,
  LiveShareRecordSchema, LiveShareCreatedSchema, ViewerCallSchema, ViewerRequestRecordSchema, ShareViewerClaimSchema,
  type ShareKind, type LiveShareVisibility, type BlueprintInspection, type BlueprintView,
  type BlueprintFork, type BlueprintBundle,
  type PublishedBlueprint, type SharedLibrary, type SharedRow, type OwnedSlate, type SlateShareRecord, type BlueprintEntry,
  type ShareGrantMember, type ShareGrant, type ShareCard,
  type SlateGraphMember, type SlateGraphNamespace, type SlateCapabilityGraph,
  type LiveShareRecord, type LiveShareCreated, type ViewerCall, type ViewerRequestRecord, type ShareViewerClaim,
} from './slates/sharing';

export {
  GALLERY_CATEGORIES, RoomViewSchema, RoomCallSchema, RoomClientFrameSchema, RoomServerFrameSchema,
  DriveLibrarySchema, ForkPreviewSchema, ForkedSchema,
  GALLERY_SORTS, GalleryPageSchema, GallerySlateSchema, galleryPath, gallerySlatePath, galleryPicturePath, GALLERY_STAR_PATH, GALLERY_REPORT_PATH,
  type GalleryPage, type GallerySlate, type GalleryStar, type GalleryReport,
  roomPagePath, roomSocketPath, roomPartPath, roomFramePath, roomEntryPath, roomForkPath, RoomEntrySchema, type RoomEntry,
  type RoomPerson, type RoomRole, type RoomAccess, type RoomAudience, type RoomService, type RoomTool, type RoomSource,
  type RoomReach, type GalleryCategory, type SheetLend, type SheetLendUse, type SheetMember, type SheetView,
  type RoomSession, type RoomPresence, type RoomAsk, type RoomEnded, type PartView, type RoomView, type ShowScope,
  type RoomCall, type RoomClientFrame, type RoomServerFrame,
  type DriveRoomCard, type DriveSlate, type DriveLibrary, type GalleryListing, type GallerySort, type ForkPreview, type Forked,
} from './slates/room-api';

export { slateAddressImpact, slateOwnerOnly } from './slates/members';

export {
  slateCapabilityGraph, cutShareGrant, grantAdmits, type SlateSurfaceCatalog, type SlateUsage,
} from './slates/capability-graph';

export {
  SlateCallRequestSchema, SLATE_DRIVEN_MEMBERS, routeSlateCall, issuedSlateInvocation, routeViewerCall, admitNestedViewerCall, slateCallAddress,
  type SlateCallRequest, type SlateRoute, type SlateInvocation, type SlateViewer,
} from './slates/surface';

export { SLATE_READ_MODELS, type SlateReadModel } from './slates/read-models';

export type { SlateProcess } from './slates/process';

export {
  isSlateMethodName, SLATE_METHOD_NAME_SOURCE, SlateOperationSchema, slateIdFor, requireSlateWorkMode, type SlateOperation, SLATES_CHANGED_EVENT, type SlateCallResult, type SlateAnswer, type SlateSurfaceResult, type SlateSurfaceValue, isJsonAnswer,
  type SlateSummary, type SlateProblem,
} from './slates/rpc';

export { initSlateStateTable, SLATE_HOST_BINDING, SLATE_STORAGE_BINDING, slateStorageCall } from './slates/state';

// Browser-safe slate vocabulary, so it belongs on this value-imported barrel.
export {
  buildSlateHostContext, isSlateFrameMessage, slateFrameSrc, slateLinkId,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_INLINE_HEIGHT_LIMIT, SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE, SLATE_THEME_TOKENS,
  SlateFrameMessageSchema,
} from './slates/host-context';

export {
  addressedBlock, ephemeralSlateAddress, ephemeralSlateId, slateUiSegments, SLATE_UI_ATTRIBUTE,
  type EphemeralSlateAddress, type SlateUiBlock, type SlateUiSegment,
} from './slates/ui-blocks';

// Cross-workspace experience transfer
export {
  createExperienceLibrary,
  findPublishable,
  runExperienceAction,
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
  runChat, INTERRUPTED_TURN,
  type ChatEvent, type ChatFallback, type ChatOptions, type ObserveStream,
} from './chat';

export type { ModelAttemptIdentity } from './providers/attempt-identity';

// Extension seam (public plugin API)
export {
  ExtensionHost,
  type KinuExtension,
  type ToolCallContext,
  type ToolResultContext,
  type PrepareStepContext,
  type TransformContext,
  type CompactionTrigger,
} from './extension';

export {
  composePrepareStep,
  type StepContextPlane,
  type StepDynamicContext,
  type StepPipeline,
} from './prompting/prepare-step';

export { toolPairingGaps } from './session/tool-pairing';

export { type StagedContextDeferral, type ContextProposalClosure, type ContextEventRecorder, type ContextEditEvent } from './types/context-plane';

export { SessionHistory } from './session/history';

export type { ContextSelection, ContextEntry } from './session/context';

export type { ContextProposal, ContextChange } from './session/proposals';

export {
  contextMount, localContextTree, remoteContextTree, servedContextTree,
  type ActorContextStores, type ChildContextResolver, type ContextFileHeader, type ContextTree, type ContextEditor, type ContextTreeRemote,
} from './vfs/context-plane';

export type { SessionFilePlane } from './session/payload';

export type { MessageReference, MessagePartReference, ActorReadAuthority } from './session/messages';

export { drawnStep, SessionTranscript, SessionTranscriptReader, readSessionTranscript, type ConversationEntry, type ConversationProjection, type PreparedConversationEntry } from './session/transcript';

export { encodeModelMessageValues, decodeModelMessageValues } from './session/message-codec';

export {
  pruneStepToolOutputs, type StepPruneBudget,
} from './prompting/step-prune';

export {
  settleUnpairedToolCalls,
} from './prompting/interrupted-tool-calls';

export { StepInjections, type RecordedInjection } from './prompting/step-injections';

export {
  classifyTurnFailure,
  planOverflowRecovery,
  statedContextLimit,
  OVERFLOW_RETRY_EVENT,
  OVERFLOW_RETRY_TEXT,
  type TurnFailureClass,
  type OverflowRecoveryDecision,
} from './turn-failure';

export { createChatModel } from './llm';

// Surfaces import this instead of retyping the number.
export { CHARS_PER_TOKEN, estimateTokens } from './token-estimate';

export type { LLMProviderConfig } from './llm';

export {
  createWorkersAIEmbedder, generateReported, streamTextReported, type GenerateRequest, type StreamRequest,
} from './providers/model-invocation';

// Every surface that counts tokens speaks this usage report.
export {
  USAGE_FIELDS,
  UsageSchema,
  addUsage,
  normalizeAnthropicUsage,
  normalizeUsage,
  usageReported,
  usageTotal,
} from './usage';

export type { Usage } from './usage';

export { modelWindow, stepContextLimit, outputReserveTokens, type ModelWindow } from './context-window';

// The per-turn bulk ledger: the cumulative clamp budget + the M1 trip counters.
export {
  TurnContextBudget,
  citesSpillAddress,
  SPILL_DIRS,
  type BulkProducer,
} from './context-budget';

// Label-scoped spend governor. Opt-in: no label, no cap, no storage traffic.
export {
  MissionGovernor,
  MissionBudgetExhausted,
  readMissionLimits,
  // A surface that prices a call must use this, exactly as the ledger debits it.
  priceCall,
  localMissionScope,
  missionGate,
  listMissionSpend,
  type MissionBudgetPort,
  type MissionScope,
  type MissionBudgetLimits,
  type MissionBudgetRefusal,
  type MissionBudgetSnapshot,
  type MissionSeam,
} from './mission-budget';

export {
  buildCompactionSummaryPrompt,
  wrapCompactionSummary,
  stripCheckpointPreamble,
  CONTEXT_CHECKPOINT_PREFIX,
} from './compaction';

export {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOL_SPECS,
  replayPolicyFor,
  renderToolSchemaDescription,
  renderCodemodeDescription, programDeclarations, describeProgramSource, CODEMODE_CODE_DESCRIPTION,
  TOOL_REACH,
  isBuiltinToolName,
  narrowToolSurface,
  codemodeCapabilitiesFor,
  type ToolSurfaceNarrowing,
  type BuiltinToolName,
  REPORT_TOOL, SUBMIT_PLAN_TOOL, REPLY_TO_COMMENT_TOOL, ASK_OWNER_TOOL,
} from './tools/registry';

export {
  CRAFTED_TOOL_NAMESPACE,
  craftedToolDescription, codemodeInputSchema,
  renderCraftedToolsDeclaration, nativeToolFunctions, toolsNamespace, codemodeFunction, craftedFailureFunctions, renderCraftedDefinitions,
  slateToolReach, callCodemodeMember, requireCodemodeMember,
  withCraftedToolDeclarations, craftedToolDeclarations,
  shownConsoleValue, createToolArguments, SANDBOX_CONSOLE_PRELUDE, SANDBOX_CREATE_TOOL_PRELUDE,
  type CraftedDeclaration,
  type CodemodeProvider, type CodemodeResult,
} from './tools/sandbox-contract';

export { createStateCodemodeProvider } from './tools/state-operations';

export { executorNamespace } from './tools/executor-operations';

export { DB, type AppColumnType } from './operations/db';

export { STATE } from './operations/state';

export { initCodemodeStateTable, createProgramStateStore, type ProgramStateStore } from './identity/program-state';

export {
  APP_TABLE_SCOPES, APP_MUTATIONS,
  initAgentDataTables, createAppDataStore, createDbCodemodeProvider,
  type AppTableScope, type AppMutation,
  type AppTableSpec,
  type AppOp,
  type AppDataStore, type DbOpRecord,
} from './tools/db-codemode';

export { ActorReferenceSchema, actorReferenceOf, bindActorHandle, sameActorReference, type ActorReference, type ActorIdentity, type ActorHandle } from './identity/actor-handle';

export { explorationActorKey, isExplorationActorKey, parseActorKey, requireSubordinateActorName } from './identity/actor-key';

export { recoverSubordinateLifecycles, SubordinateBirthSchema, type SubordinateBirth, type SubordinateSeed } from './subordinates/birth';

export { SubordinateInheritedContextSchema, type SubordinateInheritedContext } from './types/subordinates';

export { subordinateForkContext, subordinateTurnContext } from './subordinates/support';

export { inheritedAsModelMessage } from './heads/head-inference';

export { driveDeliveredRun } from './heads/delivered-run';

export { initWorkspaceActorTable, WorkspaceActorDirectory, subordinateDescendants, stoppedBelow, isSubordinateOrigin, whenActorTakesInput, actorScaffoldPath, actorStateRoot, openWorkspaceMainActor, bearWorkspaceIdentity, ChildActorOperationSchema, type ChildActorOperation, type ActorDirectoryResult, type WorkspaceActor, type CreateWorkspaceActor, actorStanding, type ActorStanding, actorEnded, endedStandingOf } from './identity/workspace-actors';

export type { AnsweredEvolutionHelper } from './identity/evolution-helpers';

export {
  openLocalRootActor, localActorDirectory, adoptLocalActorHandle, bindLocalActorReference, registerLocalActor, openLocalActor, bindLocalActor, requireLocalActorWorkspace, retireLocalActor, cancelLocalCreation, recoverLocalActorRetirements, type LocalActorBinding, type LocalActorConfig,
} from './state/local-actors';

// open-38: one physical workspace SQLite for every logical actor.
export {
  createActorHost, createSeatHost, recoverActorTurns, childContextResolver, hostedChildTree, registeredParent,
  type ActorHost,
  type ActorSeat, type ActorHostDeps, type SeatHostDeps, type BoundActor, type SeatedActor, type HostedActor,
  type ActorRetirement,
} from './state/actor-host';

export { seedActorLoop, defaultLoopOrigin, type LoopOrigin } from './scaffold/bootstrap';

export { admitCraftedSource, parsesAsExpression, type CraftedSourceAdmission } from './craft/source';

export { mcpToolKey, isMcpToolKey } from './tools/mcp-naming';

export {
  describeMcpTool, toolSurfaceTokens, omitEmptyOptionalArgs,
  buildMcpToolSet, listMcpToolsLeniently,
  McpToolSurfaceSchema, McpToolSurfaceCache,
  type SerializableToolDescriptor, type RemoteMcpTool, type McpToolRefusal, type ListedMcpTools,
  type McpSurfaceBudget, type McpServedSurface,
} from './tools/mcp-surface';

export {
  agentsActionsFor,
  agentsProfileContext, delegationChoices,
  type AgentsCall, type AgentsProfileContext,
} from './delegation/agents-tool';

export {
  createLocalPeerEndpoint, samePeerGroup,
  type HostedAgentRef, type LocalPeerEndpoint,
} from './tools/local-peer';

export { createAgentsCodemodeProvider, createAgentsTool, resumableAgentsInput } from './delegation/agents-operations';

export {
  actorNamespaces, hostedSurfaceActor, SURFACE_POLICY,
  type SurfaceActor, type SurfacePolicy,
} from './delegation/actor-surface';

export { actorPolicy, type ActorPolicy } from './delegation/actor-policy';

export { actorReach, surfaceReach, turnLane, turnReach, type ActorReach, type SurfaceReach, type TurnLane, type TurnReach } from './delegation/turn-reach';

export { AGENTS_OPS, type AgentsOp } from './operations/agents';

export { createAgentSelfProvider, type AgentSelfHost } from './tools/agent-self';

export { agentSelfHost } from './orchestrator/agent-self-host';

// Platform-neutral: a backend supplies only SubordinateRuntime.
export { SubordinateRosterStore, initSubordinateRosterTable, subordinateTitle } from './subordinates/roster';

export {
  admitSubordinateReport,
  admitSubordinateTask,
  agentNamer,
  createTeamToolDeps,
  describeSubordinateHandoff,
  normalizeReportContent,
  parentAdmitsSubordinateReport,
  readSubordinateLiveStatus,
  subordinateDescriptorSource,
  owedSubordinateTurnReport,
  type SubordinateReportOrigin,
  type SubordinateRuntime,
} from './subordinates/support';

export {
  SUBORDINATE_LIFETIMES,
  TEMPORARY_LIFETIME,
  TASK_TURN_ENDINGS,
  createTemporaryAgentPort,
  taskAnswerIsLater,
  temporaryRunSettles,
  taskTurnEnding,
  terminalTaskReport,
  reportReadsNarration,
  type OwedReport,
  type SubordinateLifetime,
  type TemporaryAgentPort,
  type TemporaryRunOutcome,
  type TaskTurnEnding,
  type TemporaryRunRequest,
} from './subordinates/temporary';

// The depth cap is derived per child, never stated by one.
export {
  DELEGATION_MAX_DEPTH,
  ROOT_DELEGATION_BUDGET,
  delegationBudgetOf,
  delegationDepthRefusal,
  delegationExhausted,
  type DelegationBudget,
} from './subordinates/depth';

export {
  buildBuiltinTools,
  ownerLaneTools, ownerLaneDeclarations,
  codemodeSurface,
  type BuiltinToolDeps,
  type CodemodeBuilder, type CodemodeSurface,
} from './tools/builtins';

// An actor surface is buildBuiltinTools plus `agents`; see delegation/actor-tools.ts.
export {
  buildActorTools, PEER_REPLY_TOPIC,
  type ActorToolsetDeps, type ActorToolsets,
  type AgentsToolDeps, type AgentsSwarmDeps,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type SubordinateDelivery, type SubordinatePhase, type SubordinateHandoff, type SubordinateDismissal,
  type PeersToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './delegation/actor-tools';

// Applied inside buildActorTools; backends never wrap tools themselves.
export {
  initToolEffectClaimTable, claimToolEffect, settleToolEffect,
  withEffectReceipt, remoteReceipts, pruneTurnReceipts,
  type EffectClaimDeps, type ReceiptExecution, type RemoteReceipt, type ToolEffectKey,
} from './tools/effect-claim';

// Web search + fetch
export * from './web/index';

// Codemode-only, no native tool: see tools/builtins.ts.

export { createMemoryCodemodeProvider, serveMemory, type MemoryDeps } from './tools/memory-operations';

export { MEMORY } from './operations/memory';

export {
  nativeTool, nativeToolSchema, codemodeNamespace, callOperation, listOperations, type OperationCaller, type OperationListing,
} from './tools/operation-surfaces';

export {
  defineOperation, serve, serveTransactional, operationId, allowedInPlan, inputJsonSchema,
  type Operation, type OperationCall, type OperationResult, type Served, type Impact,
} from './operations/operation';

export { createTasksCodemodeProvider, serveTasks, type RoleSwitch } from './tools/tasks-operations';

export { TASK_STATUSES, TASKS } from './operations/tasks';

export { createReportCodemodeProvider, serveReport, type ReportDeps } from './tools/report-operations';

export { REPORT } from './operations/report';

export { createFileCodemodeProvider, createFileTool, serveFile, type FileDeps } from './tools/file-operations';

export { FILE } from './operations/file';

export { imageModelOutput } from './tools/image-results';

export {
  summarizeToolCall, describeToolCall,
  toolCallEffect,
  type ToolCallEffect,
} from './tools/tool-call-summary';

export { ToolOutcomeSchema, failedToolOutcome, successfulToolOutcome, withCodemodeProgram, type ToolOutcome } from './tools/outcome';

export { repairToolCall } from './tools/repair-tool-call';

export { McpToolError, McpProtocolFailureSchema, mcpCallResult } from './tools/mcp-error';

export {
  clampToolResult,
  clampSerializedToolResult,
  withClampedToolResult,
  withClampedToolResults,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  type ClampToolResultOptions,
} from './tools/clamp';

export { createFileToolSteer } from './tools/shell-file-steer';

export {
  selectInjectableCraftedTools,
  type CraftedToolSource,
} from './tools/crafted-executor';

export {
  buildSystemPromptSync,
  currentDateForPrompt,
  renderUnverifiedInstructions,
  type SystemPromptOptions,
} from './prompt';

export {
  splitPromptSections,
  DYNAMIC_CONTEXT_OPEN_TAG,
  WORKSPACE_INSTRUCTIONS_TAG,
  type PromptSection,
} from './utils/prompt-sections';

// A local estimate, carried beside the provider totals, never reconciled into them.
export {
  TurnContextMeter,
  measureContext,
  type ContextComposition,
  type ContextPlane,
  type ContextSegment,
} from './context-meter';

export { isWorkMode, WorkModeSchema, type TurnReason, type WorkMode } from './types/turn';

export {
  compilePromptSurface,
  type PromptBackend,
  type PromptExecutorInfo,
  type PromptIdentity,
  type PromptSurface,
  type PromptSurfaceOptions,
} from './prompting/surface';

export {
  assertToolsSupportedByModel,
  resolvePromptModelProfile,
  type PromptModelContext,
  type PromptModelFamily,
  type PromptModelProfile,
} from './prompting/model-profile';

export {
  renderAgentsMdSection,
  collectWorkspaceAgentsMd,
  admitAgentsMd,
  advisorWorkspaceGuidance,
  discoverInstructionFiles,
  type AdvisorWorkspace,
  type InstructionCandidate,
  type InstructionFileProbe,
  type InstructionFileRead,
  type AgentsMdSources,
  type InstructionPlacement,
} from './prompting/agents-md';

export {
  acceptedMediaForModel,
  attachmentBytes,
  sanitizeAttachmentsForModel,
  storeAttachment,
  type AttachmentPolicy,
  type MediaModality,
} from './prompting/attachment-sanitizer';

export { ASKED, HeldReads, type Holds } from './utils/held-reads';

export { rasterImage, type RasterImage } from './utils/raster-image';

export { mediaImage, mediaTokens, UNPRICED_MEDIA_TOKENS } from './prompting/media-tokens';

export { toolDescription } from './utils/tool-description';

export { serverCompactor, isServerCompaction, latestCompaction, type ServerCompactor, COMPACTION_TRIGGER_PERCENT, SERVER_COMPACTION_MIN_TOKENS } from './providers/server-compaction';

export {
  DynamicContextLedger, agentDynamicContext, observeSystemPromptHash, renderDynamicContextBlock, type DynamicApproval, type DynamicContext, type DynamicDelegate, type RuntimeFacts, type MissingCapability,
} from './prompting/volatile-context';

export type { ActiveRoster } from './types/dynamic-context';

export {
  applyCacheBreakpoints,
  cacheableSystem,
  hasCacheMarkers,
  markCacheTail,
  promptCacheOptions,
  promptCacheWarm,
  resolvePromptCacheStrategy,
  type CacheBreakpointPlan,
  type PromptCacheStrategy,
} from './prompting/cache-breakpoints';

export {
  extractJsonArray,
  extractJsonObject,
  jsonArrayOnlyInstruction,
  jsonObjectOnlyInstruction,
  stripMarkdownFences,
} from './providers/structured';

export { EVIDENCE_BUDGETS, evidenceWindow, renderToolResult } from './utils/evidence-window';

export { buildRuntime } from './runtime-builder';

export { createAgentStores } from './state/agent-stores';

export type { AgentStores } from './state/agent-stores';

export { collectDynamicContext, dynamicReads, subordinateDelegatesOf, type DynamicReads } from './state/dynamic-context';

export type { DynamicContextInput } from './state/dynamic-context';

// Search-tree primitives the swarm runs on
export { selectNode } from './mcts/uct';

export { backpropagate } from './mcts/backpropagation';

export { pruneLowValueBranches } from './mcts/pruning';

export { diversityDirective, diversityAngle, siblingAngles } from './mcts/diversity';

export {
  explorePrompt,
  type ExplorePrompt, type ExplorePromptInput,
} from './mcts/explore-prompt';

export {
  canonicalLanguage, fencedBlocks, readProposalCode,
} from './execution/code-fence';

export {
  evaluateWithMultiModelJudging, median,
  type BranchEvaluation,
} from './mcts/evaluation';

export type { EvaluationGrounding } from './types/evaluation';

// Alternate Takes
export {
  initAlternateTakesTable,
  listAlternateTakeSets, latestAlternateTakeSet, recordTakePick,
  recordBranchTakeSet, buildTakeContinuationPrompt, takeEvidence, AlternateTakeSetSchema,
  TakePickOutcomeSchema,
  type AlternateTakeCandidate, type AlternateTakeSet,
  type TakePickOutcome,
} from './mcts/takes';

// Steer-as-Branch
export {
  BRANCH_RATIONALE, STEER_BRANCH_RUN_ID_PREFIX,
  newBranchId, isSteerBranchRunId, branchHeadId, admitBranch,
  startBranchHead, settleBranchIntoTakes, settlePendingBranch,
  branchOutcomeFromJournal,
  type BranchStatusEvent, type BranchTurnResult, BranchTurnResultSchema,
  type PendingBranch,
} from './steer-branch';

// Inbox: the one way anything reaches an agent.
export { TurnReplies } from './orchestrator/turn-replies';

export {
  Inbox, signalCardId, PromptFileSchema, turnInputMessage,
  STEER_METADATA_KEY, STEER_STEP_METADATA_KEY,
  describeLandedSteers, initPendingSendTables, PendingSendStore,
  type UserSteerDeps, type AcceptedSteer,
  type UserSteer,
  type LandedSteerRow, type PendingSendRow, type InputProducer,
} from './orchestrator/inbox';

export { sendLanding, SendStateSchema, type SendState } from './orchestrator/send-state';

export {
  buildTranscript, extendTranscript, sealTranscript, segmentBySteers,
  EMPTY_TRANSCRIPT_FOLD,
  type InlineSteer, type PlacedSteer, type Transcript, type TranscriptEntry,
  type TranscriptPart,
} from './read-models/transcript';

export { initSearchTables } from './mcts/schemas';

export { initSwarmNodeRecords } from './strategy/swarm-resume';

export {
  MctsSearchStore,
  initMctsSearchTable,
  type MctsSearchRunSummary,
} from './mcts/search-store';

export { initScaffoldTables } from './scaffold/schemas';

export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap';

export { modifyScaffold, type ModifyResult } from './scaffold/modify';

export { rollbackScaffold } from './scaffold/rollback';

export { createScaffoldSurface } from './scaffold/surface';

// Misevolution gate: fixed safety criteria over every evolution surface.
export {
  checkMisevolution, checkMisevolutionForSurface, recordMisevolutionVeto,
  type EvolvedArtifact,
} from './safety/misevolution';

export { listScaffoldArchive, type ScaffoldArchiveEntry, type ScaffoldStatus } from './scaffold/archive';

export {
  runScaffold, scaffoldProviders,
  type ScaffoldRunOptions,
  type ScaffoldRunResult, type ScaffoldRunReport, scaffoldRunReport,
  type ScaffoldDefaultInferenceChunk,
  type ScaffoldEvent, type ScaffoldToolOutput,
  type ScaffoldEmitFn,
} from './scaffold/executor';

export { pumpScaffoldEvents } from './scaffold/event-pump';

export { scaffoldChatTransform } from './scaffold/chat-transform';

export {
  getCurrentScaffoldVersion, readScaffoldVersion, readVersionedScaffoldSource, getPendingScaffold, applyPromotionDecision, type VersionedScaffoldSource,
  type PendingScaffold, type ScaffoldDecisionEvents,
} from './scaffold/versions';

// CraftStore quality
export { effectiveScore, filterByEffectiveScore, updateCraftScores } from './craft/ema';

export { CRAFT_NEUTRAL_PRIOR, type CraftCall } from './craft/in-episode';

export { TurnCraftLedger } from './craft/turn-ledger';

export { periodicCraftConsolidation } from './craft/consolidation';

export { upsertCraftedTool } from './craft/conflict';

export {
  DefaultExecutionRouter, runOnExecutor,
} from './execution/router';

export {
  withApprovalGatedShell, withApprovalGatedFiles, gateProviderExec, type FileReach,
} from './execution/approval';

export {
  busyShell, callJob, createBashShell, createShellSession, machineShellCall, shellExecOptions,
  type MachineShells, type ShellSession,
} from './execution/shell-session';

export {
  createSandboxExecutor, type SandboxHandle, type SandboxResize, isSandboxTransientError, SandboxPending,
  sandboxSizeLabel, WORKSPACE_BACKUP_DIR, sandboxFiles,
} from './execution/sandbox';

export {
  DESKTOP_MEMBERS,
} from './execution/desktop';

export {
  createDeviceTunnelExecutor, type DeviceTransport, deviceFiles, type DeviceFileScope,
} from './execution/device-tunnel-executor';

export {
  deviceToolchainAnswer, freshDeviceToolchain, connectedDevices, deviceByName, deviceFleetAsk, sameDeviceStatus,
  soleLiveDevice, effectiveDeviceMode, parseDeviceTier, parseSandboxCapability, parseSandboxReason, sandboxReasonFix,
  sandboxCause, describeGpuNodes, DEVICE_TOOLCHAIN_TTL_MS, DEVICE_TIERS, DEVICE_SANDBOX_CAPABILITIES,
  DEVICE_SANDBOX_REASONS, type DeviceStatus, type DeviceToolchain, type DeviceFleetEntry,
  type DeviceTier, type DeviceMode, type DeviceSandboxStatus, type DeviceSandboxReason,
} from './execution/device-status';

export {
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_PROBED_CAPABILITIES, TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
} from './execution/toolchain';

export {
  WS_OPEN,
  DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  WORKSPACE_HAS_NO_OWNER, isWorkspaceUnattachedError, SEVERAL_DEVICES_CONNECTED, isDeviceAmbiguityError, isSandboxUnavailableError, DEVICE_DUPLICATE_REQUEST,
  DeviceCancelResultSchema, nextDeviceRequestId, DEVICE_CANCEL_MISPAIRED, parseDeviceCancelAnswer,
  type DeviceCancelResult, type DeviceExecOutput, watchedOutput,
} from './execution/device-tunnel';

export {
  DeviceHelloHeadSchema, DeviceUpdateHelloSchema, DeviceHelloSchema, DEVICE_METHOD, DEVICE_FRAMES, DEVICE_ERRORS,
  DEVICE_FEATURES, DEVICE_PROTOCOL_VERSION, DEVICE_UPDATE_REQUIRED, DEVICE_PTY_MAX_AXIS, deviceMethodHas,
  deviceFailure,
} from './execution/device-protocol';

export {
  DeviceSocketHub, deviceIdFromSocket, type DeviceSocket,
  type DeviceSocketCtx,
} from './execution/device-hub';

export { DeviceChatGptStatusSchema, EGRESS_ROUTE_HEADER,
  type DeviceChatGptStatus, type DeviceRelayRequest, type RelayedProvider,
} from './execution/device-relay';

export {
  DeviceRequestLedger, initDeviceInflightTable, type ClaimedDeviceRequest,
  type DeviceCancelOutcome,
} from './execution/device-inflight';

export {
  DeviceTerminalHub, terminalFromSocket,
} from './execution/device-terminal';

export {
  nimbusSessionShell, type NimbusSandboxHandle, type NimbusSandboxFiles, type NimbusStartResult,
  type NimbusExecResult, type NimbusPortInfo, nimbusSessionFiles,
} from './execution/nimbus';

export {
  EXECUTOR_CAPABILITIES, NO_TIMER_DEADLINE_MS, commandTool, type ExecutorTool, type ExecutorToolResult,
  type CommandTool, type ExecutorCapability, type ExecutorKind, type ExecutorProvider, type ExecutorProviderSurface,
  type ExecutorStatus, type ExecutorInfo, type ExecutionRouter, type ResourceLimits,
  type PreviewRouteCheck, type SandboxSize, type SandboxSizes,
} from './execution/types';

export {
  wordsOnly,
} from './execution/command-call';

export {
  commandResult, CommandResultSchema, type CommandResult, formatExecResult, answeredRefusal, type ExecOutcome,
} from './execution/exec-result';

export {
  BoundedOutput, COMMAND_OUTPUT_LIMITS, type OutputSpill, type SpillOutcome,
} from './execution/bounded-output';

export {
  TurnEscalationLedger, ESCALATION_OUTCOMES,
} from './execution/escalation';

export {
  answerParentRpc, createParentExecutor, createParentWorkspaceVfs, type ParentWorkspaceHandle, type ParentExecResult,
  type ParentRpcWrite,
} from './execution/parent';

export {
  createInlineExecutor, createNimbusWorkspaceExecutor,
  type InlineExecutorDeps,
} from './tools/inline-executor';

export { explainSandboxError } from './tools/sandbox-errors';

export { callableToolNames, currentWorkMode, inWorkMode, runWorkModeInvocation, permitInPlan, hasPlanPermission, requireBuild, requireWorkModePermission, workModeRefusal, toolsInWorkMode, toolsForInvocation, providersInWorkMode } from './execution/work-mode';

export { ProgramsInFlight, launched } from './execution/programs-in-flight';

// Client-safe only: the Nimbus workspace host is exported from
// `@kinu.run/core/workspace` so a browser bundle cannot pull in the server runtime.
export {
  isHiddenEntry, workspacePath, SLATES_ROOT, WORKSPACE_ROOT,
} from './vfs/workspace-path';

export {
  agentHome, agentArtifactDirectory, agentTmpRoot, agentCred, agentIdentity, agentNameOfUid,
  provisionAgentHome, confineAgentTmp, releaseAgentHome, restoreAgentTmpConfinements, settleWorkspaceRoot,
  settleWorkspaceSlates,
  actorHomeName,
  MAIN_AGENT, SESSION_UID, AGENT_UID_FLOOR,
  type HomeRootVfs, type TmpConfiner,
} from './vfs/agent-home';

export { workspaceCommandNotFound } from './vfs/workspace-runtimes';

export type {
  WorkspaceBundle, WorkspaceFiles, WorkspaceOptions,
  WorkspaceSession,
} from './vfs/nimbus-workspace';

export {
  workspaceSoul, writeWorkspaceSoul, createWorkspaceForkSink, createWorkspaceForkSource,
  workspaceArchiveStore, workspaceArchiveTarget,
} from './vfs/workspace-planes';

export { observeNamespace, type WriteEvent, type WriteObserver } from './vfs/write-events';

export { isNimbusTable } from './vfs/nimbus-tables';

export { ensureDir, vfsBasename, vfsDirname } from './utils/vfs-helpers';

export { oneAtATime } from './utils/one-at-a-time';

export { markStoreChanged, storeRevision } from '@kinu.run/agent-utils';

export { ISOLATED_BUN_FLAGS, isolatedBunArgs } from './utils/bun-isolation';

export { mossaicVfs, type MossaicClient, type MossaicVfs, type MossaicStat, type MossaicChild } from './vfs/mossaic-vfs';

export {
  sharedDriveMount, SHARED_SKILLS_DIR, DRIVE_SKILLS_DIR, DRIVE_RESERVED_DIRS,
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
  withMountTable, workspaceFilePlane, standardMounts, EXECUTOR_MOUNTS, MOUNT_EXECUTORS,
  readBoundedWithVfsOps, readTailWithVfsOps, listWithVfsOps,
  type VfsMount, type MountedVfs, type WorkspacePrincipal,
  type VfsListedEntry,
} from './vfs/mounts';

// File checkpoints
export {
  CHECKPOINTS_NO_DEVICE, summarizeRestorePlan,
  checkpointAvailability, deviceHistoryNote, fileCheckpointListing, fileRestorePlan, fileCheckpointRestore,
  CheckpointAvailabilitySchema, FileCheckpointEntrySchema, FileCheckpointListingSchema, FileRestorePlanSchema, FileRestoreResultSchema,
  type FileCheckpoints, type FileCheckpointReads, type CheckpointTurnMeta, type CheckpointAvailability,
  type FileCheckpointEntry, type FileCheckpointListing, type FileRestoreChange,
  type FileRestorePlan, type FileRestoreResult, type DeviceCheckpointHint,
} from './checkpoints/types';

export { deviceFileCheckpoints } from './checkpoints/device';

export {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_UNAVAILABLE_NO_GIT,
  CHECKPOINT_REF_PREFIX, CHECKPOINT_WORKDIR_MARKER, CHECKPOINT_EXCLUDES,
  checkpointSubject, parseCheckpointSubject, checkpointRefTimestampMs,
  checkpointReason, stagingOutcome,
} from './checkpoints/format';

export {
  createCheckpointEngine, PROJECT_MARKERS,
  type CheckpointHost,
  type CheckpointOutcome,
} from './checkpoints/engine';

// Semantic memory
export {
  reciprocalRankFusion,
  createCloudflareVectorStore,
  createNoopVectorStore,
  VECTOR_BACKEND_COOLDOWN_MS,
  type VectorStore,
  type Embedder,
  type VectorizeIndex,
  type VectorRecord,
  type IndexedChunk,
  type VectorSearchHit,
} from './memory/vector-store';

export {
  hybridSearch,
  memorySnippetRehydrator,
  type LexicalHit,
  type HybridHit,
  type LexicalSearchFn,
} from './memory/hybrid-search';

// Memory writes
export { memoryBytes } from './memory/note';

export { appendMemoryNote, MEMORY_PATH, parseMemoryNotes, readMemoryTail, type MemoryNote } from './memory/note';

export {
  ConversationSearchStore, invalidateConversationSearchIndex,
  type ConversationRecall, type ConversationSearchHit,
  type ConversationScrollResult, type ConversationSummary,
} from './memory/conversation-search';

// Top-K recent agent_facts render into the system prompt every turn.
export {
  initFactsTable, createFactsStore, renderFactsBlock, searchFacts, normalizeFactKey, unifiedFacts,
  ACCOUNT_FACTS_ACTOR, FactOriginSchema, FactRevisionSchema, FactSchema, VERACITIES,
  type Fact, type FactsStore, type FactSearchHit, type FactOrigin,
  type MemoryScope, type Veracity,
} from './memory/facts';

export {
  AccountMemoryStore, AccountMemoryProposalSchema, AccountNoteSchema, AccountProposalSchema, initAccountMemoryTables,
  type AccountMemory, type AccountMemoryProposal, type AccountMemoryView, type AccountNoteHit, type AccountProposal,
  type AccountProposer,
} from './memory/account';

export {
  JsonValueSchema, JsonObjectSchema, JsonArraySchema,
  parseJsonValue, parseJsonObject, parseJsonArray, safeJsonParse, decodeJsonValue, jsonResultOrVoid, projectJsonValue, nonEmptyString,
  binaryReplacer, type JsonPrimitive, type JsonObject, type JsonValue,
} from './utils/json';

export { MarkdownFrontmatterError, parseMarkdownFrontmatter } from './utils/markdown-frontmatter';

export { compareCodeUnits } from './utils/text';

export {
  runSleepTimeCompute, applySleepTimeUpdate, accountProposals,
  SleepTimeUpdateSchema,
  SLEEP_TIME_CADENCE,
  sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type SleepTimeUpdate, type SleepTimeWindow,
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
  RunEventRecorder, holdRunHeads, type StepSpendSource,
  boundRunEventQuery,
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
  buildModelCallEvent, pricedModelCallEvent,
  type ModelCallReport,
  type ModelCallSpend,
  type ModelCallSink,
  type ModelOperation,
  type ModelOperationEvent,
  type ModelOperationKind,
  type ModelOperationOutcome,
  type ModelOperationPhase,
  type ModelOperationSink,
  type AccountSpend,
  type SpendSource,
  type SpendTally,
  type DeferredRunEvent,
  type RunEventListener,
  type RunEventQuery,
  type BoundedRunEventQuery,
  type StoredRunEvent, type StoredRunEventRow,
  type ContextMeasures,
} from './events/index';

export { contextFill, type ContextFill } from './read-models/context-fill';

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

export * from './events/ingress/index';

export * from './subordinates/ingress';

// Swarm
export * from './strategy/index';

// Eval harness

// Bench harness: pure math; the runner lives in scripts/bench.ts.
export * from './bench/index';

export * from './curriculum/proposer';

// Providers. Secrets stay inside UserDO and never enter the provider layer.
export * from './providers/index';

export type { Credential, OAuthCredential, OpenAICompatCredential } from './credentials/store';

// Credential store policy
export {
  createCredentialCipher,
  type CredentialCipher,
} from './credentials/envelope';

export {
  credentialToHeaders,
  type CredentialHeaders,
} from './credentials/headers';

export {
  validateCredential,
  validateCredentialKey,
} from './credentials/validate';

export {
  MAIN_ACCOUNT,
  accountCredentialKey,
  accountOf,
  baseCredentialKey,
  isAccountName,
  splitAccount,
  storedAccounts,
} from './credentials/accounts';

// Plan review
export {
  MAX_PLAN_ANNOTATIONS_BYTES,
  MAX_PLAN_CONTENT_BYTES,
  PlanReviewActions,
  PlanReviewStore,
  PlanReviewSchema,
  PlanReviewResultSchema,
  PlanDecisionOutcomeSchema,
  planHandoffShortfall,
  planDecisionRefusal,
  admitReviewAnnotations,
  freshNotes,
  planAwaitingReply,
  planSubmissionReach,
  reviewFeedbackText,
  DiffAnchorSchema,
  applyPlanEdits,
  formatPlanWithLineNumbers,
  initPlanReviewTable,
  workModeUnderReview,
  planHandoffStillOwed,
  approvedTaskPlan,
  planReviewAwaitingDecision,
  planTitle,
  validatePlanEdits,
  type PlanDecisionOutcome,
  type PlanEdit,
  type PlanAnnotationMathTarget,
  type PlanAnnotationTextPosition,
  type PlanReview,
  type ReviewAnnotation,
  type GeneralNote,
  type NoteReply,
  type PassageNote,
  type DiffAnchor,
  type DiffSide,
  type PlanReviewDecision,
  type PlanReviewResult,
  type PlanReviewStatus,
  type PlanReviewStoreOptions,
  type SubmitPlanToolDeps,
  type ReplyToCommentToolDeps,
} from './plans/index';

export {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  dataUrlRawBytes,
  DEV_IDENTITY_ACCOUNT_HEADER,
  DEV_IDENTITY_HEADER,
  EVAL_ACCOUNTS,
  EVAL_TRIAL_ACCOUNTS,
  inheritedRows,
  parseEvalAccount,
  type EvalAccount,
  DEVICE_CONNECT_PATH,
  DEVICE_TERMINAL_PATH,
  ORCHESTRATOR_AGENT_SLUG,
} from './cloud-wire';

// Platform facts: prose cites an entry by its id and never restates the number.
export {
  BOUNDS_KINDS,
  PLATFORM_CATALOG,
  platformFactIds,
  injectableFaults,
  platformFact,
  platformFactEntries,
  silenceBoundMs,
  type EvidenceLabel,
  type PlatformFact,
  type PlatformFactEntry,
} from './platform-catalog';

// Safety
export {
  reviewCommand, type ApprovalDecision, type ApprovalResult,
  type FilesOwner, type GatedExecutor,
} from './safety/command-review';

export {
  formatApproval, gatedGrants, formatApprovalGrant, holdsGrant, parseApprovalGrant, gateExec, grantsAreSubset,
  resolveInheritedGrants, createInheritedApprovalPolicy, STRICT_NO_CHANNEL_POLICY, describeExecutionContext,
  type ExecutionContext, type CommandCall, type PreparedCall, type ApprovalGrant, type ShellApprovalRequest,
  type ShellApprovalOutcome, type ShellApprovalPolicy, type DeferredApprovalChannel,
  type ApprovalSpend,
} from './safety/approval-gate';

export {
  EGRESS_PLACEHOLDER_PREFIX, PLACEHOLDER_BODY_LENGTH, isEgressPlaceholder, egressPlaceholdersIn, egressGrants,
  grantedEgressBindings, findEgressPlaceholders, egressHostMatches, planEgress, scrubBytes, closeReason, scrubText,
  createScrubStream, type EgressSecretBinding, type EgressRequestFacts,
  type ScrubReplacement,
} from './safety/egress-gate';

export {
  DeferredApprovalQueue, decideDeferredApprovals, DeferredApprovalStore, initDeferredApprovalsTable,
  DEFERRED_APPROVAL_SIGNAL, DENIAL_STANDING_MS, DeferredApprovalSchema, type DeferredApproval,
  type DeferredApprovalAnswer,
  type DeferredApprovalNotice, type ParkedWrites,
} from './safety/deferred-approval';

export {
  initEgressVaultTables, listEgressSecrets, putEgressSecret, revokeEgressSecret, resolveEgressInjection,
  type EgressSecretSummary, type PutEgressSecretInput, type EgressInjection, type EgressInjectionResult,
  type EgressVaultDeps,
} from './safety/egress-vault';

export {
  ownerCaller, OwnerCapabilityUnavailableError, CapabilityDeniedError, initWorkspaceCapabilityTables,
  workspaceCapabilityHash, freshWorkspaceCapability, commitWorkspaceCapability, revokeWorkspaceCapability,
  requireTier, type WorkspaceCapability, type UserCaller, type ResolvedCaller,
  type OwnerCapabilityEnv,
} from './safety/workspace-capability';

export {
  argumentDigest, sha256Hex, stableStringify,
} from './safety/argument-digest';

export {
  InstructionApprovalStore, initInstructionApprovalsTable, instructionDigest, trustOfInstructionApprovals,
  admitInstructionDecision, type InstructionTrust, type InstructionDecision, type InstructionApproval,
  type InstructionTrustResolver, type VerifiedInstructionTrust, type AdmittedInstructionDecision,
} from './safety/instruction-trust';

export {
  DeviceConsentRegistry, DeviceConsentStore, deviceConsentOutcome, type DeviceConsentOutcome, RESUMED_SURFACE,
  DEVICE_CONNECT_DISCLOSURE, issuedDeviceConnected, summarizeDeviceAction,
  type DeviceConsentAnswer, type DeviceConsentRequest, type DeviceConsentVerdict, type DeviceBinding,
  type PendingDeviceConsent, type DeviceConsentNotice, PendingDeviceConsentSchema, ResolvedDeviceConsentSchema,
} from './safety/device-consent';

export {
  WorkspaceProposals, WorkspaceProposalStore, initWorkspaceProposalsTable, proposedSoul, type WorkspaceProposal,
  type WorkspaceProposalAnswer, type WorkspaceProposalInput, type WorkspaceProposalReceipt,
} from './safety/workspace-proposals';

export {
  SECRET_PATTERNS, redactSecrets, type SecretPattern,
} from './safety/secret-patterns';

export {
  scanText, countDetections, secretSightings, type SecretFinding, type SecretSighting,
} from './safety/secret-scan';

export {
  boundWriteOf, performBoundWrite, type ApprovalContent, type BoundFileWrite, type WriteSubject,
} from './safety/bound-write';

export {
  ParkedWriteFiles,
} from './safety/parked-write-files';

export {
  egressHost,
  refusedHostname,
} from './safety/egress-destination';

export { revealMisrepresenting } from './safety/untrusted-text';

export { fnv1a64, Fnv1a64 } from './utils/fnv1a';

export { nanoid } from './utils/nanoid';

export { abortCause } from './utils/abort';

export { base64Url, createPkcePair, hmacSha256Hex, randomToken, timingSafeEqual } from './utils/crypto';

export { labelSigner, type LabelSignerEnv } from './utils/label-signer';

export { shellQuote } from './utils/shell';

export {
  wilsonInterval, scoreInterval, formatScoreInterval, seededRandom,
  type ScoreInterval,
} from './utils/stats';

export { isoDate, nowMs } from './utils/date';

// Branching heads
export type {
  HeadId, HeadBudget, HeadInput, HeadReport, HeadReportStatus, HeadUnsettledStatus,
  HeadStep, HeadRunView, HeadRunHeadView,
  Evidence, Decision, ArtifactRef,
  SplitRequest, MergeResult, HeadScore, MergeStrategy,
  HeadFileChange, HeadFileChangeSet,
  SerializedMessage,
} from './heads/index';

export {
  DEFAULT_MERGE_STRATEGY,
  deriveChildBudget,
  headStatusUnsettled, storedHeadReportStatus, OWNER_STOPPED, shownHeadStatus,
  initHeadsTables,
  HeadJournal, type HeadJournalRow, type LiveHeadRun, type AbandonedHeadRun,
  LiveHeadJournal, type AnnounceHeadActivity,
  type HeadStreamFrame, type HeadStreamKind,
  type ReportHeadDelta, type PublishHeadStream,
  reconcileInterruptedForks, jobRedriveResumeGate, resumableForkRoots,
  FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
  ForkNotices, forkNoticeDeliveries, initForkNoticeTable, type ForkNotice,
  HeadController, runHeadSplit, type HeadRuntime, type HeadGrounding, type SpawnedHead, type MergeLLMFn,
  type SplitPhaseEvent,
  type HeadJournalPort,
  MergeOutputSchema, DecisionSchema, type MergeOutput,
  // Resolved here so both backends resolve it identically.
  headMergeLLM,
  type HeadMergePolicyDeps,
  extractFinalText, synthesizeHeadSummary, headProducedFindings,
  HeadCapture, runHeadInference, preparedHeadRun, type HeadRun, buildHeadAccumulatorTools,
  buildHeadSystemPrompt, buildHeadMessages,
  type HeadInferenceDeps, type RunInference,
  buildHeadToolSet, HEAD_BUILTIN_TOOLS, spawnSeatedHead, type HeadSeat, type SeatedHeadDeps,
  type HeadToolDeps, type HeadSplitRequest, type HeadSplitResult,
  HeadFileChanges,
} from './heads/index';

// Background jobs
export {
  BackgroundJobStore, initBackgroundJobsTable, serializeJobResult, withBackgroundThreshold, withSpawnDetach,
  backgroundJobNotice,
  SPAWN_STARTED_OPTION, readSpawnStarted,
  DEVICE_REQUEST_OPTION, readDeviceRequestChannel, DeviceRequestOwnership, execCallArgs, execContext,
  BackgroundJobRunner, JobNotResumable, BACKGROUND_POLICY, JOB_STAMP_ENV, MAX_CONCURRENT_DETACHED_JOBS, recordServingJobs, type PortHolders, type ServingScope,
  invocationBackgroundPolicy,
  backgroundJobWakeTrigger, BACKGROUND_FIBER_PREFIX,
  type BackgroundJob, type BackgroundJobStatus, type BackgroundHandle, type ThresholdDeps,
  type BackgroundPolicy, type DetachOutcome, type InvocationSurface, InvocationSurfaceSchema,
  type BackgroundJobRunnerDeps, type JobHolder, initJobHoldersTable, processJobHolder, type JobResumer, type JobClaim, type DeviceRequestChannel, type WorkspaceJobPorts,
  WorkspaceJobAuthorities, endedStepLoopJobs, inlineResultInbox, type JobAuthority, type JobAuthorityKind, type JobRetirement, type StepLoopJobSeat,
  JobOutputFeeds, JOB_OUTPUT_EVENT, JobOutputFrameSchema, JobOutputTailSchema, followJobOutput, lastOutputLines, jobName, shortJobId, type JobName,
  type JobOutputFrame, type JobOutputTail,
} from './jobs/index';

export {
  TaskListStore, initTaskListTable, taskSettled, taskTreePhase,
  type AgentTask, type AgentTaskTree, type TaskStatus,
} from './tools/task-store';

export { withTaskPlan, bindTaskPlan, type TaskPlan, type TaskPlanContext } from './tools/task-plan-scope';

export {
  TaskReminders, TASK_REMINDER_EVENT,
  taskReminderIdempotencyKey,
} from './tasks/reminder';

export {
  TurnAccumulator,
  type StepLike, type TurnSinks,
} from './orchestrator/turn-accumulator';

export { readWorkspaceWork, hasWorkspaceWork, actorReadHandle, WorkspaceWorkSchema, WORK_TAB_JOBS } from './read-models/workspace-work';

export { agentTitle, nestedAgent, type AgentLinkIds, type InspectSubordinate } from './subordinates/nested-agent';

export { recognizeGitHubHttp, recognizeGitHubMcp, GitHubFactSchema, GITHUB_MCP_PRESET, type GitHubFact } from './github/recognize';

export { observeGitHub, type GitHubRecorder } from './github/observe';

export {
  readGitHubActivity, recordGitHubActivity, recordGitHubObservations,
  type GitHubCi, type WorkspaceGitHub,
} from './github/activity';

export {
  gitHubRefreshAsk, GitHubRefreshAskSchema, refreshGitHub, type GitHubRefreshAnswer, type GitHubRefreshAsk,
  type WorkspaceGitHubView,
} from './github/refresh';

export { readGitHubRemotes } from './github/remotes';

export {
  mainPanelAgent, readWorkspaceAgents,
  type PanelAgent, type AgentActivity,
} from './read-models/workspace-agents';

export { readAgentFigures, recordAgentFigures, reportedAgentFigures, NO_FIGURES, type AgentFigures } from './read-models/agent-figures';

export type { WorkspaceWork, OwnedPlan, WorkspaceWorkOwner } from './read-models/workspace-work';

export { openingList, openingListOf, listedOn } from './read-models/opening';

export { AgentOrchestrator, drainPendingEvents, type AgentOrchestratorDeps } from './orchestrator/agent-orchestrator';

export { ActorAdvisor, type ActorAdvisorContext } from './advisor/actor-advisor';

export {
  EvolutionLanes, improvementLanesOpen, evolutionPassOpen, recordedTurn, type EvolutionLanesDeps, type TurnContinuity,
} from './orchestrator/evolution-lanes';

export { ActorSession, CLEAR_NEEDS_IDLE, type ActorSessionOptions, type ActorTurnLease, type ActorExecutionInput, type ActorExecutionResult } from './orchestrator/actor-session';

export {
  ChatSession, type ChatSessionPorts, type OpenWork, type CompactOutcome, type ComposedRequest, type ChatTransport, type ChatTurnInput,
  type PreparedTurn, type TurnOpening, type TurnOpeningAsk, openingCacheCold, type OwedTerminalEffectsInput, type SessionEvent, type TurnEndEvent, type SendOptions,
  STEP_CUT_CHUNK, StepCutDataSchema,
} from './orchestrator/chat-session';

export type { DeliveredRun } from './orchestrator/chat-queue';

export { startActorTurn } from './orchestrator/actor-turn';

export {
  ActorClaimStore, claimFences, initActorClaimTables, programIdentityOf, turnAttemptOf, verifyClaimedProgram,
  type ActorProgramIdentity, type ActorTurnClaim, type StoredActorClaim,
  type ContextRevision, type ClaimOutcome,
} from './orchestrator/actor-claims';

export { prepareActorProgram, type ActorTurnProgram } from './orchestrator/actor-program';

export { USER_MESSAGE_SIGNAL_KIND } from './types/signals';

export {
  TurnSteering,
} from './orchestrator/turn-steering';

export {
  CompletionGate, observeCompletionState, completionGateText,
  COMPLETION_GATE_EVENT,
} from './orchestrator/completion-gate';

export {
  assembleTurnMessages,
  type TurnContextInput, type CompactionTriggerReader,
} from './orchestrator/turn-context';

export {
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery, creditedTurnId,
  classifyRunEnd, RUN_END_REASONS, TOOL_CALLS_PENDING, OUTPUT_LIMIT_REACHED, TURN_ENDED_MID_WORK,
  owesOutputLimitContinuation, OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT,
  type CompactionTriggerState, type SettledTurn,
  type RunEndReason, type RunEndFacts, type RunEndClassification,
} from './orchestrator/turn-lifecycle';

export {
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  type ScaffoldBridgeOpts, type ScaffoldHistoryQuery, type ScaffoldHistoryReader,
  type ScaffoldHistoryEntry, type ScaffoldHistoryPage,
} from './orchestrator/scaffold-host';

export { createScaffoldCandidateSurface, type ScaffoldCandidateBinding } from './evolution/scaffold-candidate';

export { activeOperationProfile, captureOperationProfile, currentOperationProfile, resolveOperationProfile, runOperationProfile,
  withOperationProfile, operationProfileStream, type OperationProfile } from './profiles/operation';

export {
  bindRoute, completeOnRoute, createRoutedModelLane, routedCallOptions, routedLlm, type RouteModelBinder, type RouteModelBinding,
} from './profiles/model-lane';

export { tierRefusals } from './profiles/tier-refusals';

export type { TierRefusals } from './types/refusals';

export {
  BACKGROUNDABLE_TOOLS, resumeBackgroundJob, resumableBackgroundJob, harvestBackgroundJob,
} from './orchestrator/background-tools';

export {
  CONFINED_BACKGROUNDABLE_TOOLS, type ActorJobs, type BackgroundableTool,
} from './jobs/background-wrap';

export {
  resolveTurnSkills, steerSkillsBlock, splitTurnSkills, activatedSkillsBlock, filterToolSetBySkills,
  renderFactsForTurn, type TurnSkillsConfig, type TurnSkillSurface,
} from './orchestrator/turn-surface';

export { ModelCatalogSession, resolveEffectiveModelSpec, type ModelCatalogRead } from './orchestrator/model-catalog';

export type { TurnAuthorship } from './types/turn';

export {
  turnTags, stampTurnAuthor, authoredTurnMetadata, stampAuthorship, TURN_AUTHOR_METADATA_KEY, MISSION_LABELS_METADATA_KEY,
  type TurnTags,
} from './types/turn-metadata';

export {
  AgentDeliveries, AgentStops, DeliveryInbox, DeliverySchema, wordsRefusal, initAgentDeliveriesTable, initAgentStopsTable, pendingEventsDelivery, assignmentDelivery, deliveryMetadata, deliveredSignal, handBackCarried, type OwedDelivery, type DeliveryPort, type OwedAdmission, type Delivery, type DeliveryAnswer, type DeliveryInput, type TurnDeliveryInput, type IntentInput, type IntentResult, type OwedIntent, type OwedOwnerIntent, OwedIntentSchema, OwedOwnerIntentSchema,
  SendMetadataSchema, sentWords, type SendMetadata, type SentWords,
} from './subordinates/deliveries';

export { DeliveryCoordinator, InProcessDeliveries, type CrossedDelivery } from './subordinates/delivery-coordinator';

export {
  serializeContentForHeads, narrowInheritedRole,
  inheritedContextFromHistory, inheritedContextFromTranscript,
  inheritedContextOmissionNote,
} from './orchestrator/heads-support';

export {
  parseSkillFile, skillNameProblem,
  discoverSkills, readSkillFile, workspaceSkillPath, skillBodyChars,
  BUILTIN_SKILLS, BUILTIN_SKILL_FILES, BUILTIN_SKILL_HEADERS, BUILTIN_SKILL_NAMES, skillsMount,
  resolveActiveSkills, extractExplicitInvocations, admitSkillsIndex, admitActiveSkills,
  renderActiveSkillsSection, renderSkillsIndexSection, skillIndexLine, unreadSkillLine,
  unionAllowedTools, toolAllowedBySkills, trustedActiveSkills,
  SKILLS_VIEW, WORKSPACE_SKILLS_DIR, SKILL_FOLDER_FILE, skillReference, skillViewPath,
} from './skills/index';

export type {
  SkillHeader, ParsedSkill, DiscoveredSkill, ActiveSkill, SkillBodyRef,
  SkillsIndex, SkillSource, ActiveSkillSet, ActivationReason,
  SkillParseResult,
  DiscoverOpts, SkillsDiscovery, UnreadSkillFile, SkillFileRefusal,
  LoadActiveSkillsOpts, ActivatedSkill,
} from './skills/index';

// GEPA (Agrawal et al., ICLR 2026, arxiv 2507.19457)
export {
  applyScaffoldDecision, getEvolutionStatus, listScaffoldVersions,
  previewScaffoldLive, proposeScaffold, runOptimization, runScaffoldOnce,
  type EvolutionStatus, type ScaffoldControl,
  type ScaffoldDecisionResult, type ScaffoldReplayContext, type ScaffoldSurface, type ScaffoldVersionView,
} from './evolution/control';

// The proposer, its artifact store and live trials (docs/EVOLUTION-REDESIGN.md §3-5).
export {
  artifactOverrides, artifactVersion, bundledArtifact, currentArtifacts, listArtifactVersions,
  sectionArtifact, toolArtifact, writeCandidate,
  type ArtifactOverrides, type ArtifactStatus, type ArtifactVersion,
} from './evolution/artifacts';

export { judgeAuthoredEdit, runProposer, SCAFFOLD_ARTIFACT, type ProposerOutcome } from './evolution/proposer';

export { advanceTrial, runningTrial, startTrial, turnArtifactBodies } from './evolution/trials';

export { drawArm, type LiveTrial, type TrialArm, type TrialTurn, type TrialVerdict } from './evolution/trial-rules';

export { withToolText, type ToolTextOverrides } from './tools/tool-text';

// Continual refinement: each proposed edit routes to the authority that owns the artifact.
export {
  REFINEMENT_EDIT_KINDS, RefinementProposalSchema,
  createRefinementStore, evolutionDebt, initRefinementTables, nextEvolutionAnswerAt, refinementRequestView,
  refinementStagingPath, RefinementRequestViewSchema,
  type EvolutionDebt, type RefinementDeps,
  type RefinementDisposition, type RefinementEdit,
  type RefinementProposal, type RefinementRequest,
  type RefinementRequestView, type RefinementRoute, type RefinementScope,
  type RefinementStage, type RefinementStore, type RefinementTrigger,
  type SettleRefinementPatch,
} from './evolution/refinement';

export { type RefinementLaneStep } from './evolution/refinement-lane';

export {
  listRefinements, evolutionAnswerWake, refinementPass, requestOwnerRefinement, RefinementListingSchema, type RefinementListing,
} from './evolution/refinement-host';

export {
  REFINEMENT_DECISIONS, decideRefinementRoute, showRefinementRoute, RefinementDecisionResultSchema, StagedSkillResultSchema,
  type RefinementDecisionInput, type RefinementDecisionResult,
  type StagedSkillResult, type StagedSkillView,
} from './evolution/refinement-skill';

export {
  runGepa,
  DEFAULT_GEPA_BUDGET,
  initGepaTables, startGepaRun, finishGepaRun,
  listGepaRuns, loadGepaCandidates, loadGepaParetoFront, makePersistingHooks, aggregateScore,
} from './evolution/gepa/index';

export type {
  EvalInstance, MetricOutcome, GepaMetric, ReflectionLM,
  GepaCandidate, GepaConstraints, GepaBudget, GepaConfig,
  GepaIterationState, GepaProgressHooks, GepaResult,
  GepaRunSummary, GepaStopReason,
  GepaParetoEntry,
} from './evolution/gepa/index';

export type { PromptSectionOverrides } from './prompting/section-templates';

export {
  getRunTimeline,
  RUN_TIMELINE_MAX,
} from './read-models/timeline';

export type { TimelineSpan } from './read-models/timeline';

// The one bound a caller-supplied row count passes before SQL; CLI read models import it.
export { boundedInt } from './utils/bounds';

// The retry curve of every durable recovery lane; backends import it, never copy it.
export { RECOVERY_BACKOFF_CEILING_MS, recoveryBackoffMs } from './utils/recovery-backoff';

export { getRunEvents, getRunEventText, getRunSummaries, listRuns } from './read-models/runs';

export { turnRequestIndex, turnRequestPage } from './read-models/turn-requests';

export type { TurnRequestIndex, TurnRequestPage } from './read-models/turn-requests';

export type { RunListEntry, RunSummary } from './read-models/runs';

export { headStepSources, spendLedger, workspaceSpend } from './read-models/workspace-spend';

export {
  AccountSpendSchema, AccountUsageSchema, accountSpendOfCall, mergeAccountSpend, readAccountUsage,
  type AccountUsage,
} from './read-models/account-usage';

export type {
  ProducerSpend, SpendLedger, WorkspaceSpend,
} from './read-models/workspace-spend';

export {
  censusToolFailures, classifyToolFailure, toolFailureKey,
} from './read-models/tool-failures';

export type {
  ToolFailure, ToolFailureCensus,
} from './read-models/tool-failures';

export {
  CHANGES_MOVED_EVENT, ChangeSetCache, getExecutorDiff, getWorkspaceDiff, resetWorkspaceBaseline, restoreWorkspaceBaseline,
} from './read-models/workspace-diff';

export type {
  ExecutorDiffResult, WorkspaceBaselines, WorkspaceDiffResult, WorkspaceReviewResult,
} from './read-models/workspace-diff';

export {
  LIVE_READS, LiveReadsNotice, PAGE_KEEPALIVE, READS_CHANGED_EVENT, ROSTER_READS, readsMovedByFiles, readsWrittenBy, readsOfTables,
  type LiveRead, type ReadsChangedFrame,
} from './read-models/live-reads';

export {
  anchoredText, changeBlocks, changeBody, changeTotals, changeTree, comparePaths, inReadingOrder, keepUnchanged, sideBySide,
} from './read-models/change-view';

export {
  ALL_CHANGES_BLOCK, changeNoteAnchor, changeNotesCard, initChangeNotesTable, inNoteOrder, readChangeNotes, saveChangeNotes, sendChangeNotes,
  deliverOwedChangeNotes, owesChangeNotes,
} from './read-models/change-notes';

export type { ChangeNote, ChangeNotesCard, ChangeNotesChat, ChangeNotesMessage, ChangeNotesResult, NotedChanges } from './read-models/change-notes';

export type {
  ChangeBlock, ChangeRow, ChangeSet, ChangeSpan,
} from './read-models/change-view';

export {
  diffLines, fileDiff, parseGitDiff, MAX_LINES_PER_FILE,
} from './vfs/diff';

export type { DiffLine, FileDiff, FileStatus, Omitted } from './vfs/diff';

export {
  getExecutorFiles, readExecutorFile, sortDirEntries, writeExecutorFileOp,
  readExecutorFileBytes, statExecutorFile, renameExecutorPathOp, deleteExecutorPathOp,
  listEnvironments, joinDir, parentDir,
  FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, FILES_PAGE_ENTRIES, shownEntries,
  ExecutorFileUpload, ExecutorFileDownload, ChunkedUpload, pumpUploadChunks,
} from './read-models/files';

export type {
  DirEntry, EnvironmentInfo, ExecutorFileLookup, ExecutorRowLookup, ExecutorTextFile, ExecutorWriteResult,
  FilesPage, FilesRequest,
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
  MctsProgressState,
} from './read-models/mcts-progress';

export type { ForkRunParams } from './read-models/fork-params';

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
  NodeTranscriptView,
} from './read-models/node-transcript';

export { buildPendingActions, needsTheUser, ownerAsks, type OwnerAsk } from './read-models/pending-actions';

export { reviewParkedWrite, type ParkedWriteReview } from './read-models/write-preview';

export {
  listInstructionApprovals, readInstructionSource, openInstructionSource,
  previewInstruction, gatherApprovableInstructions,
} from './read-models/instruction-approvals';

export { InstructionApprovalDesk } from './read-models/instruction-desk';

export type {
  InstructionSourceMeta, InstructionSourceRow,
  InstructionSourceView,
} from './read-models/instruction-approvals';

export { agentStatusFacts, getAgentStatus, getChatHistoryPage, getToolList, type ChatHistoryPage } from './read-models/status';

export { mapPage, pageSchema, positionPageSchema, PositionCursorSchema, PositionPageRequestSchema, seekPage, SeekCursorSchema, StaleCursorError } from './session/page';

export type { Page, PageRequest, PositionCursor, PositionPageRequest, SeekCursor } from './session/page';

export {
  restoredRows, rowText, transcriptRole, UIMessageSchema,
  PROGRAMMATIC_MESSAGE_ID_PREFIX, announcementOf,
} from './utils/ui-message';

export type { PendingAction, PendingActionKind, PendingActionInputs, PersonAsks } from './read-models/pending-actions';

export { buildWorkspaceOverview, rosterBucket, rosterHeadline, rosterMatches, WorkspaceOverviewSchema } from './read-models/workspace-overview';

export { ownerIsAway, watchFrame, type AlertWatch, type OwnerAlert } from './read-models/owner-alerts';

export { OverviewPush, type OverviewPushHost } from './read-models/overview-push';

export {
  AccountForegroundFrameSchema, AccountMemoryFrameSchema, CredentialSummarySchema, ForegroundReportSchema, ModelMenuResponseSchema,
  ProviderCatalogEntrySchema, RosterFrameSchema, RosterPageSchema, UserProfileSchema, WorkspaceEntrySchema,
  type AccountForegroundFrame, type AccountMemoryFrame, type CredentialSummary, type ForegroundReport, type ModelMenuEntry, type ModelMenuResponse, type ProviderCatalogEntry,
  type RosterCounts, type RosterEntry, type RosterFrame, type RosterPage, type UserProfile, type WorkspaceEntry,
} from './read-models/account-wire';

export type {
  RosterBucket, WorkspaceOverview, WorkspaceOverviewInputs, WorkspaceOverviewShare, WorkspaceStatus,
} from './read-models/workspace-overview';

export type {
  ActorSnapshot, AgentStatus, ChatHistoryEntry, ToolListEntry,
} from './read-models/status';

export {
  cancelBackgroundJob, cancelCurrentWork, clearBackgroundJobs, dismissBackgroundJob,
  listBackgroundJobs, retryBackgroundJob,
} from './read-models/background-jobs';

export type {
  BackgroundJobControl, CancelWorkOutcome, ListedBackgroundJob, RetryOutcome,
} from './read-models/background-jobs';

export {
  getAlwaysActiveSkills, getEvolutionConfig, getProviderAccounts, getReasoningEffort,
  getShellApprovalMode, getShellApprovalGrants, revokeShellApprovalGrants,
  getStoredModelSpec, setAlwaysActiveSkills, setEvolutionConfig,
  setModel, setProviderAccount, setReasoningEffort, setShellApprovalMode,
  EvolutionConfigViewSchema, ProviderAccountsSchema, ReasoningEffortViewSchema, ReasoningEffortWriteSchema, SetModelResultSchema,
  StoredModelSpecSchema,
} from './read-models/config-plane';

export type {
  EvolutionConfigView, SetModelDeps,
} from './read-models/config-plane';

export {
  ADVISOR_EVENT_TYPE,
  ADVISOR_NOTE_MAX_CHARS,
  ADVISOR_SEVERITIES,
  AdvisorRowDataSchema,
  ADVISOR_SEVERITY_LABEL,
  ADVISOR_SEVERITY_METADATA_KEY,
  ADVISOR_SIGNAL_KIND,
  DEFAULT_ADVISOR_MIN_SEVERITY,
  ADVISOR_DEDUPE_WINDOW,
  ADVISOR_HEADER,
  judgeAdvisorReply,
  sayAdvisorNote,
  ADVISOR_ROLE_ID,
  AdvisorRecoverySnapshotSchema,
  buildAdvisorPrompt,
  isContentFree,
  isDuplicateNote,
  judgeNote,
  normalizeNote,
  parseAdvisorReply,
  type AdvisorRecoverySnapshot,
  type AdvisorNote,
  type AdvisorSeverity,
  type AdvisorRowData,
} from './advisor/review';

export { isAdvisorSeverity } from './types/advisor';

export {
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
} from './read-models/evolution-views';

export { EvolutionChangelogViewSchema, type EvolutionChangelogView } from './read-models/evolution-views';

// Profile catalogs
export {
  TIER_IDS, DEFAULT_PROVIDER_RETRIES, TierIdSchema, tierIdsOf, isTierId, ROLE_ID_RE,
  isValidRoleId, validateProfileCatalog, validateProfileCatalogEnvelope,
  profileCatalogCanonical, profileCatalogDigest, deriveRoleLabel, effectiveRoleCatalog,
  BUILTIN_ROLE_DEFINITIONS, BUILTIN_PROFILE_CATALOG,
  ProfileCatalogEnvelopeSchema, betaSwarms, SWARMS_BETA_SETTING,
} from './profiles';

export type {
  TierId, BuiltinTierId, BuiltinRoleId, RoleId,
  TierAssignment, TierAssignments, RoleDefinition, RoleCatalog, ProfileCatalog,
  ProfileAuthority, ProfileCatalogEnvelope,
} from './profiles';

export {
  resolveModelRoute,
  loadProfileAuthorityInputs, resolveTurnProfile, resolveRoutingProfile, parentReasoningEffort, ownProfileChoices, ancestorPins,
  type ProfileAuthorityInputs, type ProviderCatalogSnapshot, type TierSource, type PinnedProfile,
  type ResolveTurnProfileInput, type ResolvedTurnProfile,
  type ModelRoutePolicy, type ProfileRoutedSource, type ModelRouteResolution,
  type FixedTierSource,
  DEFAULT_ROLE_ID,
  providerListingOf, providerSnapshotOf, ProviderListingCache,
  type ProviderListing, type ProviderCacheOutcome, type ProviderSnapshotRead,
  agentRoleSwitch, changeRoleAsOwner,
  type RoleChangeActor, type RoleChangePolicy, type RoleChangeOutcome,
  type RoleChangeRefusal, type RoleStateStore,
} from './profiles';

export { clockTime, fmtPct, fmtSpan, fmtTokens, fmtUsd, formatBytes, shortAge, timeAgo } from './utils/format';

export { ownedStream, relayedAnswer } from './utils/relayed-answer';

export { inheritedDescriptor, type RpcSurfaceSubject } from './utils/prototype-members';

export {
  type ActivitySnapshot, type ExecutorCommandResult, type ForkNode, type ForkNodeLifecycle,
  type MemoryEntry, type PendingConsent, type SubordinateActivityEvent,
  type TabPresence, evolutionHelper, ownerFacingSubordinate,
} from './protocol';

export { resumeIndexFromLastEventId } from './protocol/run-events-cursor';

export { buildTree, explorationForkTree, type MctsRow } from './read-models/fork-tree-rows';

export {
  executorLabel, executorSortKey, isActiveExecutionDevice,
  pickDefaultExecutor,
} from './read-models/executors';

export {
  BUSY, LINE_MODE_LABEL, LineTerminalState, type TerminalPaneOutput,
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
  buildSlateShareHost, parseSlateShareLabel,
} from './preview/slate-share-host';


export {
  PREVIEW_SANDBOX, containPreviewResponse, extractPreviewUrl, hostOf, isPreviewHostRequest,
  isPreviewUrl, previewHostSuffix, previewPortSuffix, previewSuffixMetaName, sandboxPreviewLabelOf,
  type PreviewPortEnv, type PreviewSuffixEnv,
} from './preview/preview-origin';

export {
  previewPortTitle, reconcilePreviewPorts,
  type ExecutorPortRefresh, type ExposedPortList, type PinnedPreviewPort,
} from './preview/preview-ports';

export {
  sandboxPreviewExposed, sandboxPreviewExposures,
  type SandboxPreviewExposures,
} from './preview/preview-exposures';

export {
  err, ERROR_STATUS, escapeHtml, fileResponseHeaders, json, PUBLIC_MESSAGE, publicError, publicText,
  readBounded, readBoundedStream, reoriginateRequest, requestUrl, safeJson,
} from './http/http';

export { KINU_USER_AGENT, kinuUserAgent } from './utils/user-agent';

export { PRIVATE_NO_STORE, publicHtmlHeaders, withAppSecurityHeaders } from './http/security-headers';

export { desktopClientUrl } from './http/desktop-client';

export { serveApp } from './http/app-shell';

export { ingressAdmission, ingressAdmitted, ingressDenied, peerIp } from './http/ingress-budget';

export {
  CLI_DIST_PATHS, CLI_RUNTIME_PATH, CLI_VERSION_PATH,
  BuildStampSchema, fetchDeployedAsset, readBuildStamp, type AssetFetcher, type BuildStamp,
} from './http/deployed-assets';

export {
  releaseArtifact, releaseArtifactHead,
} from './http/release-artifact';

export { RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SIGNING_PUBLIC_KEY_ENV, verifyRelease } from './http/release-message';

export {
  SignedReleaseSchema, signRelease, generateReleaseSigningKey, type ReleaseChecksums, type SignedRelease,
} from './http/release-signing';

export {
  DEVICE_UPDATE, DEVICE_UPDATE_STATES, cliArtifactPath, deviceUpdateState, isSameBuild,
  type DeviceUpdateFrame, type DeviceUpdateState,
} from './http/device-update';

export {
  COPY_SCRIPT, GITHUB_ICON, REPO_URL,
  mark, markDocument, publicFooter, publicPage,
} from './http/public-shell';

export {
  accountTheme, DEFAULT_THEME, terminalPalette, THEME_CONFIG_KEY, THEME_CSS, THEME_NAMES, THEME_TOKENS, themeNamed,
  type ColourToken, type Mode, type TerminalPalette, type ThemeName,
} from './web/theme';

export {
  accountFilesView, DEFAULT_FILES_VIEW, FILES_VIEW_CONFIG_KEY, filesViewNamed, type FilesView,
} from './web/files-view';

export { hueStops, rankHue } from './web/agent-colour';

export { SLATE_PAGE_PREAMBLE } from './web/slate-page';

export { APP_FONTS_PATH, appFontFile, SLATE_FONTS_PATH } from './web/fonts';

export {
  approvalDocument, authDocument, installDocument, loginDocument, type BuiltinSignIn,
} from './http/public-pages';

export {
  currentTakeIndex, takeChipLabel, cycleTakeIndex, hasComparableTakes,
} from './read-models/alternate-takes';

export {
  classifyProgrammaticTurn, delegatedTaskMetadata, messageSignalId, isSteeredMessage, endedMidWork, TURN_END_METADATA_KEY, turnFailure, TURN_FAILURE_METADATA_KEY, slatesChanged, SLATES_CHANGED_METADATA_KEY, slatesToPreview, applySignalCard,
  splicesSeenOn, SIGNALS_SEEN_METADATA_KEY, type SeenSplice,
  parseSignalCardEvent, parseDrainedEvents, eventVariantLabel, eventSourceLabel,
  metadataBroadcastEvent,
  type ClassifiedProgrammaticTurn, type SignalCard, type DrainedEvent,
} from './read-models/background-event';

export { turnFailureFacts } from './read-models/turn-failure-facts';

export { providerName } from './providers/model-test';

export { namedImages, type ImageMachine, type NamedImage } from './read-models/chat-images';

export { linkProse, promoteSlateLinks, type MarkdownNode } from './read-models/markdown-links';

export {
  appendHeadDelta, retireHeadDelta, deltaAsMessage, NO_HEAD_DELTAS,
  type HeadDelta, type HeadDeltas,
} from './read-models/head-chat';

export { drawnText, liveTailRow, threadLiveTail, toolCallRunning, type LiveTail } from './read-models/message-live-tail';

export { messagesUpTo, turnRows } from './read-models/fork-count';

export {
  turnLiveness, TURN_CLAIM_FRAME, TurnClaimFrameSchema, type TurnClaimState, type TurnLiveness,
} from './read-models/turn-liveness';

export {
  createLiveRefreshAdmission, formatWorkspaceError, loadWorkspaceSnapshot, naturalList, readFailureText, refreshLiveResource,
  SNAPSHOT_SEEDED_SOURCES, type ConsentResolutionReporter, type ErrorSource, type LiveRefreshAdmission, type LiveRefreshErrors,
  type LiveRefreshSource, type WorkspaceErrors, type WorkspaceNotice,
} from './read-models/workspace-reads';

export {
  PROVIDER_WAIT_PART, ProviderWaitSchema, SubordinateActivityEventSchema, WorkspaceBroadcastSchema, WorkspacePlanUpdatedFrameSchema,
  type MctsProgress, type WorkspaceBroadcast,
} from './read-models/workspace-broadcasts';

export { inspectWork, jobPhase, type InspectedWork } from './read-models/work-inspection';

export {
  breakdownView, shareOfMeasured,
  type BreakdownRow, type BreakdownPlane,
} from './read-models/activity-breakdown';

export {
  PLANE, viewerKindOf, FileWriteConflict, textRenderOf, fileTextEditable,
  entryRevision, nextTreeCache, sandboxedHtml, putFileBytes,
  type FileText, type TextRender, type CachedDir,
} from './read-models/files-plane';

export {
  createPlanAnnotationSaveQueue,
} from './plans/plan-annotation-save';

export { terminalChatError, type ChatTurnError, type TerminalFrame } from './utils/chat-turn-error';

export {
  newSendLatch, admitTurn, abandonTurn, abandonTurnIfOwner,
} from './utils/send-admission';

export {
  createSessionRecovery, fetchDeployedBuildSha, isNewerDeployedBuild,
  type SessionRecovery,
} from './utils/session-recovery';

export { pageDeployedBuildSha } from './web/page-build';

export { loadRouteChunk } from './utils/chunk-recovery';

export {
  isModelInferenceCredentialKey,
} from './providers/inference-credentials';

export {
  MY_GATEWAY_PROVIDER_ID,
  createMyGatewayProvider,
  gatewayWireModel,
} from './providers/my-gateway';

export { createWorkersAIProvider } from './providers/workers-ai-provider';

export { createWireModel, deferredModel, sdkWire, withModelStack, type WireProtocol } from './providers/wire-model';

export { callRetries } from './providers/middleware/retry';

export {
  type AnyToolPart,
  groupMessageParts,
  parseProvisionError,
  partOutput,
  partInput,
  partEffect,
  callFailed,
} from './read-models/tool-call-grouping';

export {
  type PlanPageRef,
  type PlanSurfaceKind,
  type SlateSurfaceKind,
  type SurfaceKind,
  ACTIVITY_SURFACE,
  SLATE_PREFIX,
  SURFACES,
  landedSurface,
  openPortOf,
  planOfSurface,
  planSurface,
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
  AGENT_RPC_ACCESS,
  hostedWindowCalls,
  hostedWindowMay,
  isAgentRpcMethod,
  requiredRpcAccess,
  rpcAccessScope,
  rpcMovesOverview,
  type AgentRpcAccess,
  type AgentRpcMethod,
} from './cli/agent-rpc-access';

export {
  launchDotenv, launchDotenvFiles, PROVIDER_KEY_ENV, SESSION_CREDENTIAL_ENV, unsandboxedCommandEnvironment, type LaunchDotenv,
} from './cli/command-env';

export {
  bunResolutionShell,
  cliPlatformShell,
} from './cli/bun-runtime';

export {
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
  sanitizePng,
} from './feedback/png';

export {
  type AgentModelEntry,
  type AgentModelMenu,
  EMPTY_MODEL_MENU,
  filterModels,
  validateModelSpec,
  normalizeModelMenu,
  contextWindowForSpec,
} from './providers/model-menu';

export {
  type InputState,
  initialInputState,
  type InputMachineEvent,
  type InputEffect,
  reduceInput,
} from './tui/input-state';

export {
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
  HOSTED_ACTOR_ID_HEADER,
} from './http/agent-routing';

export {
  APP_ROUTES,
  type ReportedRoute,
  REPORTED_ROUTES,
  routeTemplateOf,
  sanitizeReturnTo,
} from './read-models/app-routes';

export {
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
  type ClientErrorReport,
  fitClientErrorReport,
  CLIENT_CHAT_STREAM_FAILED,
  ClientReportSchema,
  type ReleaseMatch,
} from './read-models/client-error-contract';

export {
  reportChatStreamFailure,
  reportRenderFailure,
} from './read-models/client-error-report';

export {
  KINU_NODE_MODULE_NAME,
  KINU_NODE_MODULE_SOURCE,
} from './execution/codemode-node-shim';

export {
  type DeviceHubClient,
  type HubDeviceCallOptions,
  type HubDeviceTransportOpts,
  createHubDeviceTransport,
} from './execution/hub-device-transport';

export {
  type OutboundEmailMessage,
  EmailOutbox,
} from './events/email-outbox';

export {
  type WebhookRouteEnv,
  WEBHOOK_ROUTE_UNAVAILABLE,
  webhookRouteSecret,
  type SignedWebhookRoute,
  webhookRoutePath,
  matchWebhookDeliveryPath,
  verifyWebhookRoute,
} from './events/webhook-route';

export {
  healthResponse,
} from './http/health-route';

export {
  adaptMemory,
  backfillMemoryVectors,
} from './memory/vector-sync';

export {
  type ProbeOutcome,
  type ProbeDeps,
  declaredSignInProviders,
  runSyntheticProbes,
} from './http/synthetic-probes';

export {
  type HostedNodeHome,
  withHostedNodeExecution,
} from './execution/node-home';

export {
  objectNamed, type ObjectNamespace,
  type PcUserNamespace,
  type PcIngressEnv,
  handlePcConnect,
  handlePcConnectTicket,
  handlePcJoin,
  deviceJoinTicketUser,
  DEVICE_JOIN_TICKET_PREFIX,
  handlePcUpdateRefused,
} from './http/pc-ingress';

export {
  type DriverKind,
  type DriverLeaseHolder,
  type LeaseProcess,
  DriverLeaseHold,
  initDriverLeaseTable,
} from './execution/driver-lease';

export {
  createSqlFiber,
  detectOrphanedFibers,
} from './execution/fiber';

export {
  readAllOutcome,
} from './utils/spawned-output';

export { MCP_PRESETS, mcpPresetById, type McpPreset, type McpPresetId } from './mcp/presets';

export {
  CALLABLE_MCP_STATES, mapConnectionStatus, mcpCredentialTransport, mcpListingRefusals, McpTransitionLog, observedMcpState,
  type McpCredentialTransport, type McpFailureKind, type McpObservedState, type McpToolListing,
} from './mcp/client';

export {
  validateMcpServerInput, readAllowedTools, parseMcpHeaders, McpPresetAvailabilitySchema,
  McpServerSummarySchema, McpTransportSchema, type McpConnectionStatus, type McpPresetAvailability, type McpServerInput,
  type McpServerSummary, type McpTransport,
} from './mcp/servers';

export type {
  AgentTurnActivity, AgentRecovery, AgentAnswer, AgentAnswerTexts, AgentReview, AgentStanding, AgentStandingReport, AgentReport, AgentOwes, AdmittedDelivery, AgentSteps, RunEndOutcome, RunEndReport, AgentSnapshot, AgentTurnTask, AgentToolAnswer,
  AgentToolCall, AgentToolDescriptor, AgentHeadDelta, AgentTrace, AgentTurnEnd, PreparedAgentTurn, StoredRow, TurnRequestAt,
} from './subordinates/agent-isolate';

export { refusedRun, writesSnapshotRows } from './subordinates/agent-isolate';

export { describeAgentTools } from './subordinates/tool-descriptors';
