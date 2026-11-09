export {
  AskingAgentSchema, OwnerAnswersSchema, OwnerQuestionStore,
  type AskedQuestions, type AskingAgent, type OwnerAnswer,
} from './plans/owner-questions';

export { AskOwnerInputSchema, OTHER_OPTION, OWNER_ANSWER_SIGNAL, type OwnerQuestion } from './types/owner-questions';

export { initFiberTable } from './identity/schema';

export { statementText, tableExists } from './utils/sql';

export { WorkspacePlanReferenceSchema, type WorkspacePlanReference, SubagentInspectionRequestSchema, SubagentInspectionResultSchema, readSubagentInspection, missingSubagentHistory, type SubagentInspectionRequest, type SubagentInspectionResult, type SubagentChild } from './subagents/inspection';

export { AgentOpenTurns, type AgentOpenTurn } from './subagents/open-turns';

export { AgentReports, AgentSequence, type AcceptedReport } from './subagents/report-sequence';

export { TurnFences, type FencedRow, type OpenedAt } from './subagents/turn-fence';

export { TurnReports } from './subagents/turn-reports';

export { runEventSinks } from './orchestrator/run-event-sinks';

export { inspectDescendant, inspectSubagentStorage, readableActor, type AgentOwnInspection, type ReadableActor, type SubagentInspectionAuthority, type SubagentInspectionAccess } from './subagents/inspection-path';

// Backend-neutral terminal-turn state machine: the DO and the CLI supply only effect bodies and a wake.
export {
  chatTurnParts, declareTerminalRoster, declareHandoffRoster, HandedOffTurnSchema, runSettleEffect, SettledRunSchema, turnReportSequenceId,
  type HandedOffTurn, type SettledRun, type TerminalActor, type TerminalTurnFacts, type TerminalTurnParts, type TurnEnd,
} from './orchestrator/terminal-roster';

export { SleepTimeLane, initSleepTimeTables } from './orchestrator/sleep-time-lane';

export {
  assembleActorTurn, withCompactionTrigger, conversationKey, vfsTurnSkills, materializeTurnSources, turnSourcesFromBundle, actorTurnSources,
  type RunTurnSources, type TurnAssemblyRequest, type TurnAssemblySources, type TurnModelSources,
  type TurnReads, type TurnTools,
} from './orchestrator/turn-assembly';

export {
  TerminalTransitions, TERMINAL_TRANSITION_CALL_ID,
} from './orchestrator/terminal-transition';

export {
  initTerminalEffectTable, terminalEffect, chatTerminalEffects, turnRecordingEffects, actorTerminalEffects, branchesTerminalEffect,
  terminalEffectKey, TerminalEffectInterrupt, isDefinitiveTerminalFailure,
  TERMINAL_EFFECT_RETRY_BASE_MS, TERMINAL_EFFECT_RETRY_CEILING_MS,
  type TurnReportFacts,
  type TerminalEffect, type TerminalEffectTable, type TerminalEffectName,
  type TerminalEffectPhase,
  type TerminalEffectFault, type OwedEffect,
} from './orchestrator/terminal-effects';

export {
  type ClaimedRound,
} from './orchestrator/execution-driver';

export {
  initTurnBranchesTable, TurnBranchesStore, TurnFactsStore, type TurnFacts, type FrozenAuthority, type FactsKey,
} from './orchestrator/turn-facts';

export type {
  ExecutionKey, ExecutionLane, TurnCapability,
} from './orchestrator/execution';

export { inTurnSurface, scopedTurnSurface, TurnSurface } from './orchestrator/main-turn-surface';

export { standingFileLedger, turnLedgers, type TurnLedgers } from './orchestrator/turn-accumulator';

// Records that keyed work happened, kept after its row is retired.
export {
  initEffectTombstoneTable, prepareOutput,
} from './identity/effect-tombstones';

export { readActivityLog, writeActivityLog, type ActivityLogEntry } from './identity/activity-log';

export { ACTIVATION_SLOTS, initActivationTable, listActivations, recordActivation, type Activation } from './identity/activations';

export { ChatHistoryEntrySchema } from './types/chat';

// Every composition root calls this and nothing else (tests/contract-workspace-schema.test.ts).
export { initAgentIsolateSchema, initAllTables, initWorkspaceSchema, initActorStateSchema, type WorkspaceSchemaSql } from './state/workspace-schema';

export { derivedFrom, openSchema, repairSchema, type Repair, type TableWrites } from './state/schema-repair';

export { textContains } from './utils/text-match';

export {
  censusOf, OPS_OBJECTS_PER_REQUEST, OPS_PASS_PREFIX, opsCaller, requireOps, type OpsCaller, type StoreCensus, type TablesAnswer,
} from './state/ops-tables';

export {
  bookmarkNow, missingBytes, restartedForRestore, restoreArmed, restoreLanded, RestoreTargetSchema,
  type ArmedRestore, type DeploymentSecret, type MissingBytes, type RestoreTarget,
} from './state/ops-restore';

export { ACCOUNT_EPOCH_FIELDS, type ConnectionTicketPurpose, initUserTables, PROFILE_CATALOG_CONFIG_KEY, WORKSPACE_KEYED_ROWS } from './state/user-schema';

export { initMailNameTables, initMailboxTables } from './state/mail-schema';

export { mailDeploymentAliases, mailUsernameRefusal, parseMailRecipient, suggestedMailUsername, type MailRecipient } from './mail/address';

export type * from './mail/mailbox-api';

export { importantMail, MAIL_BOX_KINDS, MAIL_SEND_STATES, MAIL_VIEWS, MAIL_WAKES } from './mail/mailbox-api';

export { MailStore, type MailBlobs, type MailBoxOwner, type ParsedMail } from './mail/store';

export { unreadMailForTurn, type MailDeps } from './tools/mail-codemode';

export { createGoogleCodemodeProvider, type GoogleDeps } from './tools/google-operations';

export { callGoogle, GoogleCallSchema, type GoogleAnswer, type GoogleCall } from './google/calls';

export { createGitHubCodemodeProvider, type GitHubDeps } from './tools/github-operations';

export { readGitHub } from './github/reads';

export { GitHubReadSchema, type GitHubAnswer, type GitHubRead } from './operations/github';

export { type GoogleRequest } from './google/catalog';

export { mailHostRedirect } from './mail/host';

export { inboundBody, isAutoReplyEmail, mailThreadText, replySubject, splitQuotedReply, stripQuotedReply } from './mail/words';

export { handedMailSignal, MAIL_HANDED_EVENT, type HandedMail } from './mail/handed';

export { mailInContext } from './mail/in-context';

export { MAIL_MESSAGE_FIELDS, MailAddress, MailBoxPath, mailText } from './mail/message';

export {
  AccountLimitsSchema, admitComputerStart, admitPlatformTurn, admitStoredBytes, admitWorkspace, computerStartAnswer,
  limitReadings, limitsReport, LimitsReportSchema, nearLimitNote, refusedFor, shownBytes, startSize,
  type AccountLimits, type AccountUse, type Admission, type LimitReading, type LimitsReport, type RefusedFor,
} from './limits/admit';

export { accountClassOf } from './limits/class';

export {
  freeTierOf, isLimited, STORED_CLASSES, type AccountClass, type ComputerSize, type FreeTier, type StoredClass,
} from './limits/policy';

export { AccountLimitsStore } from './limits/store';

export { MailTriageLane, triageMail, type MailTriageDeps } from './mail/triage';

export { createEmailThreadDispatcher, mailboxEmail, sendInboundEmailReceipt, sendOwnerEmail } from './mail/outbound';

export { ensureMonitorSchema, listIncidents, recordProbeRun, type MonitorDeps, type MonitorRunResult } from './monitor/incidents';

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
  summarizeSoul,
} from './identity/soul';

export { WORKSPACE_IDENTITY_DDL } from './identity/schema';

export { validateSwarmProfileSnapshot } from './profiles';

export type { SwarmProfileSnapshot } from './profiles';

export {
  readForkLineage, type ForkLineageRow, type ForkFileSource,
} from './identity/fork';

export {
  ForkTargetWriter,
  type ForkResult, type ForkWriteTarget,
} from './identity/fork-writer';

export { ForkStagingState, type ForkStaging } from './identity/fork-staging';

export {
  FORK_TRANSFER_VERSION, FORK_FRAME_BYTES, FORK_ROW_SECTIONS, FORK_STREAM_SEED,
  ForkTransferReceiver, forkTransferFrames, sealForkFrame,
  foldForkStream,
  type ForkFrame,
  type ForkRowSection, type ForkSectionCounts, type ForkFrameReply,
  type UnsealedForkFrame,
  type ForkAppData,
} from './identity/fork-transfer';

export type { ForkFileSink } from './identity/fork-sink';

export {
  answersForDrainTurns, conversationTurnPair, historyTurnPairs,
  type ConversationTurnPair,
} from './identity/conversation-store';

export { CHAT_SEED_ROWS, CHAT_SESSION_ID } from './session/transcript-schema';

export { keptMediaName, type MediaRef, type MediaUrl, type StoredImage } from './session/chat-media';

export {
  forkWorkspace, type ForkTransport, type ForkDriverDeps,
} from './identity/fork-driver';

export {
  localForkConversationSource, localForkConversationTarget, forkConversationRowSchema,
  type ForkConversationSource, type ForkConversationTarget,
} from './identity/fork-conversation';

export { type ForkConversationSection, type ForkRows } from './identity/fork-sections';

export { forkArtifactPath, type ForkConversationPlan } from './identity/fork-plan';

// Workspace archive: one backup format for both backends.
export {
  WORKSPACE_ARCHIVE_EXTENSION,
  readAgentArchivePage, readWorkspaceArchivePage, type ArchiveAgentSource, restoreWorkspaceArchive, ArchiveCursorSchema, ARCHIVE_SNAPSHOT_ENDED,
  type ArchiveCursor, type ArchiveSqlCursor, type ArchiveAgentPage,
  type ArchivePage, type ArchiveStoreSource,
} from './identity/archive';

export { SCHEMA_STAMPS, SCHEMA_TABLES } from './identity/schema-genesis';

export {
  durableStamps, pragmaStamps, readStamp, requireSchemaStamp, stampSchemaGenesis, StoragePredatesReleaseError, writeStamp,
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
  WORKSPACE_ADDRESS_MAX,
} from './identity/naming';

export { drawWorkspaceLogo, sanitizeWorkspaceLogoSvg, workspaceLogoSubject, WORKSPACE_LOGO_SYSTEM_PROMPT } from './identity/logo';

export { WORKSPACE_TITLE_MAX, workspaceDisplayTitle, workspaceTitleDraft, workspaceTitleProblem } from './read-models/workspace-title';

export { EvolutionEngine } from './evolution/engine';

export { createStructuredDecider } from './evolution/structured-decision';

export {
  type EvolutionEvent,
  type CompletedTurn, type ToolCallRecord,
} from './evolution/types';

export { QualityDaySchema, type QualityDay, type QualityWindow } from './types/quality';

// Turn ratings: the one signal evolution decides by.
export {
  initTurnRatingTables, recordTurnRating,
  listThumbs, satisfactionInterval, qualitySeries, qualityWindow, renderQualitySeries,
  type RecordTurnRatingInput,
} from './evolution/ratings';

export {
  recordLesson, listLessons,
} from './evolution/lessons';

// One row per turn, owned by EvolutionEngine.
export {
  initCompletedTurnTable, createCompletedTurnStore, CompletedTurnSchema,
} from './evolution/session-window';

export {
  buildChangelog, countUnseenChangelog,
  revertChangelogEntryById, ChangelogRevertResultSchema, ChangelogEntrySchema,
  type ChangelogEntry, type ChangelogEntryKind,
  type ChangelogRevertResult,
} from './evolution/changelog';

export {
  createAgentConfigStore, initAgentConfigTable, holdConfig,
  AGENT_CONFIG_KEYS,
  type AgentConfigStore, type ShellApprovalMode,
} from './config/index';

export type * from './types/primitives';

export { VfsRevisionSchema } from './types/primitives';

export { REAL_CLOCK, type Clock } from './types/clock';

export {
  cloudFileLinks, filesFocusOf, linkFileReferences, localFileLinks, type FileLinks, type FilesFocus,
} from './read-models/file-links';

export {
  cloudPlanes, findPlaneReferences, FOLDER_SUBTREE, formatPath, isWholeReference, localPlanes, referencePrefixes, resolvePath,
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
  ShareCardSchema,
  OwnedLiveShareSchema, LiveShareCreatedSchema, ViewerRequestRecordSchema, ShareViewerClaimSchema, sharedBuildRefusal,
  type LiveShareVisibility, type BlueprintInspection, type BlueprintView,
  type BlueprintFork, type BlueprintBundle,
  type SharedLibrary, type SharedRow, type OwnedSlate, type SlateShareRecord,
  type ShareCard,
  type SlateGraphMember, type SlateGraphNamespace, type SlateCapabilityGraph,
  type LiveShareRecord, type OwnedLiveShare, type LiveShareCreated, type ShareViewerClaim,
  LIVE_SHARE_OPEN_PATH, LiveShareOpenSchema, type LiveShareOpen,
  LIVE_SHARE_PREAPPROVALS_PATH, SlatePreapprovalsBodySchema, LIVE_SHARE_PREAPPROVAL_WITHDRAW_PATH, SlatePreapprovalWithdrawSchema, SlatePreapprovalsSchema,
  type SharePreapproval, type SlatePreapprovals, type SlatePreapprovalWithdraw,
  SlateReachSchema, LiveShareBodySchema, LIVE_SHARE_MODE_PATH, LiveShareModeBodySchema, LIVE_SHARE_LISTING_PATH, LiveShareListingBodySchema,
  type SlateReach, type LiveShareBody, type LiveShareModeBody, type LiveShareListingBody,
} from './slates/sharing';

export { type ShareMode } from './slates/share-modes';

export type {
  RoomService,
} from './slates/room-api';

export {
  GALLERY_CATEGORIES, GALLERY_SORTS, GALLERY_LAST_PAGE, GallerySlateSchema, galleryPagePath, gallerySlatePath, galleryPicturePath, pictureForMode, DARK_PICTURE, GALLERY_STAR_PATH,
  GALLERY_REPORT_PATH, type GalleryCategory, type GalleryListing, type GallerySlate, type GallerySort, type GalleryStar,
  type GalleryReport,
  EXPLORE_KINDS, ExplorePageSchema, BlueprintPageSchema, explorePath, workspaceBlueprintPath,
  type ExploreKind, type ExploreItem, type ExplorePage, type WorkspaceCard, type BlueprintPage,
} from './slates/gallery-api';

// The part and consent contracts the client parses: `./slates` pulls the server's runtime, so the browser reads them here.
export {
  PartRunAnswerSchema, PartRunRequestSchema, SlateConsentsAnswerSchema,
  slateApprovalPath, slateConsentsPath, slatePartFramePath, slatePartReleasePath, slatePartRunPath, slatePartShowPath,
  type ConsentAsk, type EffectAsk, type PartAction, type PartRunAnswer, type PartRunRequest, type PartShowRequest,
} from './slates/personal-parts';

export { type SlateConsent } from './slates/share-modes';

export {
  type SlateSurfaceCatalog,
} from './slates/capability-graph';

export {
  SlateCallRequestSchema, SLATE_DRIVEN_MEMBERS, routeSlateCall, issuedSlateInvocation,
  type SlateCallRequest, type SlateRoute, type SlateInvocation, type SlateViewer,
} from './slates/surface';

export { SLATE_READ_MODELS, type SlateReadModel } from './slates/read-models';

export type { SlateProcess } from './slates/process';

export {
  isSlateMethodName, SLATE_METHOD_NAME_SOURCE, SlateOperationSchema, type SlateOperation, SLATES_CHANGED_EVENT, SLATE_PUSH_EVENT, type SlateCallResult, type SlateAnswer, type SlateSurfaceResult, type SlateSurfaceValue, isJsonAnswer,
  type SlateSummary, SharedSlateFilesSchema, type SharedSlateFiles, type SlateFileChange,
} from './slates/rpc';

export { initSlateStateTable, SLATE_HOST_BINDING, SLATE_STORAGE_BINDING, slateStorageCall } from './slates/state';

// Browser-safe slate vocabulary, so it belongs on this value-imported barrel.
export {
  buildSlateHostContext, readSlateFrameMessage, readSlateIdentityAsk, keptSlateContext, slateFrameSrc, slateLinkId, SLATE_BRIDGE_MESSAGE,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE, SLATE_THEME_TOKENS,
  type SlateHostContext,
} from './slates/host-context';

export {
  addressedBlock, blockServer, ephemeralSlateAddress, ephemeralSlateId, slateUiSegments, SLATE_UI_ATTRIBUTE,
  type EphemeralSlateAddress, type SlateUiSegment,
} from './slates/ui-blocks';

export {
  drawnPageDocument, drawnStreamDocument, SLATE_DRAW_MESSAGE, type DrawnPageLook,
} from './web/drawn-page';

// Cross-workspace experience transfer
export {
  createExperienceLibrary,
  EXPERIENCE_KINDS,
  initExperienceLibraryTables,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperienceLibraryStore,
  type ExperienceSearchOptions,
} from './experience/index';

// Chat engine
export {
  runChat, INTERRUPTED_TURN,
  type ChatEvent, type ChatFallback, type ChatOptions,
} from './chat';

export type { ModelAttemptIdentity } from './providers/attempt-identity';

// Extension seam (public plugin API)
export {
  ExtensionHost,
  type KinuExtension,
  type ToolCallContext,
  type ToolResultContext,
  type MessageSwap,
  type TransformContext,
  type CompactionTrigger,
} from './extension';

export {
  composePrepareStep,
  type StepContextPlane,
  type StepPipeline,
} from './prompting/prepare-step';

export { toolPairingGaps } from './session/tool-pairing';

export { SessionHistory } from './session/history';

export {
  contextMount, localContextTree, remoteContextTree, servedContextTree,
  type ChildContextResolver, type ContextTree, type ContextEditor, type ContextTreeRemote,
} from './vfs/context-plane';

export type { SessionFilePlane } from './session/payload';

export type { MessagePartReference } from './session/messages';

export { drawnStep, RECORDED_AT_METADATA_KEY, SessionTranscript, SessionTranscriptReader, readSessionTranscript, type ConversationProjection } from './session/transcript';

export { encodeModelMessageValues, decodeModelMessageValues } from './session/message-codec';

export {
  pruneStepToolOutputs, type StepPruneBudget,
} from './prompting/step-prune';

export {
  settleUnpairedToolCalls,
} from './prompting/interrupted-tool-calls';

export {
  classifyTurnFailure,
  planOverflowRecovery,
  statedContextLimit,
  OVERFLOW_RETRY_EVENT,
  OVERFLOW_RETRY_TEXT,
} from './turn-failure';

export { createChatModel } from './llm';

// Surfaces import this instead of retyping the number.
export { CHARS_PER_TOKEN } from './token-estimate';

export type { LLMProviderConfig } from './llm';

export {
  createWorkersAIEmbedder, type WorkersAiWebSearch, generateReported,
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
  SPILL_DIRS,
} from './context-budget';

// Label-scoped spend governor. Opt-in: no label, no cap, no storage traffic.
export {
  MissionGovernor,
  // A surface that prices a call must use this, exactly as the ledger debits it.
  priceCall,
  localMissionScope,
  missionGate,
  initMissionBudgetTable,
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
  renderCodemodeDescription, programDeclarations,
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
  nativeToolFunctions, toolsNamespace, programSurface, servedImpacts, codemodeFunction, renderCraftedDefinitions,
  slateToolReach, callCodemodeMember, requireCodemodeMember,
  withCraftedToolDeclarations, craftedToolDeclarations,
  shownConsoleValue, programNamespace, type ProgramMember, type ProgramNamespace, SANDBOX_CONSOLE_PRELUDE, SANDBOX_CREATE_TOOL_PRELUDE,
  type CodemodeProvider, type CodemodeResult,
} from './tools/sandbox-contract';

export { executorNamespace } from './tools/executor-operations';

export {
  initAgentDataTables, createAppDataStore, createDbCodemodeProvider,
  type AppDataStore,
} from './tools/db-codemode';

export { ExplainRowSchema, gateProgram } from './operations/db-sql';

export { actorReferenceOf, bindActorHandle, type ActorReference, type ActorHandle } from './identity/actor-handle';

export { explorationActorKey } from './identity/actor-key';

export { recoverSubagentLifecycles, type SubagentSeed } from './subagents/birth';

export { type SubagentInheritedContext } from './types/subagents';

export { subagentForkContext, subagentTurnContext } from './subagents/support';

export { admitHireWork, hireLifecycle, stopAgentsBelow, type HireLifecyclePorts, type SeatedHire } from './subagents/hire-lifecycle';

export { inheritedAsModelMessage } from './heads/head-inference';

export { driveDeliveredRun, driveSeatedRun } from './heads/delivered-run';

export { initWorkspaceActorTable, facetNamesGiven, WorkspaceActorDirectory, stoppedBelow, isSubagentOrigin, whenActorTakesInput, actorScaffoldPath, actorStateRoot, openWorkspaceMainActor, bearWorkspaceIdentity, ChildActorOperationSchema, type ChildActorOperation, type ActorDirectoryResult, type WorkspaceActor, type ActorOrigin, actorStanding, actorEnded, endedStandingOf } from './identity/workspace-actors';

export {
  openLocalRootActor, localActorDirectory, adoptLocalActorHandle, bindLocalActorReference, registerLocalActor, openLocalActor, bindLocalActor, requireLocalActorWorkspace, retireLocalActor, recoverLocalActorRetirements, type LocalActorBinding, type LocalActorConfig,
} from './state/local-actors';

// open-38: one physical workspace SQLite for every logical actor.
export {
  createActorHost, createSeatHost, recoverActorTurns, childContextResolver, hostedChildTree, registeredParent,
  type ActorHost,
  type ActorSeat, type ActorHostDeps, type SeatHostDeps, type BoundActor, type SeatedActor, type HostedActor,
  type ActorRetirement,
} from './state/actor-host';

export { defaultLoopOrigin, type LoopOrigin } from './scaffold/bootstrap';

export { admitCraftedSource } from './craft/source';

export { mcpToolKey } from './tools/mcp-naming';

export {
  describeMcpTool, omitEmptyOptionalArgs,
  buildMcpToolSet, listMcpToolsLeniently,
  McpToolSurfaceSchema, McpToolSurfaceCache,
  type SerializableToolDescriptor, type RemoteMcpTool, type McpToolRefusal, type ListedMcpTools,
  type McpServedSurface,
} from './tools/mcp-surface';

export {
  agentsActionsFor,
  agentsProfileContext, delegationChoices,
  type AgentsProfileContext,
} from './delegation/agents-tool';

export {
  createLocalPeerEndpoint, peersToolDeps, samePeerGroup,
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

export { createAgentSelfProvider, type AgentSelfHost, type OwnerWaitsHost } from './tools/agent-self';

export { agentSelfHost } from './orchestrator/agent-self-host';

// Platform-neutral: a backend supplies only SubagentRuntime.
export { SubagentRosterStore, initSubagentRosterTable, subagentTitle } from './subagents/roster';

export { teamToolDepsFor, temporaryPortFor } from './subagents/team-wiring';

export {
  admitSubagentReport,
  admitSubagentTask,
  agentNamer,
  createTeamToolDeps,
  describeSubagentHandoff,
  normalizeReportContent,
  parentAdmitsSubagentReport,
  readSubagentLiveStatus,
  subagentDescriptorSource,
  hireTurnSettled,
  type HiredTurn,
  type SubagentReportOrigin,
  type SubagentRuntime,
} from './subagents/support';

export {
  TEMPORARY_LIFETIME,
  TASK_TURN_ENDINGS,
  createTemporaryAgentPort,
  taskAnswerIsLater,
  temporaryRunSettles,
  terminalTaskReport,
  type OwedReport,
  type TemporaryAgentPort,
  type TaskTurnEnding,
  type TemporaryRunRequest,
} from './subagents/temporary';

// The depth cap is derived per child, never stated by one.
export {
  DELEGATION_MAX_DEPTH,
  delegationBudgetOf,
  delegationDepthRefusal,
  delegationExhausted,
  type DelegationBudget,
} from './subagents/depth';

export {
  buildBuiltinTools,
  builtinStores,
  type BuiltinStoreInputs,
  ownerLaneTools, ownerLaneDeclarations,
  codemodeSurface,
  type CodemodeBuilder, type CodemodeSurface,
} from './tools/builtins';

export { serveStores, type ServedStores } from './tools/actor-stores';

// An actor surface is buildBuiltinTools plus `agents`; see delegation/actor-tools.ts.
export {
  buildActorTools, PEER_REPLY_TOPIC,
  type ActorToolsetDeps, type ActorToolsets,
  type AgentsToolDeps, type AgentsSwarmDeps,
  type TeamToolDeps, type SubagentRosterEntry,
  type SubagentDelivery, type SubagentHandoff,
  type PeersToolDeps,
  type PeerSendOutcome, type PeerSpawnOutcome,
} from './delegation/actor-tools';

// Applied inside buildActorTools; backends never wrap tools themselves.
export {
  initToolEffectClaimTable, claimToolEffect, settleToolEffect,
  withEffectReceipt, remoteReceipts, pruneTurnReceipts,
  type EffectClaimDeps, type ReceiptExecution, type RemoteReceipt, type ToolEffectKey,
} from './tools/effect-claim';

// Web search + fetch
export { KITESURF_SESSION_ID, WEB } from './operations/web';

export { createWebCodemodeProvider } from './tools/web-operations';

export { restBrowserRunAccess, type BrowserRunQuickActions, type QuickActionTransport } from './web/browser-run';

export {
  browserSessions, closeWorkspaceBrowserSessions, initBrowserSessionTable, ownsBrowserSession,
  type BrowserSessionBinding,
} from './web/browser-sessions';

export { MOVIE_CUES, MOVIE_END, type LandingMovieHandle } from './web/landing-movie-contract';

export { stripBase64Images } from './web/markdown';

export { buildCfWebSearchProvider } from './web/provider-factory';

export {
  createDefaultWebSearchProvider, type BrowserSessions, type WebSearchProvider, type WebSearchResponse,
} from './web/provider';

export {
  bindingWebSearch, chainWebSearch, type DeploymentSearch, type WebSearch, type WebSearchChain,
} from './web/search-chain';

export {
  routeWebSearch, USER_WEB_SEARCH_PATH, USER_WEB_SEARCH_TEST_PATH, WebSearchRequestSchema,
} from './web/search-route';

export { assertSafeUrl, isSafeUrl, UnsafeUrlError } from './web/url-safety';

// Codemode-only, no native tool: see tools/builtins.ts.

export { createMemoryCodemodeProvider } from './tools/memory-operations';

export { MEMORY } from './operations/memory';

export {
  nativeTool, codemodeNamespace, nestedMembers, callOperation, listOperations, type OperationCaller, type OperationListing,
} from './tools/operation-surfaces';

export {
  defineOperation, serveTransactional,
  type OperationResult,
} from './operations/operation';

export { createTasksCodemodeProvider, type RoleSwitch } from './tools/tasks-operations';

export { createAiCodemodeProvider, type AiDeps } from './tools/ai-operations';

export { AI, type AiAnswer, type AiRunInput } from './operations/ai';

export { TASKS } from './operations/tasks';

export { createReportCodemodeProvider, type ReportDeps } from './tools/report-operations';

export { createFileTool, serveFile, type FileDeps } from './tools/file-operations';

export { FILE } from './operations/file';

export { imageModelOutput } from './tools/image-results';

export {
  summarizeToolCall, describeToolCall,
  toolCallEffect,
  type ToolCallEffect,
} from './tools/tool-call-summary';

export { programEffectsOf, programEffect, type MemberImpacts, type ProgramEffects } from './execution/call-effects';

export { ToolOutcomeSchema, failedToolOutcome, successfulToolOutcome, withCodemodeProgram, type ToolOutcome } from './tools/outcome';

export { toolErrorOf, type ToolError } from './tools/outcome';

export { McpProtocolFailureSchema } from './tools/mcp-error';

export {
  withClampedToolResult,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from './tools/clamp';

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
  DYNAMIC_CONTEXT_OPEN_TAG,
  WORKSPACE_INSTRUCTIONS_TAG,
} from './utils/prompt-sections';

// A local estimate, carried beside the provider totals, never reconciled into them.
export {
  TurnContextMeter,
  measureContext,
  type ContextComposition,
  type ContextPlane,
} from './context-meter';

export { isWorkMode, WorkModeSchema, type TurnReason, type WorkMode } from './types/turn';

export {
  compilePromptSurface,
  type PromptExecutorInfo,
  type PromptIdentity,
} from './prompting/surface';

export {
  assertToolsSupportedByModel,
  resolvePromptModelProfile,
  type PromptModelContext,
} from './prompting/model-profile';

export type { HarnessMode } from './config/harness-mode';

export {
  renderAgentsMdSection,
  collectWorkspaceAgentsMd,
  admitAgentsMd,
  advisorWorkspaceGuidance,
  discoverInstructionFiles,
  type InstructionCandidate,
  type InstructionFileProbe,
  type InstructionFileRead,
  type AgentsMdSources,
} from './prompting/agents-md';

export {
  attachmentBytes,
  storeAttachment,
} from './prompting/attachment-sanitizer';

export { ASKED, HeldReads, type Holds } from './utils/held-reads';

export { base64Bytes, base64ToBytes, bytesToBase64 } from './utils/base64';

export { mediaImage, mediaTokens, UNPRICED_MEDIA_TOKENS } from './prompting/media-tokens';

export { toolDescription } from './utils/tool-description';

export { serverCompactor, isServerCompaction, latestCompaction, type ServerCompactor, COMPACTION_TRIGGER_PERCENT } from './providers/server-compaction';

export {
  DynamicContextLedger, agentDynamicContext, observeSystemPromptHash, renderDynamicContextBlock, type DynamicApproval, type DynamicContext, type DynamicDelegate, type RuntimeFacts, type MissingCapability, type SecretsInContext,
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
  type PromptCacheStrategy,
} from './prompting/cache-breakpoints';

export {
  extractJsonArray,
  extractJsonObject,
} from './providers/structured';

export { evidenceWindow, renderToolResult } from './utils/evidence-window';

export { buildRuntime } from './runtime-builder';

export { createAgentStores } from './state/agent-stores';

export type { AgentStores } from './state/agent-stores';

export { collectDynamicContext, dynamicReads, subagentDelegatesOf, type DynamicReads } from './state/dynamic-context';

export type { DynamicContextInput } from './state/dynamic-context';

export {
  evaluateWithMultiModelJudging,
} from './mcts/evaluation';

// Alternate Takes
export {
  initAlternateTakesTable,
  listAlternateTakeSets, latestAlternateTakeSet,
  recordBranchTakeSet, takeEvidence, AlternateTakeSetSchema,
  TakePickOutcomeSchema,
  type AlternateTakeCandidate, type AlternateTakeSet,
  type TakePickOutcome,
} from './mcts/takes';

// Steer-as-Branch
export {
  BRANCH_RATIONALE, STEER_BRANCH_RUN_ID_PREFIX,
  newBranchId, isSteerBranchRunId, branchHeadId, admitBranch,
  startBranchHead,
  type BranchStatusEvent, type BranchTurnResult, BranchTurnResultSchema,
  type PendingBranch,
} from './steer-branch';

// Inbox: the one way anything reaches an agent.
export { TurnReplies } from './orchestrator/turn-replies';

export {
  signalCardId, PromptFileSchema,
  STEER_METADATA_KEY, STEER_STEP_METADATA_KEY,
  initPendingSendTables, PendingSendStore,
  type InputProducer,
} from './orchestrator/inbox';

export { sendLanding, SendStateSchema, type SendState } from './orchestrator/send-state';

export {
  buildTranscript, extendTranscript, sealTranscript, segmentBySteers,
  EMPTY_TRANSCRIPT_FOLD,
  type InlineSteer, type PlacedSteer, type Transcript, type TranscriptEntry,
} from './read-models/transcript';

export { initSearchTables } from './mcts/schemas';

export {
  MctsSearchStore,
  initMctsSearchTable,
  type MctsSearchRunSummary,
} from './mcts/search-store';

export { initScaffoldTables } from './scaffold/schemas';

export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap';

export { modifyScaffold } from './scaffold/modify';

export { rollbackScaffold } from './scaffold/rollback';

export { createScaffoldSurface } from './scaffold/surface';

// Misevolution gate: fixed safety criteria over every evolution surface.
export {
  checkMisevolution, checkMisevolutionForSurface,
} from './safety/misevolution';

export { listScaffoldArchive } from './scaffold/archive';

export {
  runScaffold, scaffoldProviders,
  type ScaffoldRunOptions,
  type ScaffoldRunReport, scaffoldRunReport,
} from './scaffold/executor';

export { scaffoldChatTransform } from './scaffold/chat-transform';

export {
  getCurrentScaffoldVersion, readVersionedScaffoldSource, scaffoldSource, writeScaffoldVersion, getPendingScaffold, applyPromotionDecision, type VersionedScaffoldSource,
} from './scaffold/versions';

// Crafted tools by preference
export { craftPreference, craftPreferences } from './craft/preference';

// Scaffold replay against recorded turns
export { activateReplayedScaffold } from './scaffold/replay-gate';

export {
  decodeRecordedTurns, encodeRecordedTurns, recordedTurns, replayScaffold, type RecordedTurn,
} from './scaffold/replay';

export { readCraftRaised, type CraftRaised } from './craft/in-episode';

export { TurnCraftLedger } from './craft/turn-ledger';

export { upsertCraftedTool } from './craft/conflict';

export {
  DefaultExecutionRouter, runOnExecutor,
} from './execution/router';

export {
  withApprovalGatedShell, withApprovalGatedFiles, hostedToolFiles, gateProviderExec, type FileReach,
} from './execution/approval';

export {
  createBashShell, createShellSession, shellExecOptions,
} from './execution/shell-session';

export {
  createSandboxExecutor, computerProcessJob, type ComputerProcessEnd, type SandboxHandle, isSandboxTransientError, SandboxPending,
  sandboxFiles,
} from './execution/sandbox';

export { computerProcessResume, stopComputerProcessJob } from './jobs/computer-process';

export { isWorkspaceProcessJob, stopWorkspaceProcessJob, workspaceProcessJobRuns } from './jobs/workspace-process';

export { onceMoreIfNotAdmitted } from './execution/not-admitted';

export { ComputerProcessEnds, jobState } from './execution/computer-process-ends';

export {
  DESKTOP_MEMBERS,
} from './execution/desktop';

export {
  createDeviceTunnelExecutor, type DeviceTransport, deviceFiles, type DeviceFileScope,
} from './execution/device-tunnel-executor';

export {
  deviceToolchainAnswer, connectedDevices, sameDeviceStatus,
  soleLiveDevice, effectiveDeviceMode, parseDeviceTier, parseSandboxCapability, parseSandboxReason, sandboxReasonFix,
  sandboxCause, describeGpuNodes, DEVICE_TOOLCHAIN_TTL_MS, DEVICE_TIERS, DEVICE_SANDBOX_CAPABILITIES,
  DEVICE_SANDBOX_REASONS, type DeviceStatus, type DeviceFleetEntry,
  type DeviceTier, type DeviceSandboxStatus, type DeviceSandboxReason,
} from './execution/device-status';

export {
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
} from './execution/toolchain';

export {
  WS_OPEN,
  DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  WORKSPACE_HAS_NO_OWNER, isWorkspaceUnattachedError, SEVERAL_DEVICES_CONNECTED, isDeviceAmbiguityError,
  DeviceCancelResultSchema, nextDeviceRequestId, parseDeviceCancelAnswer,
  type DeviceExecOutput, watchedOutput,
} from './execution/device-tunnel';

export {
  DeviceHelloHeadSchema, DeviceUpdateHelloSchema, DeviceHelloSchema, DEVICE_METHOD, DEVICE_FRAMES, DEVICE_ERRORS,
  DEVICE_FEATURES, DEVICE_PROTOCOL_VERSION, DEVICE_PTY_MAX_AXIS, deviceMethodHas,
  deviceFailure, DeviceAuthFrameSchema, DeviceConnectSecretAckSchema, DEVICE_AUTH_DEADLINE_CLOSE, DEVICE_AUTH_DEADLINE_MS,
  DEVICE_CREDENTIALS_REJECTED_CLOSE, DEVICE_VERSION_REFUSAL_CLOSE,
} from './execution/device-protocol';

export {
  DEVICE_CONNECT_SECRET, DEVICE_KEY_FILE, deviceConnectMessage, deviceRefusalMessage, deviceReplaceMessage, isDevicePublicKey, signDeviceMessage,
  verifyDeviceSignature,
} from './execution/device-key';

export {
  DeviceSocketHub, deviceIdFromSocket, type DeviceSocket,
  type DeviceSocketCtx,
} from './execution/device-hub';

export { DeviceChatGptStatusSchema, EGRESS_ROUTE_HEADER,
  type DeviceChatGptStatus, type RelayedProvider,
} from './execution/device-relay';

export {
  DeviceRequestLedger, initDeviceInflightTable, type ClaimedDeviceRequest,
  type DeviceCancelOutcome,
} from './execution/device-inflight';

export {
  DeviceTerminalHub, terminalFromSocket,
} from './execution/device-terminal';

export {
  DeviceScreenHub, screenFromSocket,
} from './execution/device-screen';

export { readScreenData, screenDataFrames } from './execution/device-screen-data';

export {
  nimbusSessionShell, nimbusShellSession, type NimbusSandboxHandle, type NimbusSandboxFiles, type NimbusStartResult,
  type NimbusExecResult, type NimbusPortInfo, nimbusSessionFiles,
} from './execution/nimbus';

export {
  NO_TIMER_DEADLINE_MS, commandTool, type ExecutorToolResult,
  type CommandTool, type ExecutorCapability, type ExecutorProvider, type ExecutorProviderSurface,
  type ExecutorInfo, type ExecutionRouter, type ResourceLimits,
  type PreviewRouteCheck,
} from './execution/types';

export {
  wordsOnly,
} from './execution/command-call';

export {
  commandAnswer, answeredRefusal, CommandResultSchema,
} from './execution/exec-result';

export {
  BoundedOutput, COMMAND_OUTPUT_LIMITS, type OutputSpill, type SpillOutcome,
} from './execution/bounded-output';

export {
  TurnEscalationLedger,
} from './execution/escalation';

export {
  answerParentRpc, createParentExecutor, type ParentWorkspaceHandle,
} from './execution/parent';

export {
  createInlineExecutor, createNimbusWorkspaceExecutor, workspaceCapabilities, SlateProgramSchema,
  type InlineExecutorDeps,
} from './tools/inline-executor';

export { processRetryTool } from './tools/process-retry';

export { explainSandboxError } from './tools/sandbox-errors';

export { stoppedProgram } from './execution/program-stop';

export { callableToolNames, currentWorkMode, inWorkMode, runWorkModeInvocation, permitInPlan, requireBuild, requireWorkModePermission, toolsInWorkMode, providersInWorkMode, toolsBehindBoundary, type ToolBoundary } from './execution/work-mode';

export { ProgramsInFlight, launched } from './execution/programs-in-flight';

// Client-safe only: the Nimbus workspace host is exported from
// `@kinu.run/core/workspace` so a browser bundle cannot pull in the server runtime.
export {
  workspacePath, SCRATCH_ROOT, SHARED_ROOTS, SLATES_ROOT, WORKSPACE_ROOT,
} from './vfs/workspace-path';

export {
  agentHome, agentArtifactDirectory, agentTmpRoot, agentCred, agentIdentity, agentNameOfUid, VIEWER_HOME_NAME,
  provisionAgentHome, confineAgentTmp, restoreAgentTmpConfinements, settleWorkspaceRoot, PROJECT_OWNER_CRED,
  settleSharedRoots,
  ensureIdentityTable,
  actorHomeName,
  MAIN_AGENT, SESSION_UID, AGENT_UID_FLOOR,
} from './vfs/agent-home';

export { workspaceCommandNotFound } from './vfs/workspace-runtimes';

export type {
  WorkspaceBundle, WorkspaceFiles,
} from './vfs/nimbus-workspace';

export {
  workspaceSoul, writeWorkspaceSoul, createWorkspaceForkSink, createWorkspaceForkSource,
  workspaceArchiveStore, workspaceArchiveTarget,
} from './vfs/workspace-planes';

export { observeNamespace, type WriteEvent, type WriteObserver } from './vfs/write-events';

export { vfsBasename, vfsDirname } from './utils/vfs-helpers';

export { oneAtATime } from './utils/one-at-a-time';

export { markStoreChanged, storeRevision } from '@kinu.run/agent-utils';

export { ISOLATED_BUN_FLAGS, isolatedBunArgs } from './utils/bun-isolation';

export { mossaicVfs, type MossaicClient, type MossaicVfs, type MossaicStat, type MossaicChild } from './vfs/mossaic-vfs';

export {
  sharedDriveMount, DRIVE_SKILLS_DIR, DRIVE_RESERVED_DIRS,
  SHARED_DRIVE_UNCLAIMED, SHARED_DRIVE_UNBOUND,
} from './vfs/shared-drive';

export { packZip, unpackZip, type ZipEntry } from './utils/zip';

export {
  normalizeDrivePath, listDrive, makeDriveFolder, renameDriveEntry,
  deleteDriveEntry, markAsSkill, addSkill, receiveDriveUpload, packDriveFolder, driveFailure,
  DriveListingSchema, MarkedSkillSchema, DriveUploadTargetSchema,
  type DriveEntry, type DriveListing, type MarkedSkill, type DriveFailure, type DriveUploadTarget, type DriveUploadOutcome,
} from './skills/drive';

export {
  withMountTable, workspaceFilePlane, standardMounts, EXECUTOR_MOUNTS, MOUNT_EXECUTORS,
  removeWhole,
  type VfsMount, type MountedVfs, type WorkspacePrincipal,
} from './vfs/mounts';

// File checkpoints
export {
  CHECKPOINTS_NO_DEVICE, summarizeRestorePlan,
  checkpointAvailability, deviceHistoryNote, fileCheckpointListing, fileRestorePlan, fileCheckpointRestore,
  FileCheckpointListingSchema, FileRestorePlanSchema, FileRestoreResultSchema,
  type FileCheckpoints, type FileCheckpointReads, type CheckpointTurnMeta, type CheckpointAvailability,
  type FileCheckpointEntry, type FileCheckpointListing, type FileRestoreChange,
  type FileRestorePlan, type FileRestoreResult, type DeviceCheckpointHint,
} from './checkpoints/types';

export { deviceFileCheckpoints } from './checkpoints/device';

export {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_UNAVAILABLE_NO_GIT,
} from './checkpoints/format';

export {
  createCheckpointEngine,
  type CheckpointHost,
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

export { searchMemoryHits } from './memory/memory-search';

export { recallForTurn, type RecallSources } from './memory/turn-recall';

// Memory writes
export { memoryBytes } from './memory/note';

export { appendMemoryNote, MEMORY_PATH, memoryNotes, parseMemoryNotes, readMemoryTail } from './memory/note';

export {
  ConversationSearchStore, ensureIndexTables, invalidateConversationSearchIndex,
  type ConversationRecall, type ConversationSearchHit,
  type ConversationScrollResult, type ConversationSummary,
} from './memory/conversation-search';

// Top-K recent agent_facts render into the system prompt every turn.
export {
  initFactsTable, createFactsStore, factLine, normalizeFactKey, renderMemoryBlock, searchFacts, unifiedFacts,
  FactRevisionSchema, FactSchema,
  type Fact, type FactsStore,
} from './memory/facts';

export {
  AccountMemoryStore, AccountMemoryProposalSchema, AccountNoteSchema,
  type AccountMemory, type AccountMemoryProposal, type AccountMemoryView, type AccountNoteHit, type AccountProposal,
  type AccountProposer,
} from './memory/account';

export {
  JsonValueSchema, JsonObjectSchema, JsonArraySchema, renderIssuesUnquoted,
  parseJsonValue, parseJsonObject, safeJsonParse, decodeJsonValue, jsonResultOrVoid, projectJsonValue, nonEmptyString,
  binaryReplacer, type JsonObject, type JsonValue,
} from './utils/json';

export { MarkdownFrontmatterError, parseMarkdownFrontmatter } from './utils/markdown-frontmatter';

export { compareCodeUnits } from './utils/text';

export { readHtml } from './utils/html';

export {
  runSleepTimeCompute, applySleepTimeUpdate, accountProposals,
  SLEEP_TIME_CADENCE,
  sleepTimeDue, sleepTimeWakeAt, sleepTimeWindow,
  type SleepTimeUpdate,
} from './memory/sleep-time-compute';

// Run-event log (`run_events`), separate from the EventsHub `agent_log`.
export type {
  RunEvent, RunEventInput, RunEventType, StepCost,
  CacheHitStats,
} from './events/index';

export {
  FAILURE_WITHOUT_ERROR,
  initRunEventTables,
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
  beginModelOperation,
  pricedModelCallEvent,
  type ModelCallReport,
  type ModelCallSpend,
  type ModelCallSink,
  type ModelOperationEvent,
  type ModelOperationSink,
  type AccountSpend,
  type SpendSource,
  type RunEventQuery,
  type StoredRunEvent,
} from './events/index';

export { contextFill, type ContextFill } from './read-models/context-fill';

// EventsHub. Spec: docs/ARCHITECTURE.md "Events and ingress".
export { eventContentPath, spillEventContent } from './events/hub/content-spill';

export { knownTimeZone, nextAlarmTime, nextCronFire } from './events/hub/cron';

export { buildDrainBatch } from './events/hub/drain';

export { boundEventQuery, EventLog, type QueryFilter } from './events/hub/log';

export { dispatchEmailRepliesForTurn, ReplyChannelStore, type ReplyDispatcher } from './events/hub/reply-channel';

export { initEventsHubTables } from './events/hub/schema';

export { TriggerRegistry, type AlarmScheduler } from './events/hub/triggers';

export {
  EVENT_VARIANTS, SUBAGENT_REPORT_HANDOFF_MAX_CHARS, SUBAGENT_REPORT_STATUSES, type EventVariant,
  type IngressDescriptor, type KinuEvent, type PeerAgentPayload, type ReplyChannelKind, type SubagentReportHandoff,
  type SubagentReportPayload, type SubagentReportStatus, type TimerPayload, type TriggerRow, type TrustLevel,
} from './events/hub/types';

export { redactPayload, renderForLLM } from './events/hub/visibility';

export { acceptContainerEvent, type ContainerEventResult } from './events/ingress/container';

export {
  admitMailArrival, boundedMessageId, boundedReferences, EMAIL_INBOUND_RATE_PER_MIN, EmailInbox,
  inboundEmailDropNotice, planOwnerNotification, type EmailInboxDeps, type MailAdmission, type MailArrival,
} from './events/ingress/email';

export { PeerHub, type PeerMessage, type ReceiveResult } from './events/ingress/peer';

export {
  DEFAULT_RATE_LIMIT_PER_MIN, initWebhookRateLimitTables, normalizeWebhookRateLimitPerMin,
  tryConsumeWebhookRateLimit,
} from './events/ingress/rate-limit';

export { createWebhookSecretStore, type WebhookSecretStore } from './events/ingress/secrets';

export {
  cancelTrigger, createTimerTrigger, dailyTimeOf, fireDueTriggers, listTriggers, retimeDailyTrigger,
  type CancelTriggerResult, type TimerTrigger, type TimerTriggerOpts, type TriggerView,
} from './events/ingress/triggers';

export {
  checkAnswerOf, checkWatcher, parkWatcher, resumeWatcher, WatchClaims, watchProviders, type RunCheck,
  type WatchOutcome,
} from './events/ingress/watch';

export {
  acceptWebhookDelivery, checkPendingDelivery, forgetClaims, freshWebhookSecret, gitHubPushOf,
  initWebhookIngressTables, keepPushHook, PendingDeliverySchema, registerDurableWebhook, registerPushWatcher,
  type GitHubPush, type PendingCheck, type PendingDelivery, type PushWatcher, type PushWatcherOpts,
  type WebhookDelivery, type WebhookDeliveryResult,
} from './events/ingress/webhook';

export { type WatchCheck } from './types/watch';

export {
  publishSubagentReport, receiveSubagentEvent, type AdmittedSubagentReport, type SubagentEventResult,
  type SubagentIngressDeps, type SubagentReportLedger,
} from './subagents/ingress';

// Swarm
export { mergeProviderOptions, reasoningEffortOptions, workersAIEffortOption } from './providers/effort';

export { type RatioProblem } from './strategy/exec-ratio';

export { liveHead, LiveWorkers } from './strategy/live-workers';

export { NODE_BUILTIN_TOOLS, runNodeAgent, type HostedNodeSeat } from './strategy/node-agent';

export {
  facetHomeProvisioner, facetHomeReleaser, nodeWorkspace, type NodeHomeHost, type NodeIdentity, type NodeWorkspace,
  type NodeWorkspaceProvisioner,
} from './strategy/node-workspace';

export { type ExplorationRecord, type Floor, type ObjectiveIdentity, type PublicationState, type VerifierFault } from './types/objective';

export { NAMED_SWARM_PRESETS, type SwarmCarry, type SwarmScore, type SwarmUnit } from './types/swarm';

// Bench harness: pure math; the runner lives in scripts/bench.ts.
export {
  assertLongHorizonSpec, buildLongHorizonAsks, buildLongHorizonQuestions, decodeLongHorizonSpec,
  encodeLongHorizonSpec, generateLongHorizonEntries, generateLongHorizonFiles, LONGHORIZON_ANSWER_FILE,
  LONGHORIZON_CORPUS_DIR, longHorizonAnswerMatches, longHorizonAsksLeakAnswer, longHorizonPartDir,
  parseLongHorizonAnswerFile, renderLongHorizonAnswerFile, scoreLongHorizonAnswers, type LongHorizonSpec,
} from './bench/longhorizon';

export {
  benchConfigHash, buildBenchReport, buildGainReport, caseIsUnstable, decideBenchOutcome, GAIN_CALIBRATION,
  renderBenchSummary, renderGainSummary, type BenchRunConfig, type GainTaskScore,
} from './bench/report';

export {
  DEFAULT_SEALED_FRACTION, manifestHash, partitionCorpus, promptLeaksFix, SEAL_SALT, SealedSplit, splitOf, taskHash,
  validateWithRetries, type BenchCorpus, type PartitionOptions, type SealedScorecard, type TaskValidation,
} from './bench/split';

export {
  binomialTwoSidedP, computeGain, DEFAULT_ALPHA, floorPValue, fmtPp, minimumDetectableEffect,
  minimumPairsForSignificance, normalQuantile, pairedBinaryComparison, pairedBootstrapCI, requiredPairs,
  summarizeRepeats, unitHash, type PairedOutcome,
} from './bench/stats';

export {
  AttemptOutcomeSchema, attemptPassed, DEFAULT_ATTEMPT_BUDGET, runOrder, type AttemptBudget, type AttemptOutcome,
  type BenchCheck, type BenchTask, type CheckOutcome, type Solver, type SolverContext, type SolverResult,
} from './bench/types';

export { listProposedTasks, updateProposedTaskStatus } from './curriculum/proposer';

// Providers. Secrets stay inside UserDO and never enter the provider layer.
export { createAIGatewayProvider } from './providers/ai-gateway';

export {
  ANTHROPIC_CRED_KEY, ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_MAX_BREAKPOINTS, createAnthropicProvider,
  listAnthropicModels,
} from './providers/anthropic';

export {
  armedWarms, CacheWarmingLane, CacheWarmStore, initCacheWarmTable, type CacheWarmArm, type CacheWarmSeams,
} from './providers/cache-warming';

export { catalogCredKey, catalogProviderOfKey, createModelsDevCatalogSource } from './providers/catalog';

export {
  CHATGPT_PASTE_REDIRECT, chatgptHostId, chatgptLoginIssuer, ChatGptPasteSignInSchema, chatgptRegistrationOf,
  ChatGptRegistrationSchema, finishChatGptPasteSignIn, startChatGptPasteSignIn, type ChatGptPasteOutcome,
} from './providers/chatgpt-sign-in';

export { CHATGPT_CRED_KEY, CHATGPT_DEFAULT_MODEL, CHATGPT_USAGE_URL, createChatGptProvider } from './providers/chatgpt';

export {
  CLAUDE_OAUTH_CALLBACK_PORT, claudeCodeFrom, claudeSignInRefusal, createClaudeOAuthClient, startClaudeSignIn,
} from './providers/claude-oauth';

export { CLAUDE_CRED_KEY, createClaudeProvider } from './providers/claude';

export { createCloudflareAIFetch, errorResponse, mapGatewayError } from './providers/cloudflare-ai-fetch';

export {
  accountIdFromCloudflareCredential, CLOUDFLARE_AI_GATEWAY_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY,
  CLOUDFLARE_WEB_SEARCH_CRED_KEY, CLOUDFLARE_WORKERS_AI_SCOPES, cloudflareAccountAPIRoot,
  cloudflareAccountsFromCredential, cloudflareAIGatewayId, cloudflareTokenToCredential, cloudflareWorkersAIBaseURL,
  fetchCloudflareAIGateways, grantsWebSearch, isCloudflareAIGatewayId, isCloudflareCredentialExpiring,
  isCloudflareCredentialUsable, readJsonObject, refreshCloudflareCredential, scopeList, storedCredentialKey,
  withCloudflareAccount, type CloudflareAccount, type CloudflareAIGatewaySummary, type CloudflareTokenPayload,
} from './providers/cloudflare-oauth';

export { CODEX_TOKEN_URL, createCodexOAuthClient, decodeCodexAccountId } from './providers/codex-oauth';

export { CODEX_CRED_KEY, createCodexProvider } from './providers/codex';

export { bindingDecisionRun, createDecisionPort, decisionPortOf, restDecisionRun, type DecisionRun } from './providers/decision-model';

export { DECISION_MODELS, DEFAULT_DECISION_MODEL } from './providers/decision-models';

export { asFetchFunction, copyHeaders, plainFetch } from './providers/fetch-shim';

export { createGatewayBindingFetch, parseGatewayTarget, type GatewayTarget } from './providers/gateway-binding-fetch';

export {
  fetchGatewayCredits, GatewayCreditsReadSchema, gatewayCreditsUrl, type GatewayCreditsRead,
} from './providers/gateway-credits';

export {
  GOOGLE_CONNECTION, GOOGLE_CONNECTION_SCOPES, GOOGLE_OAUTH_CRED_KEY, googleConnectionClient,
  googleCredentialExpiring, googleGrantOf, GoogleTokenSchema, googleTokenToCredential, refreshGoogleCredential,
  type GoogleConnectionEnv, type GoogleGrant,
} from './providers/google-connection';

export {
  countRequestInputTokens, NO_COUNT_ENDPOINT, type CountableRequest, type InputTokenCount,
} from './providers/input-tokens';

export {
  createModelRegistry, defaultSpecFor, normalizeModelSpec, specModelInfo, type SpecDefault,
} from './providers/model-registry';

export { testModel } from './providers/model-test';

export { ModelTestResultSchema, modelTestText, providerName, type ModelTestResult } from './providers/model-test-result';

export {
  getModelsDevProvider, listModelsDevProviderModels, listModelsDevProviders, modelsDevCompatBaseURL,
  type ModelsDevProviderInfo,
} from './providers/models-dev';

export {
  revocationEndpointFor, revokeOAuthGrant, revokingProviderOf, type DisconnectOutcome,
} from './providers/oauth-revocation';

export { OAuthTokenError } from './providers/oauth-token-error';

export {
  createNamedEndpointSource, createOpenAICompatProvider, discoverOpenAICompatibleModels,
} from './providers/openai-compat';

export { createOpenAIProvider, OPENAI_CRED_KEY, OPENAI_DEFAULT_MODEL } from './providers/openai';

export { createOpenRouterProvider, OPENROUTER_CRED_KEY, OPENROUTER_DEFAULT_MODEL } from './providers/openrouter';

export { ProviderPacer } from './providers/pacing';

export {
  CLOUD_PROXY_PROVIDER_IDS, cloudProxyBaseURL, createProviderProxyFetch, isProxyDeniedCredentialKey,
  PROVIDER_PROXY_PATH, providerProxyBaseURL, providerProxyCredentialsURL, providerProxyForwardURL, PROXY_CRED_HEADER,
  PROXY_TARGET_HEADER, proxyAuthResolution, proxyTargetAllowed, USER_AI_PROXY_PATH, USER_AI_RUN_PATH,
  type CloudProxyProviderId,
} from './providers/proxy';

export { quotaWindowText, type CallAccount } from './providers/quota';

export {
  declaredReasoningEffort, isReasoningEffort, nextReasoningEffort, offeredReasoningEfforts, REASONING_EFFORTS,
  ReasoningEffortSchema, type ReasoningEffort,
} from './providers/reasoning-effort';

export {
  accountDeps, createProviderRegistry, providerAccounts, type ModelMenu, type ProviderAccounts, type ProviderRegistry,
} from './providers/registry';

export { type ProviderFailure } from './providers/provider-failure';

export { relayRefusal } from './providers/relay-policy';

export {
  CLAUDE_LOGIN_ISSUER, heldLogin, renewableLogin, rotateLogin, subscriptionIssuer, usableLogin, type LoginRenewal,
  type SubscriptionIssuer,
} from './providers/subscription-login';

export { isPortableToolCallId, toolCallIdFor } from './providers/tool-call-id';

export {
  formatModelSpec, parseModelSpec, refusedLogin, specOn, specProvider, specWithoutAccount, splitSpec,
  type AuthRequest, type AuthResolution, type AuthResolver, type CacheRetention, type CatalogShelf,
  type GatewayRunRequest, type ModelAffinity, type ModelAttemptInfo, type ModelCallDeps, type ModelInfo,
  type ModelInputModality, type ModelPricing, type ModelProvider, type ModelSpec, type ProviderDeps,
  type ProviderEnv, type ProviderInfo, type ProviderWaitInfo, type WorkersAIBinding, type WorkersAIRunBinding,
  type WorkersAIRunOptions,
} from './providers/types';

export {
  LimitCache, limitHeading, limitLines, limitReadable, limitUnreadText, limitWindowText, type LimitReport,
  type LimitSource, type LimitWindow,
} from './providers/usage-limits';

export {
  catalogModelInfo, describeProviderError, formatContextWindow, mapModelList, providerFailureFacts, settleModelList,
  toProviderError,
} from './providers/util';

export {
  DEFAULT_WEB_SEARCH_CHAIN, WEB_SEARCH_PROVIDER_IDS, WEB_SEARCH_PROVIDERS, WebSearchRouteSchema,
  type WebSearchBilling, type WebSearchProviderId, type WebSearchRoute,
} from './providers/web-search';

export {
  actorAffinity, DEFAULT_WORKERS_AI_MODEL_ID, DEFAULT_WORKERS_AI_MODEL_SPEC, SESSION_AFFINITY_HEADER,
  sessionAffinityOf, WORKERS_AI_MODEL_ID_PREFIX, WORKERS_AI_PROVIDER_ID, workersAiSpec,
} from './providers/workers-ai';

export type { Credential, OAuthCredential, OpenAICompatCredential } from './credentials/store';

// Credential store policy
export {
  createCredentialCipher,
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

export {
  MAIN_ACCOUNT,
  accountCredentialKey,
  accountOf,
  baseCredentialKey,
  isAccountName,
  openAICompatKey,
  openAICompatNameOf,
  splitAccount,
  storedAccounts,
} from './credentials/accounts';

// Plan review
export {
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
  reviewFeedbackText,
  formatPlanWithLineNumbers,
  initPlanReviewTable,
  workModeUnderReview,
  planHandoffStillOwed,
  approvedTaskPlan,
  planReviewAwaitingDecision,
  planTitle,
  type PlanDecisionOutcome,
  type PlanEdit,
  type PlanReview,
  type ReviewAnnotation,
  type GeneralNote,
  type NoteReply,
  type PassageNote,
  type DiffAnchor,
  type DiffSide,
  type PlanReviewDecision,
  type PlanReviewResult,
  type SubmitPlanToolDeps,
  type ReplyToCommentToolDeps,
} from './plans/index';

export {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  DEV_IDENTITY_ACCOUNT_HEADER,
  DEV_IDENTITY_HEADER,
  EVAL_ACCOUNTS,
  EVAL_TRIAL_ACCOUNTS,
  UPGRADE_FIXTURE_ACCOUNTS,
  WORKER_VERSION_HEADER,
  EVAL_WORKSPACE_BEAT_MS,
  EVAL_WORKSPACE_LEASE_MS,
  EVAL_WORKSPACE_PREFIX,
  evalAccountEmail,
  inheritedRows,
  isEvalAccountEmail,
  parseEvalAccount,
  type EvalAccount,
  DEVICE_CONNECT_PATH,
  DEVICE_TERMINAL_PATH,
  DEVICE_SCREEN_PATH,
  ORCHESTRATOR_AGENT_SLUG,
} from './cloud-wire';

// Platform facts: prose cites an entry by its id and never restates the number.
export {
  platformFact,
} from './platform-catalog';

export { PLATFORM_LIMITS, silenceBoundMs } from './platform-limits';

// Safety
export {
  reviewCommand, type ApprovalDecision,
  type FilesOwner, type GatedExecutor,
} from './safety/command-review';

export { readShellWord } from './safety/shell-reading';

export {
  asOwnerCommand, formatApproval, gatedGrants, formatApprovalGrant, holdsGrant, parseApprovalGrant, gateExec, grantsAreSubset,
  resolveInheritedGrants, createInheritedApprovalPolicy, describeExecutionContext,
  type ExecutionContext, type ApprovalGrant, type ShellApprovalRequest,
  type ShellApprovalOutcome, type ShellApprovalPolicy, type DeferredApprovalChannel,
  type ApprovalSpend,
} from './safety/approval-gate';

export {
  EGRESS_PLACEHOLDER_PREFIX, isEgressPlaceholder, isSecretName, egressPlaceholdersIn, revealHeader, revealUrl, positionWords,
  findEgressPlaceholders, egressHostMatches, planEgress, scrubBytes, closeReason, scrubText,
  createScrubStream, SecretPositionSchema, type EgressSecretBinding, type EgressRequestFacts, type SecretPosition,
  type ScrubReplacement,
} from './safety/egress-gate';

export { egressAuthority, type EgressPrincipal } from './safety/egress-principal';

export { initOwnerRequestsTable } from './safety/owner-requests';

export {
  DeferredApprovalQueue, decideDeferredApprovals, DeferredApprovalStore,
  DEFERRED_APPROVAL_SIGNAL, DENIAL_STANDING_MS, DeferredApprovalSchema, type DeferredApproval,
  type DeferredApprovalAnswer,
  type DeferredApprovalNotice, type ParkedWrites, type SlateEffectVerdict,
} from './safety/deferred-approval';

export {
  listSecrets, putSecrets, setSecretDestination, deleteSecret, grantSecret, revokeSecretGrant,
  grantedSecrets, revealedSecrets, resolveEgressInjection, mintEgressPlaceholder, connectionEnvironment,
  type SecretSummary, type SecretInput, type SecretDestination, type GrantedSecrets,
  type EgressInjectionResult, type EgressVaultDeps, type ConnectionSecret, type CommitAuthor,
} from './safety/egress-vault';

export {
  ownerCaller, OwnerCapabilityUnavailableError, CapabilityDeniedError,
  workspaceCapabilityHash, freshWorkspaceCapability, commitWorkspaceCapability, revokeWorkspaceCapability,
  requireTier, type WorkspaceCapability, type UserCaller, type ResolvedCaller,
  type OwnerCapabilityEnv,
} from './safety/workspace-capability';

export {
  argumentDigest, sha256Hex, stableStringify,
} from './safety/argument-digest';

export {
  InstructionApprovalStore, initInstructionApprovalsTable, instructionDigest,
  type InstructionApproval,
  type InstructionTrustResolver, type AdmittedInstructionDecision,
} from './safety/instruction-trust';

export {
  DeviceConsentRegistry, DeviceConsentStore, deviceConsentMoved, deviceConsentOutcome, type DeviceConsentOutcome,
  DEVICE_CONNECT_DISCLOSURE, HOME_FOLDER_CONSENT, issuedDeviceConnected, summarizeDeviceAction,
  type DeviceConsentAnswer, type DeviceConsentRequest, type DeviceConsentVerdict,
  type PendingDeviceConsent, type DeviceConsentNotice, PendingDeviceConsentSchema, ResolvedDeviceConsentSchema,
} from './safety/device-consent';

export {
  AgentWorkspaceStore, createAgentWorkspace,
  type AgentWorkspaceDeps,
} from './identity/agent-workspaces';

export {
  SECRET_PATTERNS, redactLiterals, redactSecrets, secretProvider, type SecretPattern,
} from './safety/secret-patterns';

export { parseDotenv, pastedSecrets, type PastedSecret } from './safety/pasted-secrets';

export {
  scanText, countDetections, type SecretFinding,
} from './safety/secret-scan';

export {
  performBoundWrite,
} from './safety/bound-write';

export { approvalKindOf, mailSendExecutor, mailSendText, slateEffectExecutor, slateEffectText, type ApprovalKind, type GoogleWrite, type MailSend, type SlateEffect } from './safety/approval-kind';

export {
  ParkedWriteFiles,
} from './safety/parked-write-files';

export {
  egressHost,
  refusedHostname,
} from './safety/egress-destination';

export { revealMisrepresenting } from './safety/untrusted-text';

export { fnv1a64 } from './utils/fnv1a';

export { nanoid } from './utils/nanoid';

export { abortCause } from './utils/abort';

export { base64Url, createPkcePair, hmacSha256Hex, randomToken, timingSafeEqual } from './utils/crypto';

export { labelSigner, type LabelSignerEnv } from './utils/label-signer';

export { shellQuote } from './utils/shell';

export {
  wilsonInterval, seededRandom,
} from './utils/stats';

export { isoDate } from './utils/date';

// Branching heads
export type {
  HeadId, HeadInput, HeadReport,
  HeadStep, HeadRunView,
  SplitRequest,
  HeadFileChange,
  MergeResult,
  SerializedMessage,
} from './heads/index';

export {
  shownHeadStatus,
  initHeadsTables,
  HeadJournal,
  LiveHeadJournal, type AnnounceHeadActivity,
  type HeadStreamFrame, type HeadStreamKind,
  type ReportHeadDelta, type PublishHeadStream,
  reconcileInterruptedForks, reclaimSettledRunActors, jobRedriveResumeGate, resumableForkRoots,
  FORK_INTERRUPTED_SIGNAL,
  ForkNotices, forkNoticeDeliveries, initForkNoticeTable,
  HeadController, runHeadSplit, type HeadRuntime, type HeadGrounding, type SpawnedHead,
  type HeadJournalPort,
  MergeOutputSchema, type MergeOutput,
  // Resolved here so both backends resolve it identically.
  headMergeLLM,
  HeadCapture, runHeadInference, preparedHeadRun,
  buildHeadMessages,
  type HeadInferenceDeps, type RunInference,
  buildHeadToolSet, spawnSeatedHead, type HeadSeat,
  type HeadSplitRequest, type HeadSplitResult,
} from './heads/index';

// Background jobs
export {
  BackgroundJobStore, initBackgroundJobsTable, withBackgroundThreshold,
  backgroundJobNotice,
  SPAWN_STARTED_OPTION,
  DEVICE_REQUEST_OPTION, readDeviceRequestChannel, DeviceRequestOwnership, execCallArgs, execContext,
  BackgroundJobRunner, BACKGROUND_POLICY, RESUMED_SURFACE, JOB_STAMP_ENV, MAX_CONCURRENT_DETACHED_JOBS, recordServingJobs, type PortHolders, type ServingScope,
  invocationBackgroundPolicy,
  backgroundJobWakeTrigger, BACKGROUND_FIBER_PREFIX,
  type BackgroundJob, type BackgroundHandle, BackgroundHandleSchema,
  type BackgroundPolicy, type InvocationSurface, InvocationSurfaceSchema, type AdoptsJobs,
  type BackgroundJobRunnerDeps, type JobHolder, initJobHoldersTable, processJobHolder, type JobResumer, type DeviceRequestChannel, type WorkspaceJobPorts,
  WorkspaceJobAuthorities, endedStepLoopJobs, inlineResultInbox, type JobAuthority, type JobRetirement, type StepLoopJobSeat,
  JOB_OUTPUT_EVENT, JobOutputFrameSchema, JobOutputTailSchema, followJobOutput, lastOutputLines, jobName, shortJobId,
  type JobOutputFrame, type JobOutputTail,
} from './jobs/index';

export {
  TaskListStore, initTaskListTable, taskSettled, taskTreePhase,
  type AgentTask, type AgentTaskTree, type TaskStatus,
} from './tools/task-store';

export { withTaskPlan, bindTaskPlan, type TaskPlan } from './tools/task-plan-scope';

export {
  taskReminderOf, resultOwed, owedReadsOf, TASK_REMINDER_EVENT,
  type OwedReads,
} from './tasks/reminder';

export { cardWords, TASK_REMINDER_OPEN_KEY } from './read-models/event-summary';

export {
  TurnAccumulator,
} from './orchestrator/turn-accumulator';

export { readWorkspaceWork, hasWorkspaceWork, actorReadHandle, WorkspaceWorkSchema, WORK_TAB_JOBS } from './read-models/workspace-work';

export { agentTitle, nestedAgent, type AgentLinkIds, type InspectSubagent } from './subagents/nested-agent';

export { recognizeGitHubMcp, GitHubFactSchema, GITHUB_MCP_PRESET, type GitHubFact } from './github/recognize';

export { observeGitHub, type GitHubRecorder } from './github/observe';

export {
  readGitHubActivity, recordGitHubActivity, recordGitHubObservations,
  type WorkspaceGitHub,
} from './github/activity';

export {
  gitHubRefreshAsk, GitHubRefreshAskSchema, refreshGitHub, type GitHubRefreshAnswer, type GitHubRefreshAsk,
  type WorkspaceGitHubView,
} from './github/refresh';

export { readGitHubRemotes } from './github/remotes';

export {
  mainPanelAgent, measuredAt, readWorkspaceAgents,
  type PanelAgent, type AgentActivity, type ChatReport,
} from './read-models/workspace-agents';

export { readAgentFigures, recordAgentFigures, reportedAgentFigures, NO_FIGURES, type AgentFigures } from './read-models/agent-figures';

export type { WorkspaceWork, OwnedPlan, WorkspaceWorkOwner } from './read-models/workspace-work';

export { openingList, openingListOf, listedOn } from './read-models/opening';

export { AgentOrchestrator, drainPendingEvents, type AgentOrchestratorDeps } from './orchestrator/agent-orchestrator';

export { advisorReadTool, advisorReadTools, advisorReadsOver, type AdvisorReadTools } from './advisor/advisor-ports';

export {
  EvolutionLanes, evolutionPassOpen, recordedTurn, type TurnContinuity,
} from './orchestrator/evolution-lanes';

export { ActorSession, CLEAR_NEEDS_IDLE, COMPACT_NEEDS_IDLE, type ActorTurnLease } from './orchestrator/actor-session';

export {
  ChatSession, type OpenWork, type CompactOutcome, type ComposedRequest, type ChatTransport, type ChatTurnInput,
  type PreparedTurn, type TurnOpening, type TurnOpeningAsk, openingCacheCold, type OwedTerminalEffectsInput, type SessionEvent, type TurnEndEvent, type SendOptions,
  STEP_CUT_CHUNK, StepCutDataSchema,
} from './orchestrator/chat-session';

export type { DeliveredRun } from './orchestrator/chat-queue';

export type { RewindComputer, RewindTold } from './orchestrator/rewind-notice';

export { startActorTurn } from './orchestrator/actor-turn';

export {
  ActorClaimStore, claimFences, initActorClaimTables, programIdentityOf, turnAttemptOf, verifyClaimedProgram,
  type ActorTurnClaim, type StoredActorClaim,
} from './orchestrator/actor-claims';

export { prepareActorProgram } from './orchestrator/actor-program';

export {
  TurnSteering,
} from './orchestrator/turn-steering';

export {
  observeCompletionState, completionGateText,
  COMPLETION_GATE_EVENT,
} from './orchestrator/completion-gate';

export {
  assembleTurnMessages,
  type CompactionTriggerReader,
} from './orchestrator/turn-context';

export {
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery, creditedTurnId,
  classifyRunEnd, TOOL_CALLS_PENDING, OUTPUT_LIMIT_REACHED, TURN_ENDED_MID_WORK,
  OUTPUT_CONTINUATION_EVENT, OUTPUT_CONTINUATION_TEXT,
  type CompactionTriggerState,
} from './orchestrator/turn-lifecycle';

export {
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  type ScaffoldHistoryPage,
} from './orchestrator/scaffold-host';

export { createScaffoldCandidateSurface, type ScaffoldCandidateBinding } from './evolution/scaffold-candidate';

export { activeOperationProfile, captureOperationProfile, currentOperationProfile, runOperationProfile,
  withOperationProfile, operationProfileStream, type OperationProfile,} from './profiles/operation';

export {
  bindRoute, completeOnRoute, createRoutedModelLane, routedLlm, type ModelLaneComponents, type RouteModelBinder,
  type RouteModelBinding,
} from './profiles/model-lane';

export { tierRefusals } from './profiles/tier-refusals';

export type { TierRefusals } from './types/refusals';

export {
  BACKGROUNDABLE_TOOLS, resumeBackgroundJob, resumableBackgroundJob, harvestBackgroundJob,
} from './orchestrator/background-tools';

export {
  CONFINED_BACKGROUNDABLE_TOOLS, type ActorJobs,
} from './jobs/background-wrap';

export {
  steerSkillsBlock, filterToolSetBySkills,
} from './orchestrator/turn-surface';

export { ModelCatalogSession, resolveEffectiveModelSpec } from './orchestrator/model-catalog';

export type { TurnAuthorship } from './types/turn';

export {
  turnTags, authoredTurnMetadata, stampAuthorship, TURN_AUTHOR_METADATA_KEY, MISSION_LABELS_METADATA_KEY, TERMINAL_TURN_KEY, answerDrawsPages,
} from './types/turn-metadata';

export {
  AgentDeliveries, AgentStops, DeliveryInbox, DeliverySchema, wordsRefusal, initAgentDeliveriesTable, pendingEventsDelivery, assignmentDelivery, deliveryMetadata, deliveredSignal, handBackCarried, type OwedDelivery, type OwedAdmission, type Delivery, type DeliveryAnswer, type IntentResult, type OwedIntent, type OwedOwnerIntent, OwedIntentSchema, OwedOwnerIntentSchema,
  SendMetadataSchema, sentWords, type SendMetadata, type SentWords,
} from './subagents/deliveries';

export { DeliveryCoordinator, InProcessDeliveries, type CrossedDelivery } from './subagents/delivery-coordinator';

export {
  serializeContentForHeads,
  inheritedContextFromTranscript,
} from './orchestrator/heads-support';

export {
  parseSkillFile,
  discoverSkills, listSharedSkills, workspaceSkillPath,
  BUILTIN_SKILLS, BUILTIN_SKILL_FILES, BUILTIN_SKILL_HEADERS, isBuiltinSkillFile, skillsMount,
  renderActiveSkillsSection, skillIndexLine,
  WORKSPACE_SKILLS_DIR, SKILL_FOLDER_FILE, skillViewPath,
} from './skills/index';

export type {
  SkillHeader, DiscoveredSkill, ActiveSkill,
  ActiveSkillSet,
  DiscoverOpts, SkillFileRefusal, SharedSkillsListing,
} from './skills/index';

// The scaffold's versions.
export {
  getEvolutionStatus, listScaffoldVersions,
  previewScaffoldLive, runScaffoldOnce,
  type EvolutionStatus, type ScaffoldControl,
  type ScaffoldVersionView,
} from './evolution/control';

// The artifact store a dream's section and tool edits stage in (docs/EVOLUTION-REDESIGN.md §3-4).
export {
  artifactOverrides, currentArtifacts,
  sectionArtifact, stageArtifact, turnArtifacts,
  type ArtifactOverrides,
} from './evolution/artifacts';

export { withToolText } from './tools/tool-text';

// Continual refinement: each proposed edit routes to the authority that owns the artifact.
export {
  createRefinementStore,
  refinementStagingPath, RefinementRequestViewSchema,
  type RefinementDeps,
  type RefinementRequestView, type RefinementRoute, type RefinementScope,
} from './evolution/refinement';

export { type RefinementLaneStep } from './evolution/refinement-lane';

export {
  listRefinements, idleDream, refinementPass, requestOwnerRefinement, RefinementListingSchema, type RefinementListing,
} from './evolution/refinement-host';

export { activateDreamSkills, dreamSkillsHidden } from './evolution/refinement-skill';

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
  ToolFailureCensus,
} from './read-models/tool-failures';

export {
  CHANGES_MOVED_EVENT, ChangeSetCache, countWorkspaceChanges, getExecutorChangeCount, getExecutorDiff, getWorkspaceDiff, resetWorkspaceBaseline,
  restoreWorkspaceBaseline, type ExecutorChangeCount,
} from './read-models/workspace-diff';

export type {
  ExecutorDiffResult, WorkspaceBaselines, WorkspaceDiffResult, WorkspaceReviewResult,
} from './read-models/workspace-diff';

export {
  LIVE_READS, LiveReadsNotice, PAGE_KEEPALIVE, READS_CHANGED_EVENT, ROSTER_READS, readsMovedByFiles, readsWrittenBy, readsOfTables,
  type LiveRead,
} from './read-models/live-reads';

export {
  anchoredText, changeBlocks, changeBody, changeTotals, changeTree, inReadingOrder, keepUnchanged, sideBySide,
} from './read-models/change-view';

export {
  ALL_CHANGES_BLOCK, changeNoteAnchor, changeNotesCard, initChangeNotesTable, inNoteOrder, readChangeNotes, saveChangeNotes, sendChangeNotes,
  deliverOwedChangeNotes, owesChangeNotes,
} from './read-models/change-notes';

export type { ChangeNote, ChangeNotesCard, ChangeNotesChat, ChangeNotesResult, NotedChanges } from './read-models/change-notes';

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
  ExecutorFileUpload, ExecutorFileDownload, ChunkedUpload,
} from './read-models/files';

export { serveDownload, serveUpload } from './read-models/file-transfer';

export type {
  DirEntry, EnvironmentInfo, ExecutorFileLookup, ExecutorTextFile, ExecutorWriteResult,
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

export {
  ownerWaits, ownerWaitsHost, wakeMetOwnerWaits, type OwnerWaitReader, type ScopedOwnerWait,
} from './read-models/owner-waits';

export { type BlueprintSchedule } from './types/blueprint-schedule';

export { reviewParkedWrite, type ParkedWriteReview } from './read-models/write-preview';

export {
  listInstructionApprovals, readInstructionSource,
  previewInstruction,
} from './read-models/instruction-approvals';

export { InstructionApprovalDesk } from './read-models/instruction-desk';

export type {
  InstructionSourceMeta, InstructionSourceRow,
  InstructionSourceView,
} from './read-models/instruction-approvals';

export { agentStatusFacts, chatSeed, getAgentStatus, getChatHistoryPage, getToolList, type ChatHistoryPage, type ChatWindow } from './read-models/status';

export { WorkspaceLayoutSchema, type WorkspaceLayout } from './config/workspace-layout';

export {
  blueprintOwnerName, blueprintPage, blueprintSeed, personName,
  type WorkspaceBlueprint, type WorkspaceSeed,
} from './blueprints/workspace';

export { PERSONAL_ASSISTANT_ID, kinuBlueprint, kinuListings } from './blueprints/kinu';

export { ClockSchema } from './blueprints/workspace';

export { pageSchema, positionPageSchema, PositionCursorSchema, PositionPageRequestSchema, seekPage } from './session/page';

export type { Page, PageRequest, PositionCursor, PositionPageRequest, SeekCursor } from './session/page';

export {
  MESSAGE_AMENDED_FRAME, MessageAmendedFrameSchema, newestOpener, restoredRows, rowText, UIMessageSchema,
  PROGRAMMATIC_MESSAGE_ID_PREFIX, announcementOf,
} from './utils/ui-message';

export type { PendingAction, PendingActionKind, PersonAsks } from './read-models/pending-actions';

export { buildWorkspaceOverview, rosterBucket, rosterComesBefore, rosterHeadline, rosterMatches, WorkspaceOverviewSchema } from './read-models/workspace-overview';

export { ownerIsAway, watchFrame, type AlertWatch, type OwnerAlert } from './read-models/owner-alerts';

export { OverviewPush } from './read-models/overview-push';

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
  CancelWorkOutcome, ListedBackgroundJob, RetryOutcome,
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
  ADVISOR_SEVERITIES,
  ADVISOR_SEVERITY_LABEL,
  ADVISOR_SEVERITY_METADATA_KEY,
  ADVISOR_NOTE_METADATA_KEY,
  ADVISOR_SIGNAL_KIND,
  keptAdvisorNote,
  DEFAULT_ADVISOR_MIN_SEVERITY,
  ADVISOR_HEADER,
  sayAdvisorNote,
  isContentFree,
  isDuplicateNote,
  judgeNote,
  normalizeNote,
  type AdvisorNote,
  type AdvisorSeverity,
} from './advisor/review';

export { isAdvisorSeverity } from './types/advisor';

export {
  getEvolutionChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
} from './read-models/evolution-views';

export { EvolutionChangelogViewSchema, type EvolutionChangelogView } from './read-models/evolution-views';

// Profile catalogs
export {
  TIER_IDS, DEFAULT_PROVIDER_RETRIES, tierIdsOf, isTierId, retargetedTier,
  isValidRoleId, validateProfileCatalog, validateProfileCatalogEnvelope,
  profileCatalogCanonical, profileCatalogDigest, deriveRoleLabel, effectiveRoleCatalog,
  BUILTIN_ROLE_DEFINITIONS, BUILTIN_PROFILE_CATALOG,
  ProfileCatalogEnvelopeSchema, betaSwarms, SWARMS_BETA_SETTING, webSearchChainOf,
} from './profiles';

export type {
  TierId, RoleId,
  TierAssignment, TierAssignments, RoleDefinition, RoleCatalog, ProfileCatalog,
  ProfileCatalogEnvelope,
} from './profiles';

export {
  resolveModelRoute,
  loadProfileAuthorityInputs, resolveTurnProfile, resolveRoutingProfile, ownProfileChoices, ancestorPins,
  type ProfileAuthorityInputs, type ProviderCatalogSnapshot, type PinnedProfile,
  type ResolvedTurnProfile,
  type ModelRouteResolution,
  DEFAULT_ROLE_ID,
  KeptProviderListingSchema, providerListingKey, providerListingOf, providerSnapshotOf, ProviderListingCache,
  type ProviderListing, type ProviderSnapshotRead, type StoredProviderListing,
  fastAssignment, fastCandidatesOf,
  agentRoleSwitch, changeRoleAsOwner,
} from './profiles';

export { createStore, type Store } from './utils/store';

export { calendarDay, clockTime, countOf, fmtPct, fmtSpan, fmtTokens, fmtUsd, formatBytes, shortAge, timeAgo } from './utils/format';

export { ownedStream, relayedAnswer } from './utils/relayed-answer';

export { inheritedDescriptor, type RpcSurfaceSubject } from './utils/prototype-members';

export {
  type ActivitySnapshot, type ExecutorCommandResult, type ForkNode,
  type MemoryEntry, type PendingConsent, type SubagentActivityEvent,
  type TabPresence, evolutionSubagent, ownerFacingSubagent,
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
  isWorkspaceTerminal, WORKSPACE_SHELL_SESSION, workspaceSessionOf, workspaceSessionTag, WorkspaceSessionRecordSchema, type WorkspaceSessionRecord,
} from './execution/workspace-terminal';

export {
  type WorkspacePreviewUrl, buildWorkspacePreviewHost, parseWorkspacePreviewLabel,
} from './preview/nimbus-preview-host';

export {
  buildSlateShareHost, parseSlateShareLabel,
} from './preview/slate-share-host';

export {
  DRAWN_SANDBOX, PREVIEW_SANDBOX, containPreviewResponse, extractPreviewUrl, hostOf, previewSite, isPreviewHostRequest,
  isPreviewUrl, previewHostSuffix, previewPortSuffix, previewSuffixMetaName, sandboxPreviewLabelOf,
  type PreviewPortEnv, type PreviewSuffixEnv,
} from './preview/preview-origin';

export {
  previewPortTitle, reconcilePreviewPorts,
  type ExecutorPortRefresh, type ExposedPortList, type PinnedPreviewPort,
} from './preview/preview-ports';

export {
  sandboxPreviewExposure, sandboxPreviewExposures, forgetSandboxPreviews, type ListedKv,
  type SandboxPreviewExposures,
} from './preview/preview-exposures';

export {
  err, ERROR_STATUS, escapeHtml, fileResponseHeaders, json, PUBLIC_MESSAGE, publicError, publicText,
  readBounded, readBoundedStream, reoriginateRequest, requestUrl, safeJson,
} from './http/http';

export { KINU_USER_AGENT, kinuUserAgent } from './utils/user-agent';

export { PRIVATE_NO_STORE, publicHtmlHeaders, withAppSecurityHeaders } from './http/security-headers';

export { desktopClientUrl } from './http/desktop-client';

export { serveApp, VISITOR_SHELL } from './http/app-shell';

export { httpsUpgrade, isPublishedHost, published } from './http/published';

export { ingressAdmission, ingressAdmitted, ingressDenied, peerIp } from './http/ingress-budget';

export {
  CLI_DIST_PATHS, CLI_RUNTIME_PATH, CLI_VERSION_PATH,
  BuildStampSchema, fetchDeployedAsset, readBuildStamp, type AssetFetcher, type BuildStamp,
} from './http/deployed-assets';

export {
  releaseArtifact, releaseArtifactHead,
} from './http/release-artifact';

export { RELEASE_SIGNING_PUBLIC_KEY, RELEASE_SIGNING_PUBLIC_KEY_ENV, artifactRefusal, releasePublicKey, verifyRelease } from './http/release-message';

export {
  SignedReleaseSchema, signRelease, generateReleaseSigningKey, type SignedRelease,
} from './http/release-signing';

export {
  DEVICE_UPDATE, DEVICE_UPDATE_STATES, cliArtifactPath, deviceUpdateState, isSameBuild,
  type DeviceUpdateFrame, type DeviceUpdateState,
} from './http/device-update';

export { DeviceDesktopSchema, NO_DESKTOP, type DeviceDesktop } from './execution/device-desktop';

export {
  mark, markDocument, publicPage,
} from './http/public-shell';

export { MODE_KEY, modeFor, PREFERS_LIGHT } from './utils/color-mode';

export {
  accountTheme, avatarGround, DEFAULT_THEME, ILLUSTRATION, REDACTION_FILL, terminalPalette, THEME_CONFIG_KEY, THEME_CSS, THEME_NAMES, THEME_TOKENS, themeNamed,
  type Mode, type TerminalPalette, type ThemeName,
} from './web/theme';

export {
  accountFilesView, DEFAULT_FILES_VIEW, FILES_VIEW_CONFIG_KEY, filesViewNamed, type FilesView,
} from './web/files-view';

export { hueStops, rankHue } from './web/agent-colour';

export { SLATE_PAGE_MODULES, SLATE_PAGE_MODULES_PATH, SLATE_PAGE_PREAMBLE } from './web/slate-page';

export { slatePushes } from './web/slate-pushes';

export { APP_FONTS_PATH, appFontFile, SLATE_FONTS_PATH } from './web/fonts';

export {
  approvalDocument, authDocument, installDocument, loginDocument, type BuiltinSignIn,
} from './http/public-pages';

export {
  currentTakeIndex, takeChipLabel, cycleTakeIndex, hasComparableTakes, describeTakePick,
} from './read-models/alternate-takes';

export {
  classifyProgrammaticTurn, systemEventTurn, delegatedTaskMetadata, messageSignalId, isSteeredMessage, endedMidWork, TURN_END_METADATA_KEY, turnFailure, TURN_FAILURE_METADATA_KEY, slatesChanged, SLATES_CHANGED_METADATA_KEY, slatesToPreview, applySignalCard,
  splicesSeenOn, SIGNALS_SEEN_METADATA_KEY, type SeenSplice,
  parseSignalCardEvent, parseDrainedEvents, eventVariantLabel, eventSourceLabel,
  metadataBroadcastEvent,
  type ClassifiedProgrammaticTurn, type SignalCard, type DrainedEvent,
} from './read-models/background-event';

export { turnFailureFacts } from './read-models/turn-failure-facts';

export { namedImages, type ImageMachine, type NamedImage } from './read-models/chat-images';

export { linkProse, promoteSlateLinks, type MarkdownNode } from './read-models/markdown-links';

export {
  appendHeadDelta, retireHeadDelta, deltaAsMessage, NO_HEAD_DELTAS,
  type HeadDelta, type HeadDeltas,
} from './read-models/head-chat';

export { drawnText, liveTailRow, threadLiveTail, toolCallRunning, type LiveTail } from './read-models/message-live-tail';

export { liveStep, watchingLine, type Watch } from './read-models/focus-line';

export { activityOf, receiptSummary, type ActivityCause, type ActivityEntry } from './read-models/activity';

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
  PROVIDER_WAIT_PART, ProviderWaitSchema, SubagentActivityEventSchema, WorkspaceBroadcastSchema, WorkspacePlanUpdatedFrameSchema,
  type MctsProgress, type WorkspaceBroadcast,
} from './read-models/workspace-broadcasts';

export { inspectWork, jobPhase, workActorName, type InspectedWork } from './read-models/work-inspection';

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

export { ChatResponseFrameSchema, terminalChatError, type ChatTurnError } from './utils/chat-turn-error';

export {
  newSendLatch, admitTurn, abandonTurn, abandonTurnIfOwner,
} from './utils/send-admission';

export {
  createSessionRecovery, fetchDeployedBuildSha, isNewerDeployedBuild,
  type SessionRecovery,
} from './utils/session-recovery';

export { pageDeployedBuildSha } from './web/page-build';

export { pageIsVisitors, VISITOR_PAGE_ATTRIBUTE } from './web/visitor-page';

export { loadRouteChunk } from './utils/chunk-recovery';

export {
  isModelInferenceCredentialKey,
} from './providers/inference-credentials';

export {
  MY_GATEWAY_PROVIDER_ID,
  createMyGatewayProvider,
  gatewayWireModel,
} from './providers/my-gateway';

export { WORKERS_AI_STREAMS_GENERATE, createWorkersAIProvider } from './providers/workers-ai-provider';

export { createWireModel, deferredModel, sdkWire, withModelStack } from './providers/wire-model';

export { callRetries } from './providers/middleware/retry';

export {
  type AnyToolPart,
  type RunStep,
  type PartBlock,
  type ToolRunSummary,
  groupMessageParts,
  phaseCalls,
  rollUpTurn,
  toolRunSummary,
  parseProvisionError,
  partOutput,
  partInput,
  partEffect, partProgramEffects,
  callFailed,
} from './read-models/tool-call-grouping';

export {
  PHASE_TITLES_METADATA_KEY, TURN_TITLE_METADATA_KEY, phaseTitle, writtenTitles,
} from './read-models/tool-phase-title';

export { writePhaseLines, type PhaseLinePorts } from './orchestrator/phase-lines';

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
  siteSurface,
  surfaceHasContent,
  surfaceKindOf,
  surfacePreviewTarget,
} from './read-models/surface-presence';

export {
  ACCESS_TOKEN_SCOPES,
  type AccessTokenScope,
  type AccessTokenRecord,
  type AccessTokenMint,
  initAccessTokenTable,
  parseAccessTokenUserId,
  normalizeAccessTokenScopes,
  mintAccessToken,
  verifyAccessToken,
  listAccessTokens,
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

export type { FileCheckpointSurface, OwnerQuestionSurface, PlanReviewSurface, WaitingApprovalSurface } from './cli/owner-surfaces';

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
  untilAnswered,
} from './utils/wait';

export {
  sandboxIdForWorkspace,
  workspaceOfSandbox,
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
  chatMediaPath,
} from './http/agent-routing';

export {
  APP_ROUTES,
  agentRoute,
  cloudflareConnectPath,
  googleConnectPath,
  CONNECT_CHANNEL,
  connectedPath,
  connectEndedOf,
  type ConnectEnded,
  ConnectEndedSchema,
  ConnectRunSchema,
  type ReportedRoute,
  routeTemplateOf,
  sanitizeReturnTo,
  workspaceRoute,
} from './read-models/app-routes';

export {
  COMPACTED, filterCommands, resolveCommandDraft, slashCommand, type SlashCommandInfo,
} from './read-models/slash-commands';

export { conversationMarkdown, lastAnswer, readConversation, type ConversationMessage } from './read-models/conversation';

export {
  needsOnboarding,
  ONBOARDING_STEPS,
} from './read-models/account';

export { DISPLAY_NAME_MAX, confirmsAccountDelete, displayNameProblem } from './read-models/account';

export {
  CLIENT_ERROR_ENDPOINT,
  CLIENT_RENDER_FAILED,
  CLIENT_ERROR_MAX_REQUEST_BYTES,
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

export { KINU_PROGRAM_MODULE, programPlace, type ProgramImport } from './execution/program-place';

export { moduleSpecifiers, type ModuleSpecifier } from './utils/module-specifiers';

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
  adaptMemory, forgetMemoryVectors,
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

export { withCommandEnvironment, type CommandEnvironment } from './execution/command-environment';

export { isViewerProcess, providersWithoutOwnerSecrets, withholdingOwnerSecrets } from './execution/secrets-caller';

export { viewerCred, withViewerPrincipal, type ViewerPlace } from './execution/viewer-principal';

export {
  objectNamed, type ObjectNamespace,
  type PcUserNamespace,
  type PcIngressEnv,
  handlePcConnect,
  handlePcConnectChallenge,
  handlePcConnectTicket,
  handlePcJoin,
  deviceJoinTicketUser,
  DEVICE_JOIN_TICKET_PREFIX,
  handlePcUpdateRefused,
  CONNECT_TICKET_PATTERN,
  DEVICE_KEY_MALFORMED,
  DeviceReplacementSchema,
  type DeviceChallengeIssue,
  type DeviceChallengeProof,
  type DeviceConnectProof,
  type DeviceEnrolment,
  type DeviceReplacement,
  type DeviceTicketIssue,
  type DeviceTicketRefusal,
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

export { MCP_OAUTH_CALLBACK_PATH, MCP_PRESETS, mcpPresetById, type McpPreset, type McpPresetId } from './mcp/presets';

export {
  mcpCredentialFetch, mcpListingRefusals, type McpFailureKind, type McpFetch, type McpRefusal, type McpToolListing,
} from './mcp/client';

export {
  validateMcpServerInput, readAllowedTools, parseMcpHeaders, McpPresetAvailabilitySchema, McpConnectionStatusSchema,
  McpServerSummarySchema, McpTransportSchema, type McpConnectionStatus, type McpPresetAvailability,
  type McpServerSummary, type McpTransport,
} from './mcp/servers';

export type {
  AgentTurnActivity, AgentRecovery, AgentAnswer, AgentAnswerTexts, AgentStanding, AgentStandingReport, AgentReport, AgentOwes, AdmittedDelivery, AgentSteps, RunEndOutcome, RunEndReport, AgentSnapshot, AgentTurnTask, AgentToolAnswer,
  AgentToolCall, AgentToolDescriptor, AgentHeadDelta, AgentTrace, AgentTurnEnd, PreparedAgentTurn, StoredRow, TurnRequestAt,
  AgentAdvisorRead,
} from './subagents/agent-isolate';

export { refusedRun, writesSnapshotRows } from './subagents/agent-isolate';

export { describeAgentTools } from './subagents/tool-descriptors';

export {
  GUEST_APP_TOOL, GUEST_ASK_METADATA, GUEST_ROLE, guestAnswer, guestAppTool, guestDynamicContext, guestSoul, guestTitle, guestVisitorLabel,
  NO_GUEST_INSTRUCTIONS, NO_GUEST_SKILLS, turnEntries,
} from './orchestrator/guest-turn';
