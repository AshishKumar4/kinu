// @kinu.run/core — barrel export

// Identity system
export { initActorTables, initAllTables, migrateWorkspaceStorage, tableExists } from './identity/schema';
export { reconcileColumns } from './identity/columns';
export { readActivityLog, type ActivityLogEntry } from './identity/activity-log';
// The one answer to "which tables a workspace has" — every composition root
// calls this and nothing else (guarded by tests/contract-workspace-schema.test.ts).
export { initWorkspaceSchema, type WorkspaceSchemaSql } from './identity/workspace-schema';
export {
  DEFAULT_SOUL_MD,
  SOUL_PATH,
  WORKSPACE_CREATED_EVENT,
  isPlaceholderMission,
  workspaceGenesisSignal,
  readSoul,
  readMission,
  renderSoulMarkdown,
  seedSoul,
  summarizeSoul,
  writeSoul,
} from './identity/soul';
export { WORKSPACE_IDENTITY_DDL } from './identity/schema';
export {
  forkWorkspaceStorage, snapshotWorkspaceForFork, writeForkSnapshot, readForkLineage,
  type ForkOpts, type ForkResult, type ForkLineageRow, type ForkSnapshot,
} from './identity/fork';
export {
  reconcileSessionTree, sessionTreeAncestry, chatPaneAncestry,
  SESSION_TREE_MAX_DEPTH, CHAT_SESSION_ID,
  type SessionTreeNode, type ChatPaneRow,
} from './identity/session-tree';
export {
  forkWorkspace, type ForkTransport, type ForkDriverDeps, type ForkOutcome,
} from './identity/fork-driver';
// Workspace archive — one portable backup format for both backends.
export {
  WORKSPACE_ARCHIVE_EXTENSION, WORKSPACE_ARCHIVE_VERSION,
  archiveSqlFromDatabase, readWorkspaceArchivePage, restoreWorkspaceArchive, writeWorkspaceArchive,
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
  isPlaceholderWorkspaceTitle,
  parseWorkspaceTitle,
  planWorkspaceTitle,
  resolveWorkspaceTitle,
  slugifyName,
  workspaceSlug,
  workspaceTitleFromMission,
  type SuggestedWorkspaceIdentity,
  type WorkspaceTitlePlan,
  type WorkspaceTitleState,
} from './identity/naming';

// Evolution engine (3-timescale auto-evolution)
export {
  EvolutionEngine, feedbackToQuality, buildScaffoldProposalPrompt,
  type ProposalArchiveContext,
} from './evolution/engine';
export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig, type EvolutionEvent, type EvolutionListener,
  type CompletedTurn, type CompletedSession, type ToolCallRecord,
  type ShadowTrialDrain, type ShadowTrialTurn,
} from './evolution/types';
export {
  delegationFeatures, renderDelegationFeatures, executionPathSignals,
  type DelegationFeatures, type ExecutionPathSignals,
} from './evolution/delegation-features';
// K_align — the correction rate per 100 graded turns, per scaffold version,
// with 95% Wilson intervals. Pure telemetry: no benchmark, no judge, no LLM.
export {
  alignmentConvergence, renderAlignmentConvergence, type AlignmentConvergence, type AlignmentSegment, type AlignmentTotals,
  type AlignmentTrend, type RateInterval,
} from './evolution/alignment';
// Turn-outcome signal pipeline — the durable turn_outcomes/lessons ledgers
// every evolution surface reads (audit R3: the measurable loss).
export {
  outcomeToFeedback, outcomeQuality, isTrivialTurn,
  initTurnOutcomeTables, recordTurnOutcome, listTurnOutcomes, takePickOutcome,
  realOutcomeScaffoldRates, blendRealOutcomeRates, buildOutcomeEvalSplit,
  describeSplitDegeneracy,
  recordLesson, listLessons, corroborateLessonsForTurn,
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
// The step clock's knowledge channel — execution recoveries observed by the
// turn's own failure ledger, injected for the rest of the episode.
export {
  recordRecoveryFinding, listRecoveryFindings, recoveryFindingText,
  MAX_RECOVERY_FINDINGS, type RecoveryFinding,
} from './evolution/recovery';
// C8/C11 — the hand-labeled calibration set, and the bias-corrected view of
// every rate the classifier feeds. Uncalibrated is reported as such, never
// approximated away.
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
// The LLM panel that re-judges the hand-labeled turns, and the pre-registered
// bar it must clear before a recalibration may lean on it instead of the owner.
export {
  runEnsemble, ensembleReport, renderEnsembleReport, describeEnsembleGap,
  buildEnsembleJudgePrompt, panelVerdict, STAND_IN_THRESHOLDS,
  type EnsembleJudge, type EnsembleRun, type EnsembleRunResult, type EnsembleGap,
  type EnsembleReport, type EnsembleMember, type StandInCondition,
} from './evolution/ensemble';
// Behavioural weak labels — turns judged by what the user DID (interrupts,
// refusals, re-asks, approvals), and the harness that scores the classifier and
// the panel against them. Complements the on-distribution calibration above; it
// never replaces it.
export {
  BEHAVIOR_RULES, weakLabel, corpusStats, runCorpusEval, renderCorpusReport,
  type BehaviorRule, type CorpusTurn, type TurnSignals, type WeakLabel,
  type CorpusStats, type CorpusEvalInput, type CorpusEvalReport, type RaterScore,
  type RaterCost,
} from './evolution/behavior-labels';
// Replay-eval harness — outcome-labeled turns re-run against the current
// config; the persisted loss curve.
export {
  initReplayTables, runReplayEval, listReplayEvals, DEFAULT_REPLAY_SAMPLE_SIZE,
  type ReplayEvalSummary, type ReplayInstanceResult, type RunReplayEvalOpts,
} from './evolution/replay';
// The durable evolution window + pending outcome review — the state neither
// backend's instance outlives (one process per `kinu exec`; DO eviction).
export {
  initSessionWindowTable, createSessionWindowStore, type SessionWindowStore, type ClaimedWindow,
} from './evolution/session-window';
export {
  initTurnReviewQueueTable, queueTurnReview, takeQueuedTurnReviews, dropQueuedTurnReview,
  countQueuedTurnReviews, MAX_TURN_REVIEWS_PER_OPEN,
  type DeferredTurnReview, type RefusedTurnReview, type TakenTurnReviews,
  type TurnReviewQueueOutcome, type DeferredReviewDrain,
} from './evolution/review-queue';
// Evolution Changelog — the "what I changed about myself" digest over the
// durable ledgers, with real revert dispatch (the autonomy-flip transparency).
export {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogEntryKind, type BuildChangelogOptions,
  type ChangelogRevertAction,
  type ChangelogRevertContext, type ChangelogRevertResult,
} from './evolution/changelog';
// Canonical `buildBuiltinTools` is exported below; the older `buildAgentTools`
// surface is no longer exported.

// Configuration
export {
  DEFAULT_CONFIG, DEFAULT_MAX_STEPS, resolveMaxSteps, TURN_WALL_CLOCK_ENVELOPE_MS,
} from './config';
export type { AgentConfig, MCTSDefaults, CraftStoreDefaults, ScaffoldDefaults } from './config';

// Typed accessors over the `agent_config` key/value table — collapses ~23
// raw-SQL sites into a deep module with known-key getters/setters.
export {
  createAgentConfigStore, initAgentConfigTable,
  AGENT_CONFIG_KEYS, DEFAULT_AUTO_GEPA_EVERY_N_TURNS,
  DEFAULT_GEPA_EVAL_BUDGET, clampGepaEvalBudget,
  type AgentConfigStore, type MctsOverrides, type ShellApprovalMode,
} from './config/index';

// Types
export type * from './types/primitives';
export type * from './types/agent-runtime';
export type * from './types/backend-host';
export type * from './types/signals';
export { SIGNAL_ID_METADATA_KEY } from './types/signals';
export type * from './types/mcts';
export type * from './types/craft';
export type * from './types/evaluation';

// Views — agent-authored dashboards the host renders from JSON. Ungated, like
// crafted tools: the containment is the vocabulary, not an approval.
export {
  RESERVED_VIEW_TITLES,
  VIEW_DATA_SOURCES,
  VIEW_LIMITS,
  VIEW_SPEC_VERSION,
  ViewSpecSchema,
  createView,
  deleteView,
  initViewTables,
  listViewVersions,
  listViews,
  normalizeViewTitle,
  parseViewSpec,
  readView,
  resolveViewPath,
  revertView,
  viewSlug,
  type AgentViewSummary,
  type AgentViewVersion,
  type CreateViewResult,
  type ReadViewResult,
  type ViewBlock,
  type ViewColumn,
  type ViewDataSource,
  type ViewLeafBlock,
  type ViewSource,
  type ViewSpec,
  type ViewSpecResult,
  type ViewStatus,
  type ViewStoreDeps,
} from './views/index';

// Release lane — governed patch/deploy over a bound source — separate from scaffold evolution.
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

// Cross-workspace experience transfer (owner-scoped library + gated imports).
// The gate, the staging ledger and the settle path are driven from inside core
// (runExperienceAction and EvolutionEngine), so what crosses the package
// boundary is the library a backend hosts, the two schema initializers, the
// read surfaces, and the action dispatcher the owner's RPC drives.
export {
  createExperienceLibrary,
  findPublishable,
  runExperienceAction,
  EXPERIENCE_ACTIONS,
  type ExperienceAction,
  type ExperienceActionDeps,
  type ExperienceActionInput,
  type ExperienceLibraryClient,
  initExperienceLibraryTables,
  initImportedExperienceTable,
  listImportedExperience,
  listPublishable,
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

// Chat engine (shared between server and CLI)
export { runChat, INTERRUPTED_TURN, type ChatEvent, type ChatOptions } from './chat';

// Extension seam (public plugin API — observe + extend a turn)
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
  type StepDynamicContext,
  type StepPipeline,
} from './prompting/prepare-step';
export {
  pruneStepToolOutputs,
  STEP_CONTEXT_BUDGET_RATIO,
  STEP_RECENT_TOOL_BUDGET_TOKENS,
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

// LLM (Vercel AI SDK wrapper — shared across backends)
export {
  createVercelAILLM, collectStepText, createChatModel, createCompletionLLM, estimateTokens,
  // The chars-per-token estimate, exported so a surface that shows one imports
  // the policy instead of retyping the number beside it.
  CHARS_PER_TOKEN,
} from './llm';
export type { LLMProviderConfig, ChatModelConfig, LLMUsage } from './llm';
// The ONE normalized provider usage report, and the absence-preserving
// arithmetic over it. Every surface that counts tokens speaks this.
export {
  USAGE_FIELDS,
  UsageSchema,
  addUsage,
  normalizeUsage,
  usageReported,
  usageTotal,
} from './usage';
export type { Usage } from './usage';
export { contextWindowForModel } from './context-window';
// The per-turn bulk ledger: the cumulative clamp budget + the M1 trip counters.
export {
  TurnContextBudget,
  citesSpillAddress,
  SPILL_DIRS,
  DEFAULT_TURN_ADMIT_BUDGET_CHARS,
  TIGHTENED_RESULT_MAX_CHARS,
  type BulkProducer,
  type ContextBudgetSnapshot,
  type SpillTrip,
} from './context-budget';
// The cumulative, label-scoped spend governor — the outer integral over every
// call-scoped budget. Opt-in: no label, no cap, no storage traffic.
export {
  MissionGovernor,
  MissionBudgetExhausted,
  MISSION_LABELS_METADATA_KEY,
  readMissionLabels,
  readMissionLimits,
  localMissionPort,
  // The ONE catalog pricing of a usage report. Exported because a surface that
  // prices a call must price it exactly as the ledger debits it — two
  // implementations would make the same call cost different amounts depending
  // on who asked.
  priceCall,
  localMissionScope,
  // Every label's cumulative spend, for a read-only surface that holds no
  // governor: the CLI's `kinu spend`, the workspace cost panel.
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

// Canonical tool registry + factories (shared across CF and CLI)
export {
  BUILTIN_TOOLS,
  ACTIVE_TOOLS,
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_DESCRIPTIONS,
  BUILTIN_TOOL_SPECS,
  AGENTS_TOOL_ACTIONS,
  AGENT_STANCES,
  AGENT_STANCE_SPECS,
  DEFAULT_AGENT_STANCE,
  STANCE_CHOICES,
  TASKS_TOOL_ACTIONS,
  WEB_TOOL_ACTIONS,
  FILE_TOOL_ACTIONS,
  memoryActionsFor,
  type WebToolAction,
  type FileToolAction,
  isAgentStance,
  type AgentStance,
  type AgentStanceSpec,
  type TasksToolAction,
  DELEGATION_FRAME,
  DELEGATION_INHERITANCE,
  DELEGATION_RUNGS,
  DELEGATION_CONVERSE,
  SWARM_PRESET_DOCTRINE,
  renderToolSchemaDescription,
  renderExecuteToolsDescription,
  // The reach axis — which surfaces each capability is projected onto, and the
  // codemode namespace it owns. Read by both surface builders and by the Tools
  // panel, which used to guess it from ToolSet keys.
  TOOL_REACH,
  isBuiltinToolName,
  type ToolReach,
  type AgentsToolAction,
  type BuiltinToolName,
  type BuiltinToolSpec,
} from './tools/registry';
export { mcpToolKey, isMcpToolKey } from './tools/mcp-naming';
export {
  createAgentsTool, agentsActionsFor, renderAgentsToolDescription, resumableAgentsInput,
  type AgentsToolInput,
} from './tools/agents-tool';
// The same delegation dispatch, projected into the codemode sandbox.
export { createAgentsCodemodeProvider } from './tools/agents-codemode';
// `agent.*` — self-direction (curriculum, scaffold proposals, schedules,
// background jobs, compaction) over one host seam both backends implement.
export { createAgentSelfProvider, type AgentSelfHost } from './tools/agent-self';
// Subordinate roster, identity, admission and the orchestration policy over
// them — platform-neutral, so a backend supplies only SubordinateRuntime.
export {
  SubordinateIdentityStore,
  SubordinateRosterStore,
  admitSubordinateReport,
  admitSubordinateTask,
  createTeamToolDeps,
  describeSubordinateHandoff,
  normalizeReportContent,
  parentAdmitsSubordinateReport,
  readSubordinateLiveStatus,
  renderSubordinateInheritedContext,
  subordinateRelaysTurnEnd,
  type SubordinateIdentity,
  type SubordinateLiveStatus,
  type SubordinateReportOrigin,
  type SubordinateRuntime,
  type SubordinatesChangedEvent,
} from './subordinates/support';
// The subordinate tree's depth cap — derived per child, never stated by one.
export {
  DELEGATION_MAX_DEPTH,
  ROOT_DELEGATION_BUDGET,
  delegationBudgetAtDepth,
  delegationDepthRefusal,
  delegationExhausted,
  deriveChildDelegationBudget,
  type DelegationBudget,
  type DelegationDepthRefusal,
} from './subordinates/depth';
export {
  buildBuiltinTools,
  type BuiltinToolDeps,
  type CraftedToolSet, type CreateExecuteToolFactory,
  type ReportToolDeps,
} from './tools/builtins';
// An actor's surface is buildBuiltinTools plus `agents` — the one tool whose
// implementation is the search engine, so the factory that emits a node's own
// surface cannot hold it. See tools/actor-tools.ts.
export {
  buildActorTools, PEER_REPLY_TOPIC,
  type ActorToolsetDeps,
  type AgentsToolDeps, type AgentsForkDeps,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type SubordinateDelivery, type SubordinatePhase, type SubordinateHandoff,
  type PeersToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './tools/actor-tools';
// Web search + fetch — provider seam + key-less default + codemode provider.
export * from './web/index';
// Recursive Language Models — the llm.query codemode provider (both backends).
export { createRLMProvider, type CodemodeProvider, type RLMModelResolver, type RLMOptions } from './rlm';
// The release lane — codemode-only (release.* inside execute_tools). No
// native tool: see tools/builtins.ts's header for why.
export {
  createReleaseCodemodeProvider, runReleaseAction,
  type ReleaseToolDeps, type ReleaseActionInput,
} from './tools/release-codemode';
// memory.* / tasks.* / report.* — codemode projections of the same-named
// native tools, sharing one dispatcher each (memory-tool.ts / tasks-tool.ts /
// the native `report` tool's ReportToolDeps).
export { createMemoryCodemodeProvider } from './tools/memory-codemode';
export { createMemoryDispatcher, type MemoryToolDeps, type MemoryToolInput } from './tools/memory-tool';
export { createTasksCodemodeProvider } from './tools/tasks-codemode';
export { createTasksDispatcher, type TasksToolInput } from './tools/tasks-tool';
export { createReportCodemodeProvider } from './tools/report-codemode';
// The file plane's dispatcher, shared by the native `file` tool and
// workspace.editFile (execution/inline.ts) — see tools/file-tool.ts.
export { createFileDispatcher, type FileToolDeps, type FileToolInput } from './tools/file-tool';
// Tool-call rendering vocabulary, shared by the web chat card and the CLI
// transcript. It was a cf-backend component and the CLI therefore printed raw
// argument values; see tools/tool-call-summary.ts.
export {
  summarizeToolCall, summarizeToolRun, describeToolCall, describeCommand,
  isToolCallFailed, clip,
} from './tools/tool-call-summary';
export {
  clampToolResult,
  clampSerializedToolResult,
  withClampedToolResult,
  withClampedToolResults,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_OUTPUT_DIR,
  type ClampToolResultOptions,
} from './tools/clamp';
export { handRolledFileWrite, createFileToolSteer } from './tools/run-file-steer';
export {
  toCraftedToolSource,
  type CraftedToolExecute,
  type CraftedToolExecuteFn,
  type CraftedToolSource,
} from './tools/crafted-executor';
export {
  buildSystemPromptSync,
  currentDateForPrompt,
  FALLBACK_PURPOSE,
  type SystemPromptOptions,
} from './prompt';
// The boundaries of an assembled request — shared by the renderers that write
// them and the meter that measures against them.
export {
  splitPromptSections,
  DYNAMIC_CONTEXT_OPEN_TAG,
  SOUL_SECTION_TITLE,
  type PromptSection,
} from './prompting/sections';
// What one request was locally measured to be made of — an estimate, carried
// next to the provider's authoritative totals rather than reconciled into them.
export {
  TurnContextMeter,
  measureContext,
  type ContextComposition,
  type ContextPlane,
  type ContextSegment,
  type ToolDefsLike,
} from './context-meter';
export {
  compilePromptSurface,
  executorIsSelectable,
  isWorkMode,
  turnProvenanceForMetadata,
  workModeForTurnMetadata,
  uniqueBuiltinTools,
  uniqueExternalTools,
  uniquePromptExecutors,
  type PromptBackend,
  type PromptExecutorInfo,
  type PromptExternalToolInfo,
  type TurnProvenance,
  type WorkMode,
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
  AGENTS_MD_MAX_CHARS,
  type AgentsMdFile,
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
  fnv1a64,
  searchDelegates,
  observeSystemPromptHash,
  fnv1a64Bytes,
  renderDynamicContextBlock,
  renderTurnLocalContext,
  turnLocalContextMessage,
  DYNAMIC_CONTEXT_HEADER,
  TURN_CONTEXT_HEADER,
  type DynamicApproval,
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
  isCacheRetention,
  ANTHROPIC_MAX_BREAKPOINTS,
  CACHE_RETENTIONS,
  DEFAULT_CACHE_RETENTION,
  type CacheBreakpointInput,
  type CacheBreakpointPlan,
  type CacheRetention,
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
export { EVIDENCE_BUDGETS, evidenceWindow } from './prompts/evidence-window';

// Runtime builder (shared across backends)
export { buildRuntime } from './runtime-builder';
export type { RuntimeComponents } from './runtime-builder';
export { createAgentStores } from './state/agent-stores';
export type { AgentStores } from './state/agent-stores';
export { collectDynamicContext } from './state/dynamic-context';
export type { DynamicContextInput } from './state/dynamic-context';

// MCTS engine
export { runMCTS } from './mcts/engine';
export { selectNode } from './mcts/uct';
export { backpropagate } from './mcts/backpropagation';
export { recordNode } from './mcts/record-node';
export type { SessionWriter, SessionMessage, SessionMessagePart } from './mcts/record-node';
export { converge } from './mcts/convergence';
export { pruneLowValueBranches } from './mcts/pruning';
// Sibling diversity at expansion — backends render this into the explore prompt.
export { diversityDirective, diversityAngle, siblingAngles } from './mcts/diversity';
// The one question a branch is asked, whatever substrate runs it.
export {
  explorePrompt, reflectionPrompt,
  type ExplorePrompt, type ExplorePromptInput, type ExploreToolHint,
} from './mcts/explore-prompt';
export {
  canonicalLanguage, fencedBlocks, readProposalCode,
  type FencedBlock, type ProposalCode,
} from './execution/code-fence';
// Whole-message branch context inheritance (shared by every explore() backend).
export {
  formatInheritedContext, DEFAULT_INHERITED_MESSAGES,
  type InheritedMessage,
} from './mcts/inherited-context';
// Test-based convergence tie-break over near-tied candidates.
export { selectWinnerByTest, type TestSelectionDeps } from './mcts/test-selection';
export {
  evaluateWithMultiModelJudging, median,
  type EvaluateBranchOptions, type BranchEvaluation,
} from './mcts/evaluation';
export type { EvaluationGrounding } from './types/evaluation';
export { estimateCost } from './mcts/cost';
// Alternate Takes — near-tied convergence candidates + the pick→ledger signal.
export {
  initAlternateTakesTable, captureAlternateTakes, claimAlternateTakesForTurn,
  purgeUnclaimedAlternateTakes,
  listAlternateTakeSets, latestAlternateTakeSet, recordTakePick,
  recordBranchTakeSet, recordHeadsTakeSet, buildTakeContinuationPrompt, takeEvidence,
  type AlternateTakeCandidate, type AlternateTakeSet, type AlternateTakeSource,
  type HeadTakeCandidate, type TakePickRecord, type TakePickOutcome,
} from './mcts/takes';
// Steer-as-Branch — a mid-turn redirect run as a parallel head that settles
// into the Alternate Takes pipeline against the live turn's answer.
export {
  BRANCH_HEAD_BUDGET, BRANCH_RATIONALE, STEER_BRANCH_RUN_ID_PREFIX,
  newBranchId, isSteerBranchRunId, branchHeadId,
  startBranchHead, settleBranchIntoTakes, settlePendingBranch, settlePendingBranches,
  type BranchStatusEvent, type BranchStartInput, type SteerBranchHandle,
  type BranchSettleOutcome, type PendingBranch,
} from './steer-branch';
// The user steer-drain — a message typed while a turn runs, spliced into its
// next step. Not a signal: it persists verbatim, comes back on interrupt, and
// reruns as a user-origin turn (see user-steer.ts).
export {
  UserSteerDrain, steerUserMessage,
  type UserSteer, type UserSteerOutcome, type SteerStatusEvent,
} from './orchestrator/user-steer';

// Schemas
export { initSearchTables } from './mcts/schemas';
export {
  MctsSearchStore,
  initMctsSearchTable,
  persistableMCTSConfig,
  type PersistedMCTSConfig,
  type ResumableSearch,
  type MctsSearchRunSummary,
} from './mcts/search-store';
export { initScaffoldTables } from './scaffold/schemas';
export { initCraftScoreTables } from './craft/schemas';

// Scaffold management
export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap';
export { modifyScaffold, type ModifyResult, type ModifyScaffoldOpts } from './scaffold/modify';
export { rollbackScaffold } from './scaffold/rollback';
// Misevolution gate — fixed safety criteria over every evolution surface
// (scaffold acceptance + promotion, extracted tools, agent-authored tools,
// imported experience).
export {
  checkMisevolution, checkMisevolutionForSurface, recordMisevolutionVeto,
  type MisevolutionSurface, type MisevolutionVerdict, type MisevolutionViolation,
} from './scaffold/misevolution';
// Variant archive — DGM-style lineage + branch-base selection over the
// existing scaffold_versions/scaffold_evaluations rows (no parallel store).
export {
  listScaffoldArchive, listRejectedProposals, selectEvolutionBase,
  type ScaffoldArchiveEntry, type EvolutionBaseSelection,
  type RejectedProposal, type RejectionKind,
} from './scaffold/archive';
// scaffold execution + shadow-mode rollout
export {
  runScaffold,
  scaffoldEventText,
  SCAFFOLD_TURN_TIMEOUT_MS,
  type ScaffoldRunOptions,
  type ScaffoldRunResult,
  type ScaffoldDefaultInferenceChunk,
  type ScaffoldEvent,
  type ScaffoldEmitFn,
} from './scaffold/executor';
export { pumpScaffoldEvents } from './scaffold/event-pump';
export { scaffoldEventsToUIStream } from './scaffold/ui-stream';
// The two backend inference seams: the DO's UI message stream and a local
// turn's ChatEvent stream. Same decision, same delegation contract.
export { scaffoldInferenceTransform, type InferenceStreamResult } from './scaffold/inference-transform';
export { scaffoldChatTransform } from './scaffold/chat-transform';
export {
  initShadowTables,
  getPendingScaffold,
  getCurrentScaffoldVersion,
  readScaffoldVersion,
  readShadowVerdict,
  recordShadowEvaluation,
  decidePromotion,
  applyPromotionDecision,
  DEFAULT_SHADOW_CONFIG,
  // The trial queue — what a turn contributes to the promotion gate before
  // anything expensive runs, kept out of scaffold_evaluations so unrun trials
  // can never walk the calibrated ladder.
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
  type JudgeFn,
  type ShadowTrialVerdict,
} from './scaffold/shadow';
// auto-judge shadow evaluation — ONE queued trial, executed: runs the pending
// scaffold against the recorded task, asks a judge LLM to compare, records the
// result, optionally auto-applies promotion/rollback once the gate is
// conclusive.
export {
  runAutoShadowEval,
  createStructuredJudge,
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
export { maybeStoreCraftedTool } from './craft/discovery';
export { periodicCraftConsolidation } from './craft/consolidation';
export { checkConflictsBeforeAdding, upsertCraftedTool } from './craft/conflict';

// Execution layer
export {
  DefaultExecutionRouter,
  createInlineExecutor,
  withApprovalGatedShell, gateProviderExec,
  createSandboxExecutor, type SandboxHandle, isSandboxTransientError,
  createWorkspaceSnapshots, type WorkspaceSnapshots, type WorkspaceSnapshotPorts,
  type WorkspaceSnapshotState, type WorkspaceRestoreOutcome, type WorkspaceSnapshotOutcome,
  type WorkspaceRestoreOutcomeKind, type WorkspaceSnapshotOutcomeKind,
  WORKSPACE_RESTORE_OUTCOMES, WORKSPACE_SNAPSHOT_OUTCOMES,
  type BackupOptions, type DirectoryBackup, type WorkspaceChangeStatus,
  shouldBackupWorkspace, workspaceBackupOptions, workspaceRestoreMode,
  BACKUP_MIN_INTERVAL_MS, BACKUP_TTL_SECONDS, WORKSPACE_BACKUP_DIR,
  WORKSPACE_RESTORE_DEADLINE_MS, isDirectoryOverlayMounted,
  snapshotIntegrityFailure, snapshotObjectKeys, withContainerStartDeadline,
  type SnapshotObjectKeys, type LateStartFailure,
  createDeviceTunnelExecutor, type DeviceTransport,
  explainNativeToolReferenceError,
  devicePresence, parseDevicePresence, deviceChangeNotice, observeDevicePresence,
  deviceToolchainAnswer, freshDeviceToolchain,
  DEVICE_PRESENCE_CONFIG_KEY, DEVICE_TOOLCHAIN_TTL_MS,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
  type DeviceToolchain,
  TOOLCHAIN_PROBE_BINARIES, TOOLCHAIN_PROBED_CAPABILITIES,
  TOOLCHAIN_UNPROBEABLE, toolchainCapabilities,
  DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  DEVICE_UNKNOWN_METHOD, isDeviceUnknownMethodError,
  createNimbusExecutor, createNimbusWorkspaceExecutor, nimbusSessionShell,
  type NimbusExecutorOpts, type NimbusWorkspaceExecutorOpts, type NimbusSandboxHandle,
  type NimbusStartResult,
  EXECUTOR_CAPABILITIES,
  type ExecutorCapability, type ExecutorKind, type ExecutorProvider,
  type ExecutorLifecycleStatus, type ExecutorStatus,
  type ExecutorInfo, type ExecutionRouter, type InlineExecutorDeps, type ResourceLimits,
  formatExecResult, isFailingResultText, type ExecOutcome, STDOUT_LABEL, STDERR_LABEL, NO_OUTPUT,
  TurnEscalationLedger, ESCALATION_OUTCOMES,
  type EscalationDecision, type EscalationOutcome, type EscalationSnapshot,
  createParentExecutor, createParentWorkspaceVfs, sandboxFiles, nimbusSessionFiles, deviceFiles,
  type ParentWorkspaceHandle, type ParentExecResult, type DeviceFileConsent,
  type ParentRpcResult, type ParentRpcWrite, type ParentRpcError,
} from './execution/index';

// Client-safe workspace addressing and VFS contracts. The embedded Nimbus
// workspace host is exported separately from `@kinu.run/core/workspace` so a
// browser import of the main barrel cannot pull the server runtime into its
// bundle.
export {
  workspacePath, WORKSPACE_ROOT,
} from './vfs/workspace-path';
export {
  agentHome, agentTmpRoot, agentCred, agentIdentity,
  provisionAgentHome, confineAgentTmp,
  MAIN_AGENT, AGENT_HOME_MODE, AGENT_TMP_MODE, SESSION_UID, AGENT_UID_FLOOR,
  type AgentIdentity, type HomeRootVfs, type TmpConfiner,
} from './vfs/agent-home';
export type {
  WorkspaceBundle, WorkspaceOptions, WorkspaceVFS,
} from './vfs/nimbus-workspace';
export {
  makeVfsError, isVfsError, ERRNO, withVfsErrorHint, vfsAddressingHint,
  type VfsError, type VfsErrorCode,
} from './vfs/errno';
export { observeWrites, type WriteEvent, type WriteObserver } from './vfs/observe';

// File checkpoints — the shadow-git snapshot seam (backends implement it)
export {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_UNAVAILABLE_NO_GIT, summarizeRestorePlan,
  type FileCheckpoints, type CheckpointTurnMeta, type CheckpointAvailability,
  type FileCheckpointEntry, type FileCheckpointListing, type FileRestoreChange, type FileRestoreKind,
  type FileRestorePlan, type FileRestoreResult, type DeviceCheckpointHint,
} from './checkpoints/types';
// Shadow-git store format — the cross-engine contract (cli-backend imports
// it; the zero-dep pc-agent daemon pins it, enforced by the parity test).
export {
  CHECKPOINT_REF_PREFIX, CHECKPOINT_WORKDIR_MARKER, CHECKPOINT_EXCLUDES,
  checkpointSubject, parseCheckpointSubject, checkpointRefTimestampMs,
  checkpointReason, diagnoseStaging, type StagingDiagnosis,
} from './checkpoints/format';

// Vectorize-backed semantic memory (Workers AI embeddings + hybrid retrieval)
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
  type VectorMemoryChunk,
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

// Memory write primitive — single canonical "save a note to MEMORY.md".
// Used by workspace.saveNote, the `memory` builtin tool, and MCP saveNoteFromMcp.
// readMemoryTail is the shared bounded-tail read both backends weave per turn.
export { memoryBytes } from './memory/note';
export { appendMemoryNote, readMemoryTail, MEMORY_TAIL_MAX_CHARS } from './memory/note';

// Zero-LLM transcript search over the canonical `messages` table (FTS5).
// Backs the `memory` tool's `sessions` action on both backends.
export {
  SessionSearchStore,
  type SessionSearchHit, type SessionScrollMessage,
  type SessionScrollResult, type SessionSummary,
} from './memory/session-search';

// agent_facts — typed, idempotent, keyed world-model store. Built on DO SQL.
// Top-K recent facts are auto-rendered into the system prompt every turn.
export {
  initFactsTable, createFactsStore, renderFactsBlock,
  type Fact, type FactsStore, type FactUpsertResult,
} from './memory/facts';
export {
  JsonValueSchema, JsonObjectSchema, JsonArraySchema,
  parseJsonValue, parseJsonObject, parseJsonArray, decodeJsonValue, projectJsonValue,
  type JsonPrimitive, type JsonObject, type JsonValue,
} from './utils/json';

// Sleep-time compute — between-turn background memory compression
// (Letta-style; ~50% test-time token reduction reported).
export {
  runSleepTimeCompute, applySleepTimeUpdate,
  type SleepTimeInput, type SleepTimeUpdate,
} from './memory/sleep-time-compute';

// durable run-event log (Flue-style, SSE-resumable) — its own `run_events`
// table. The EventsHub's `agent_log` is a separate ledger (ingress events,
// phases, reactor decisions); the two coexist rather than one fronting the
// other, and the per-step telemetry sample reads this one.
export type {
  RunEvent, RunEventBase, RunEventInput, RunEventType, StepCost,
  CompletionGateRecord, TurnSteeringRecord, TurnSteeringTrigger, CraftCycleRecord,
  ExecutionRecoveryRecord,
  CacheHitStats, StepTelemetry,
} from './events/index';
export {
  FAILURE_WITHOUT_ERROR,
  initRunEventTables,
  parseStoredRunEvent,
  RunEventRecorder,
  cacheHitRate,
  summarizeSteps,
  CACHE_HIT_EMA_ALPHA,
  SPEND_SOURCES,
  SPEND_SOURCE_LABEL,
  SPEND_SOURCE_DETAIL,
  WORKSPACE_RUN_ID,
  type ModelCallReport,
  type ModelCallSpend,
  type ModelCallSink,
  type SpendSource,
  type RunEventListener,
  type RunEventQuery,
} from './events/index';

// EventsHub — events / triggers / turn runner / reply channels.
// Builds the agent_log ledger plus the trust, channel, trigger and budget
// primitives around it. Spec: docs/ARCHITECTURE.md — "Events and ingress".
export * from './events/hub/index';

// Ingress — the gated paths external signals take into that ledger: webhook
// auth + rate limiting, timer registration and firing, the inbound-email
// trust gate, the peer outbox, subordinate reports.
export * from './events/ingress/index';

// ExplorationStrategy — single seam for "search candidate continuations,
// score, pick best." MCTS / Heads / ToT / Reflexion / single-shot fit this.
export * from './strategy/index';

// Eval harness — A/B test arbitrary strategies/loops on a corpus of tasks.
export * from './eval/index';

// Bench harness — machine-scored, sealed-split, paired-statistics measurement
// of whether a variant (scaffold, memory, evolved state) actually helps. Pure
// math + report shapes; the executing runner lives in scripts/bench.ts.
export * from './bench/index';

// Voyager-style automatic curriculum + Absolute Zero learnability filter.
// Proposes next tasks at the "barely succeeds" sweet spot.
export * from './curriculum/index';

// provider abstraction — single registry for resolving model specs across
// Workers AI, AI Gateway, Codex (ChatGPT subscription), OpenAI, OpenRouter,
// and generic OpenAI-compatible upstreams. Auth resolution flows through
// the AuthResolver callback in ProviderDeps — secrets stay inside UserDO
// (cf-backend) and never enter the provider layer.
export * from './providers/index';
// Credential value shape (still exported for UserDO + tests; the previous
// CredentialStore interface is gone).
export type { Credential, BearerCredential, OAuthCredential, OpenAICompatCredential } from './credentials/store';

// Durable plan review — shared domain and the submit_plan edit contract.
export {
  MAX_PLAN_ANNOTATIONS_BYTES,
  MAX_PLAN_CONTENT_BYTES,
  PlanReviewStore,
  admitPlanReviewAnnotations,
  applyPlanEdits,
  formatPlanWithLineNumbers,
  initPlanReviewTable,
  planReviewAwaitingDecision,
  validatePlanEdits,
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

// Wire constants shared by the cf-backend Worker and the CLI.
export {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  DEVICE_CONNECT_PATH,
  ORCHESTRATOR_AGENT_SLUG,
  SUBORDINATE_AGENT_SLUG,
} from './cloud-wire';

// The one record of what the Cloudflare platform does, and how we know. Every
// platform number in this repo is derived from an entry here; prose cites an
// entry by its stable id and never restates the number.
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

// safety — approval gating for shell exec + digest-bound approvals
export {
  reviewCommand,
  formatApproval,
  gatedGrants,
  formatApprovalGrant,
  parseApprovalGrant,
  approvalGrants,
  gateExec,
  decideApproval,
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
  EGRESS_PLACEHOLDER_PREFIX,
  EGRESS_PLACEHOLDER_BYTES,
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
  type DeferredApproval,
  type DeferredApprovalStatus,
  type DeferredApprovalAnswer,
  type DeferredApprovalVerdict,
  type DeferredApprovalNotice,
  type DeferredApprovalQueueDeps,
  argumentDigest,
  sha256Hex,
  stableStringify,
  DeviceConsentRegistry,
  DEVICE_CONSENT_SCOPE,
  DEVICE_CONSENT_SCOPE_FULL_FS,
  DEVICE_CONSENT_DENIED,
  DEVICE_CONSENT_UNANSWERED,
  DEVICE_CONSENT_TIMEOUT_MS,
  parseConsentScope,
  mergeConsentScope,
  summarizeDeviceAction,
  type DeviceConsentScope,
  type DeviceConsentDecision,
  type DeviceConsentAnswer,
  type DeviceActionSummary,
  type DeviceConsentRequest,
  type PendingDeviceConsent,
  type DeviceConsentNotice,
} from './safety/index';

// Utils
export { nanoid } from './utils/nanoid';
export { hmacSha256Hex, timingSafeEqual } from './utils/crypto';
// Confidence intervals — every score this system reports travels with one.
export {
  wilsonInterval, scoreInterval, lossInterval, formatScoreInterval, seededRandom,
  type ScoreInterval,
} from './utils/stats';
export { isoDate, today, nowMs } from './utils/date';

// ── branching heads (parallel reasoning streams with merge) ──
// A head is a divergent reasoning thread that sees the WHOLE conversation
// context, accumulates EPHEMERAL interim context, and merges back via LLM
// synthesis. Distinct from sub-agents (isolated context, structured return)
// and MCTS branches (single short LLM call for evaluation).
export type {
  HeadId, HeadBudget, HeadInput, HeadReport,
  HeadStep, HeadStepToolCall, HeadRunView, HeadRunHeadView,
  Evidence, Decision, ArtifactRef,
  SplitRequest, MergeResult, HeadScore, MergeStrategy,
  HeadFileChange, HeadFileChangeSet,
  SerializedMessage,
} from './heads/index';
export {
  DEFAULT_HEAD_BUDGET, DEFAULT_MERGE_STRATEGY,
  deriveChildBudget, budgetExhausted,
  initHeadsTables,
  HeadJournal, type HeadJournalRow, type LiveHeadRun, type AbandonedHeadRun,
  LiveHeadJournal, type AnnounceHeadActivity,
  reconcileInterruptedForks, forkInterruptedWake,
  FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
  HeadController, type HeadRuntime, type HeadGrounding, type SpawnedHead, type MergeLLMFn,
  type SplitPhaseEvent,
  type HeadJournalPort,
  MergeOutputSchema, DecisionSchema, type MergeOutput,
  extractHeadSteps, extractFinalText, synthesizeHeadSummary, headProducedFindings,
  HeadCapture, runHeadInference, buildHeadAccumulatorTools,
  buildHeadSystemPrompt, buildHeadMessages, withHeadCaptureRecording,
  type HeadInferenceDeps, type HeadWorkspaceLayout,
  buildHeadToolSet, HEAD_BUILTIN_TOOLS,
  type HeadToolDeps, type HeadSplitRequest, type HeadSplitResult,
  HeadFileChanges, formatHeadFileChanges, HEAD_FILE_CHANGE_PROVENANCE,
} from './heads/index';

// Background-job system — auto-background long tool calls + wake-on-completion.
export {
  BackgroundJobStore, initBackgroundJobsTable, serializeJobResult, withBackgroundThreshold, withSpawnDetach,
  isBackgroundHandle, SPAWN_STARTED_OPTION, readSpawnStarted,
  BackgroundJobRunner, JobNotResumable, EVICTION_INTERRUPT_ERROR, BACKGROUND_POLICY, MAX_CONCURRENT_DETACHED_JOBS,
  backgroundJobWakeTrigger,
  type BackgroundJob, type BackgroundJobStatus, type BackgroundHandle, type BackgroundRefusal, type ThresholdDeps,
  type BackgroundPolicy, type DetachOutcome, type SessionSurface,
  type BackgroundJobRunnerDeps, type JobResumer, type JobClaim,
} from './jobs/index';

// The agent's own task list — what the `tasks` tool writes and the Tasks
// surface reads.
export {
  TaskListStore, initTaskListTable, TASK_STATUSES, MAX_TASK_TITLE_CHARS,
  type AgentTask, type AgentTaskTree, type TaskStatus,
  type TaskAddResult, type TaskAddRejection,
} from './tasks/store';

// Backend-agnostic orchestration — per-turn accounting shared by both backends.
export {
  TurnAccumulator,
  type StepLike, type ToolResultLike, type TurnSinks,
} from './orchestrator/turn-accumulator';
export {
  AgentOrchestrator, type AgentOrchestratorDeps,
  type TurnContinuity, DEFAULT_SETTLE_TIMEOUT_MS, DEFAULT_SESSION_REFLECTION_INTERVAL,
} from './orchestrator/agent-orchestrator';
export { SignalDelivery } from './orchestrator/signals';
export {
  TurnSteering, isFailingToolResult, TURN_STEERING_HEADER,
  IDENTICAL_CALLS_BEFORE_STEER, CONSECUTIVE_FAILURES_BEFORE_STEER, LONG_TURN_STEPS_BEFORE_STEER,
  STEPS_WITHOUT_PROGRESS_BEFORE_STEER,
  type TurnProgressInputs,
} from './orchestrator/turn-steering';
export { CraftCycle } from './orchestrator/craft-cycle';
export {
  CompletionGate, observeCompletionState, completionGateText,
  COMPLETION_GATE_EVENT, COMPLETION_GATE_HEADER, COMPLETION_PROBE_COMMANDS,
  COMPLETION_OBSERVATION_MAX_CHARS, COMPLETION_TASK_ECHO_MAX_CHARS,
  type TurnCompletionFacts,
} from './orchestrator/completion-gate';
export {
  assembleTurnMessages, measureCompactionTrigger,
  type TurnContextInput, type CompactionTriggerReader, type MeasuredCompactionTrigger,
} from './orchestrator/turn-context';
export {
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery, creditedTurnId,
  type CompactionTriggerState, type SettledTurn,
} from './orchestrator/turn-lifecycle';
export {
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  SCAFFOLD_HISTORY_DEFAULT_LIMIT, SCAFFOLD_HISTORY_MAX_LIMIT,
  SCAFFOLD_HISTORY_DEFAULT_MESSAGE_CHARS, SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS,
  SCAFFOLD_HISTORY_MAX_PAGE_CHARS,
  type ScaffoldBridgeOpts, type ScaffoldHistoryQuery, type ScaffoldHistoryReader,
  type ScaffoldHistoryEntry, type ScaffoldHistoryPage,
} from './orchestrator/scaffold-host';
export { BACKGROUNDABLE_TOOLS, resumeBackgroundJob } from './orchestrator/background-tools';
export {
  wrapToolsForBackground, CONFINED_BACKGROUNDABLE_TOOLS, type BackgroundableTool,
} from './jobs/background-wrap';
export { buildStrategyForkDeps, type ForkDepsWiring } from './orchestrator/fork-deps';
export { createDurableMctsSession } from './orchestrator/mcts-session';
export {
  skillsVfsOver, resolveTurnSkills, filterToolNamesBySkills, filterToolSetBySkills,
  renderFactsForTurn, type TurnSkillsConfig, type TurnSkillSurface,
} from './orchestrator/turn-surface';
export { ModelCatalogSession } from './orchestrator/model-catalog';
export {
  serializeContentForHeads, narrowInheritedRole, headPhaseRunEvent,
  inheritedContextFromHistory, inheritedContextFromRows,
  INHERITED_CONTEXT_CAP, inheritedContextOmissionNote,
} from './orchestrator/heads-support';
export { recordGroundedHeadsTake } from './mcts/takes';

// ── skills (Claude-Code / Hermes-compatible SKILL.md workflow store) ──
// VFS-backed under /workspace/skills/. A skill is natural-language workflow
// instructions + a tool-surface restriction (allowed_tools). Distinct from
// CraftedTools (executable JS): a skill steers the LLM; a crafted tool runs.
// No LLM-facing tool and no codemode namespace — read/create/edit/delete are
// ordinary workspace.readFile/writeFile/readdir/exec calls over the same VFS.
export {
  parseSkillFile, stringifySkillFile, validateSkillName,
  discoverSkills, skillPath, BUILTIN_SKILLS,
  resolveActiveSkills, extractExplicitInvocations,
  renderActiveSkillsSection, renderSkillsIndexSection, unionAllowedTools, toolAllowedBySkills,
  ACTIVE_SKILLS_MAX_CHARS, SKILLS_INDEX_MAX_CHARS,
  SkillError, SKILLS_DIR,
} from './skills/index';
export type {
  ParsedSkill, SkillSource, ActiveSkillSet,
  ActivationReason, SkillParseResult, SkillErrorCode,
  SkillsVfs, DiscoverOpts, LoadActiveSkillsOpts,
} from './skills/index';

// ── GEPA (Genetic-Pareto Prompt Evolution) ──
// Offline batch optimisation of any string-addressable agent artifact —
// scaffold sources, crafted tool implementations, system-prompt sections.
// Complementary to the runtime mutable-scaffold loop. Paper: Agrawal et
// al., ICLR 2026 (arxiv 2507.19457).
// Only the entry points + persistence + types are public; the algorithm
// internals (pareto, mutate, merge helpers) stay inside evolution/gepa.
// The scaffold evolution CONTROL PLANE — the drivers over those primitives.
// They used to be Durable Object methods, which is why GEPA could not be run
// from the CLI at all; both backends now call these.
export {
  applyScaffoldDecision, createJsonJudge, createLlmJsonJudge, getShadowStatus, listScaffoldVersions,
  previewScaffoldLive, proposeScaffold, queueTurnShadowTrial, runQueuedShadowTrials,
  runScaffoldCaptureText, runScaffoldGepaOptimization, runScaffoldOnce,
  type GepaOptimizationResult, type JsonGenerator, type ScaffoldControl,
  type ScaffoldDecisionResult, type ScaffoldReplayContext, type ScaffoldSurface,
  type ScaffoldVersionView, type ShadowStatus, type ShadowTrialQueueOutcome,
} from './evolution/control';
export {
  runGepa, runScaffoldGepa,
  DEFAULT_GEPA_BUDGET,
  // SQL persistence — needed by the orchestrator to create tables + run.
  initGepaTables, startGepaRun, finishGepaRun,
  listGepaRuns, loadGepaCandidates, makePersistingHook,
} from './evolution/gepa/index';
export type {
  EvalInstance, MetricOutcome, GepaMetric, ReflectionLM,
  GepaCandidate, GepaConstraints, GepaBudget, GepaConfig,
  GepaIterationState, GepaResult,
  RunScaffoldGepaOpts, RunScaffoldGepaResult,
  GepaRunSummary,
} from './evolution/gepa/index';

// ── Layer gate ──
// Deterministic, no-LLM per-layer regression scoring over the turn pipeline.
// The tier between the structural scaffold gates and the LLM judge: it gives a
// self-change a per-layer effect size instead of one aggregate that a single
// user's traffic can never resolve. Uncovered layers report null, never 100%.
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

// Backend conformance gate — the manifest of which composition root wires
// which capability (or why deliberately not), plus the comparator the
// per-backend harnesses run their observed surfaces through. Kills the
// "X never worked on Y backend" class: a forgotten wire can no longer look
// like a design decision.
export {
  BACKEND_CONFORMANCE, CONFORMANCE_PLANES, CONFORMANCE_ROOTS, PLANE_UNIVERSE, WIRED,
  compareSurface, normalizeObservedTables, observedActionEnum, phantomCallables,
  renderConformanceFindings,
} from './conformance/index';
export type {
  CapabilityStatus, ConformanceFinding, ConformanceFindingKind, ConformanceManifest,
  ConformancePlane, ConformanceReport, ConformanceRoot, ObservedSurface, RootStatuses,
} from './conformance/index';

// ── Read models ──
// The folds an operator surface asks for: what the workspace is, what a run
// did, what changed on disk, what work is detached, what the knobs are set to.
// Every one reads storage the agent already owns, so none of them is
// backend-shaped — a backend supplies its transport and nothing else.
export {
  classifyEvolutionType, getRunTimeline, runEventToSpan, safeJsonParse, toolKindFor,
} from './read-models/timeline';
export type { RunTimelineDeps, TimelineKind, TimelineSpan } from './read-models/timeline';
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
  computeWorkspaceDiff, diffLines, fileDiff, parseGitDiff, MAX_LINES_PER_FILE,
} from './vfs/diff';
export type { DiffLine, FileDiff, FileStatus, LineDiff } from './vfs/diff';
export {
  getExecutorFiles, readExecutorFile, sortDirEntries, executorFiles, writeExecutorFileOp,
  listEnvironments, normalizeDir, joinDir, parentDir,
} from './read-models/files';
export type {
  DirEntry, ExecutorFileLookup, ExecutorRowLookup, ExecutorWriteResult,
  EnvironmentInfo, MountInfo,
} from './read-models/files';
export {
  readLatestSearchTree, readSearchTree, readSearchNodeDetail,
  type SearchNodeDetail,
} from './read-models/search-tree';
export { readExplorationCanvas, readExplorationRun } from './read-models/exploration-canvas';
export type { ExplorationCanvasRun } from './read-models/exploration-canvas';
export type { ForkRunParams, SearchRunParams } from './read-models/fork-params';
export { listForkRuns } from './read-models/fork-runs';
export type { ForkRunSummary } from './read-models/fork-runs';
export {
  listRecordCells, listRecordObjectives, readRecordCell,
} from './read-models/exploration-records';
export type {
  RecordCellSummary, RecordObjectiveSummary,
} from './read-models/exploration-records';
// The store's own digest handles, on the surface because they are what an RPC's
// request carries: a surface holds the opaque pair and passes it back, and deriving
// the type from a read's signature is how a type stops having a name.
//
// The WRITER is here for one reason: a leaderboard RPC can only be proven over a
// workspace whose rows the real writer wrote, and `cf-backend`'s suite is in another
// package. Seeding with a hand-written INSERT would test the reads against rows nothing
// in production produces — including the identity columns, whose whole value is that the
// writer fills them from the identity it hashed.
export { initExplorationRecordsTable, recordExploration } from './strategy/records';
export type {
  ExplorationWrite, RecordCellHandle, RecordObjectiveHandle,
} from './strategy/records';
export { readNodeTranscript } from './read-models/node-transcript';
export type {
  NodeTranscriptView, NodeTranscriptCrumb, NodeTranscriptOrigin,
} from './read-models/node-transcript';
export { buildPendingActions } from './read-models/pending-actions';
export { getAgentStatus, getChatHistoryPage, getToolList } from './read-models/status';
export { mapPage, pageSchema, seekPage, SeekCursorSchema, StaleCursorError } from './read-models/page';
export type { Page, PageRequest, SeekCursor } from './read-models/page';
export {
  mergeTranscript, uiMessageRow, uiMessageText, transcriptRole,
  PROGRAMMATIC_MESSAGE_ID_PREFIX, TURN_AUTHOR_METADATA_KEY, stampTurnAuthor, turnAuthor,
} from './utils/ui-message';
export type { TurnAuthor, StoredRowProjection } from './utils/ui-message';
export type { PendingAction, PendingActionKind, PendingActionInputs } from './read-models/pending-actions';
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
  getShellApprovalMode, getStoredModelSpec, setAlwaysActiveSkills, setEvolutionConfig,
  setMctsConfig, setModel, setReasoningEffort, setShellApprovalMode,
  getShellApprovalGrants, revokeShellApprovalGrants,
} from './read-models/config-plane';
export type {
  EvolutionConfigView, MctsConfigView, SetModelDeps,
} from './read-models/config-plane';
export {
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
} from './read-models/evolution-views';
export type { EvolutionChangelogView, TakePickDeps } from './read-models/evolution-views';
