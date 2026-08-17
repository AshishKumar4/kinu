// @proteus/core — barrel export

// Identity system
export { initActorTables, initAllTables, migrateWorkspaceStorage, tableExists } from './identity/schema.js';
export { reconcileColumns } from './identity/columns.js';
export { readActivityLog, type ActivityLogEntry } from './identity/activity-log.js';
// The one answer to "which tables a workspace has" — every composition root
// calls this and nothing else (guarded by tests/contract-workspace-schema.test.ts).
export { initWorkspaceSchema, type WorkspaceSchemaSql } from './identity/workspace-schema.js';
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
} from './identity/soul.js';
export { WORKSPACE_IDENTITY_DDL } from './identity/schema.js';
export {
  forkWorkspaceStorage, snapshotWorkspaceForFork, writeForkSnapshot, readForkLineage,
  type ForkOpts, type ForkResult, type ForkLineageRow, type ForkSnapshot,
} from './identity/fork.js';
export {
  reconcileSessionTree, sessionTreeAncestry, chatPaneAncestry,
  SESSION_TREE_MAX_DEPTH, CHAT_SESSION_ID,
  type SessionTreeNode, type ChatPaneRow,
} from './identity/session-tree.js';
export {
  forkWorkspace, type ForkTransport, type ForkDriverDeps, type ForkOutcome,
} from './identity/fork-driver.js';
// Workspace archive — one portable backup format for both backends.
export {
  WORKSPACE_ARCHIVE_EXTENSION, WORKSPACE_ARCHIVE_VERSION,
  archiveSqlFromDatabase, readWorkspaceArchivePage, restoreWorkspaceArchive, writeWorkspaceArchive,
  type ArchiveCursor, type ArchiveSqlCursor, type ArchiveFilesCursor,
  type ArchiveExportOptions, type ArchivePage,
  type ArchiveFileEntry, type ArchiveFileSource, type ArchiveFileTarget,
  type ArchiveRestoreOptions, type ArchiveRestoreResult,
} from './identity/archive.js';
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
} from './identity/naming.js';

// Evolution engine (3-timescale auto-evolution)
export {
  EvolutionEngine, feedbackToQuality, buildScaffoldProposalPrompt,
  type ProposalArchiveContext,
} from './evolution/engine.js';
export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig, type EvolutionEvent, type EvolutionListener,
  type CompletedTurn, type CompletedSession, type ToolCallRecord,
  type ShadowTrialDrain, type ShadowTrialTurn,
} from './evolution/types.js';
export {
  delegationFeatures, renderDelegationFeatures, executionPathSignals,
  type DelegationFeatures, type ExecutionPathSignals,
} from './evolution/delegation-features.js';
// K_align — the correction rate per 100 graded turns, per scaffold version,
// with 95% Wilson intervals. Pure telemetry: no benchmark, no judge, no LLM.
export {
  alignmentConvergence, renderAlignmentConvergence, type AlignmentConvergence, type AlignmentSegment, type AlignmentTotals,
  type AlignmentTrend, type RateInterval,
} from './evolution/alignment.js';
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
} from './evolution/outcomes.js';
// The step clock's knowledge channel — execution recoveries observed by the
// turn's own failure ledger, injected for the rest of the episode.
export {
  recordRecoveryFinding, listRecoveryFindings, recoveryFindingText,
  MAX_RECOVERY_FINDINGS, type RecoveryFinding,
} from './evolution/recovery.js';
// C8/C11 — the hand-labeled calibration set, and the bias-corrected view of
// every rate the classifier feeds. Uncalibrated is reported as such, never
// approximated away.
export {
  sampleForLabeling, renderLabelingFile, parseLabelingFile, allocateLabelBudget,
  ingestOutcomeLabels, type LabelIngestResult,
  calibrationReport, renderCalibrationReport, DEFAULT_LABEL_BUDGET,
  type LabelingItem, type ParsedLabelFile, type CalibrationReport,
  type CalibrationStratum, type CalibratedSegment,
} from './evolution/calibration.js';
export {
  classifierAccuracy, correctedRate, designWeightedKappa, describeCalibrationGap,
  type CalibrationGap, type ClassifierAccuracy, type CorrectedRate, type CorrectedRateResult,
  type ClassifierAccuracyResult, type GoldStratum, type KappaEstimate,
  type MeasuredProportion, type PredictionStratum,
} from './evolution/ppi.js';
// The LLM panel that re-judges the hand-labeled turns, and the pre-registered
// bar it must clear before a recalibration may lean on it instead of the owner.
export {
  runEnsemble, ensembleReport, renderEnsembleReport, describeEnsembleGap,
  buildEnsembleJudgePrompt, panelVerdict, STAND_IN_THRESHOLDS,
  type EnsembleJudge, type EnsembleRun, type EnsembleRunResult, type EnsembleGap,
  type EnsembleReport, type EnsembleMember, type StandInCondition,
} from './evolution/ensemble.js';
// Behavioural weak labels — turns judged by what the user DID (interrupts,
// refusals, re-asks, approvals), and the harness that scores the classifier and
// the panel against them. Complements the on-distribution calibration above; it
// never replaces it.
export {
  BEHAVIOR_RULES, weakLabel, corpusStats, runCorpusEval, renderCorpusReport,
  type BehaviorRule, type CorpusTurn, type TurnSignals, type WeakLabel,
  type CorpusStats, type CorpusEvalInput, type CorpusEvalReport, type RaterScore,
  type RaterCost,
} from './evolution/behavior-labels.js';
// Replay-eval harness — outcome-labeled turns re-run against the current
// config; the persisted loss curve.
export {
  initReplayTables, runReplayEval, listReplayEvals, DEFAULT_REPLAY_SAMPLE_SIZE,
  type ReplayEvalSummary, type ReplayInstanceResult, type RunReplayEvalOpts,
} from './evolution/replay.js';
// The durable evolution window + pending outcome review — the state neither
// backend's instance outlives (one process per `proteus exec`; DO eviction).
export {
  initSessionWindowTable, createSessionWindowStore, type SessionWindowStore, type ClaimedWindow,
} from './evolution/session-window.js';
// Evolution Changelog — the "what I changed about myself" digest over the
// durable ledgers, with real revert dispatch (the autonomy-flip transparency).
export {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogEntryKind, type BuildChangelogOptions,
  type ChangelogRevertAction,
  type ChangelogRevertContext, type ChangelogRevertResult,
} from './evolution/changelog.js';
// Canonical `buildBuiltinTools` is exported below; the older `buildAgentTools`
// surface is no longer exported.

// Configuration
export { DEFAULT_CONFIG, DEFAULT_MAX_STEPS, resolveMaxSteps } from './config.js';
export type { AgentConfig, MCTSDefaults, CraftStoreDefaults, ScaffoldDefaults } from './config.js';

// Typed accessors over the `agent_config` key/value table — collapses ~23
// raw-SQL sites into a deep module with known-key getters/setters.
export {
  createAgentConfigStore, initAgentConfigTable,
  AGENT_CONFIG_KEYS, DEFAULT_AUTO_GEPA_EVERY_N_TURNS,
  DEFAULT_GEPA_EVAL_BUDGET, clampGepaEvalBudget,
  type AgentConfigStore, type MctsOverrides, type ShellApprovalMode,
} from './config/index.js';

// Types
export type * from './types/primitives.js';
export type * from './types/agent-runtime.js';
export type * from './types/backend-host.js';
export type * from './types/signals.js';
export { SIGNAL_ID_METADATA_KEY } from './types/signals.js';
export type * from './types/mcts.js';
export type * from './types/craft.js';
export type * from './types/evaluation.js';

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
} from './views/index.js';

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
} from './release/index.js';

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
} from './experience/index.js';

// Chat engine (shared between server and CLI)
export { runChat, INTERRUPTED_TURN, type ChatEvent, type ChatOptions } from './chat.js';

// Extension seam (public plugin API — observe + extend a turn)
export {
  ExtensionHost,
  type ProteusExtension,
  type TurnStartContext,
  type ToolCallContext,
  type ToolResultContext,
  type TurnEndContext,
  type PrepareStepContext,
  type TransformContext,
} from './extension.js';
export {
  composePrepareStep,
  type StepCachePlan,
  type StepDynamicContext,
  type StepPipeline,
} from './prompting/prepare-step.js';
export {
  pruneStepToolOutputs,
  STEP_CONTEXT_BUDGET_RATIO,
  STEP_RECENT_TOOL_BUDGET_TOKENS,
  type StepPruneBudget,
} from './prompting/step-prune.js';
export {
  settleUnpairedToolCalls,
  INTERRUPTED_TOOL_RESULT,
} from './prompting/interrupted-tool-calls.js';
export { StepInjections, type RecordedInjection } from './prompting/step-injections.js';
export {
  classifyTurnFailure,
  planOverflowRecovery,
  OVERFLOW_RETRY_EVENT,
  OVERFLOW_RETRY_TEXT,
  type TurnFailureClass,
  type TurnFailureSignals,
  type OverflowRecoveryInput,
  type OverflowRecoveryDecision,
} from './turn-failure.js';

// LLM (Vercel AI SDK wrapper — shared across backends)
export { createVercelAILLM, collectStepText, createChatModel, createCompletionLLM, estimateTokens } from './llm.js';
export type { LLMProviderConfig, ChatModelConfig, LLMUsage } from './llm.js';
// The ONE normalized provider usage report, and the absence-preserving
// arithmetic over it. Every surface that counts tokens speaks this.
export {
  USAGE_FIELDS,
  UsageSchema,
  addUsage,
  normalizeUsage,
  usageReported,
  usageTotal,
} from './usage.js';
export type { Usage } from './usage.js';
export { contextWindowForModel } from './context-window.js';
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
} from './context-budget.js';
// The cumulative, label-scoped spend governor — the outer integral over every
// call-scoped budget. Opt-in: no label, no cap, no storage traffic.
export {
  MissionGovernor,
  MissionBudgetExhausted,
  MISSION_LABELS_METADATA_KEY,
  readMissionLabels,
  readMissionLimits,
  localMissionPort,
  localMissionScope,
  type MissionBudgetPort,
  type MissionScope,
  type MissionBudgetLimits,
  type MissionBudgetRefusal,
  type MissionBudgetSnapshot,
  type MissionGovernorDeps,
  type MissionSeam,
  type MissionSpendProvenance,
} from './mission-budget.js';
export {
  buildCompactionSummaryPrompt,
  wrapCompactionSummary,
  stripCheckpointPreamble,
  CONTEXT_CHECKPOINT_PREFIX,
  type CompactionSummaryPromptInput,
} from './compaction.js';

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
  DELEGATION_RUNGS,
  DELEGATION_CONVERSE,
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
} from './tools/registry.js';
export { mcpToolKey, isMcpToolKey } from './tools/mcp-naming.js';
export {
  createAgentsTool, agentsActionsFor, renderAgentsToolDescription, resumableForkInput,
  type AgentsToolInput,
} from './tools/agents-tool.js';
// The same delegation dispatch, projected into the codemode sandbox.
export { createAgentsCodemodeProvider } from './tools/agents-codemode.js';
// `agent.*` — self-direction (curriculum, scaffold proposals, schedules,
// background jobs, compaction) over one host seam both backends implement.
export { createAgentSelfProvider, type AgentSelfHost } from './tools/agent-self.js';
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
} from './subordinates/support.js';
export {
  buildBuiltinTools, PEER_REPLY_TOPIC,
  type AgentsToolDeps, type AgentsForkDeps,
  type BuiltinToolDeps,
  type CraftedToolSet, type CreateExecuteToolFactory,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type SubordinateDelivery, type SubordinatePhase, type SubordinateHandoff,
  type PeersToolDeps, type ReportToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './tools/builtins.js';
// Web search + fetch — provider seam + key-less default + codemode provider.
export * from './web/index.js';
// Recursive Language Models — the llm.query codemode provider (both backends).
export { createRLMProvider, type CodemodeProvider, type RLMModelResolver, type RLMOptions } from './rlm.js';
// The release lane — codemode-only (release.* inside execute_tools). No
// native tool: see tools/builtins.ts's header for why.
export {
  createReleaseCodemodeProvider, runReleaseAction,
  type ReleaseToolDeps, type ReleaseActionInput,
} from './tools/release-codemode.js';
// memory.* / tasks.* / report.* — codemode projections of the same-named
// native tools, sharing one dispatcher each (memory-tool.ts / tasks-tool.ts /
// the native `report` tool's ReportToolDeps).
export { createMemoryCodemodeProvider } from './tools/memory-codemode.js';
export { createMemoryDispatcher, type MemoryToolDeps, type MemoryToolInput } from './tools/memory-tool.js';
export { createTasksCodemodeProvider } from './tools/tasks-codemode.js';
export { createTasksDispatcher, type TasksToolInput } from './tools/tasks-tool.js';
export { createReportCodemodeProvider } from './tools/report-codemode.js';
// The file plane's dispatcher, shared by the native `file` tool and
// workspace.editFile (execution/inline.ts) — see tools/file-tool.ts.
export { createFileDispatcher, type FileToolDeps, type FileToolInput } from './tools/file-tool.js';
// Tool-call rendering vocabulary, shared by the web chat card and the CLI
// transcript. It was a cf-backend component and the CLI therefore printed raw
// argument values; see tools/tool-call-summary.ts.
export {
  summarizeToolCall, summarizeToolRun, describeToolCall, describeCommand,
  isToolCallFailed, clip,
} from './tools/tool-call-summary.js';
export {
  clampToolResult,
  clampSerializedToolResult,
  withClampedToolResult,
  withClampedToolResults,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_OUTPUT_DIR,
  type ClampToolResultOptions,
} from './tools/clamp.js';
export { handRolledFileWrite, createFileToolSteer } from './tools/run-file-steer.js';
export {
  toCraftedToolSource,
  type CraftedToolExecute,
  type CraftedToolExecuteFn,
  type CraftedToolSource,
} from './tools/crafted-executor.js';
export {
  buildSystemPromptSync,
  currentDateForPrompt,
  FALLBACK_PURPOSE,
  type SystemPromptOptions,
} from './prompt.js';
// The boundaries of an assembled request — shared by the renderers that write
// them and the meter that measures against them.
export {
  splitPromptSections,
  DYNAMIC_CONTEXT_OPEN_TAG,
  SOUL_SECTION_TITLE,
  type PromptSection,
} from './prompting/sections.js';
// What one request was locally measured to be made of — an estimate, carried
// next to the provider's authoritative totals rather than reconciled into them.
export {
  TurnContextMeter,
  measureContext,
  type ContextComposition,
  type ContextPlane,
  type ContextSegment,
  type ToolDefsLike,
} from './context-meter.js';
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
} from './prompting/surface.js';
export {
  assertToolsSupportedByModel,
  modelSupportsTools,
  resolvePromptModelProfile,
  type PromptModelCapability,
  type PromptModelContext,
  type PromptModelFamily,
  type PromptModelProfile,
} from './prompting/model-profile.js';
export {
  renderAgentsMdSection,
  collectWorkspaceAgentsMd,
  AGENTS_MD_MAX_CHARS,
  type AgentsMdFile,
} from './prompting/agents-md.js';
export {
  acceptedMediaForModel,
  sanitizeAttachmentsForModel,
  type AttachmentPolicy,
  type MediaModality,
} from './prompting/attachment-sanitizer.js';
export {
  DynamicContextLedger,
  agentDynamicContext,
  executorAvailabilityLabel,
  fnv1a64,
  forkDelegates,
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
} from './prompting/volatile-context.js';
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
} from './prompting/cache-breakpoints.js';
export {
  extractJsonArray,
  extractJsonObject,
  generateJson,
  jsonArrayOnlyInstruction,
  jsonObjectOnlyInstruction,
  stripMarkdownFences,
} from './prompts/structured.js';
export { EVIDENCE_BUDGETS, evidenceWindow } from './prompts/evidence-window.js';

// Runtime builder (shared across backends)
export { buildRuntime } from './runtime-builder.js';
export type { RuntimeComponents } from './runtime-builder.js';

// MCTS engine
export { runMCTS } from './mcts/engine.js';
export { selectNode } from './mcts/uct.js';
export { backpropagate } from './mcts/backpropagation.js';
export { recordNode } from './mcts/record-node.js';
export type { SessionWriter, SessionMessage, SessionMessagePart } from './mcts/record-node.js';
export { converge } from './mcts/convergence.js';
export { pruneLowValueBranches } from './mcts/pruning.js';
// Sibling diversity at expansion — backends render this into the explore prompt.
export { diversityDirective, diversityAngle, siblingAngles } from './mcts/diversity.js';
// The one question a branch is asked, whatever substrate runs it.
export {
  explorePrompt, reflectionPrompt,
  type ExplorePrompt, type ExplorePromptInput, type ExploreToolHint,
} from './mcts/explore-prompt.js';
export {
  canonicalLanguage, fencedBlocks, readProposalCode,
  type FencedBlock, type ProposalCode,
} from './execution/code-fence.js';
// Whole-message branch context inheritance (shared by every explore() backend).
export {
  formatInheritedContext, DEFAULT_INHERITED_MESSAGES,
  type InheritedMessage,
} from './mcts/inherited-context.js';
// Test-based convergence tie-break over near-tied candidates.
export { selectWinnerByTest, type TestSelectionDeps } from './mcts/test-selection.js';
export {
  evaluateWithMultiModelJudging, median,
  type EvaluateBranchOptions, type BranchEvaluation,
} from './mcts/evaluation.js';
export type { EvaluationGrounding } from './types/evaluation.js';
export { estimateCost } from './mcts/cost.js';
// Alternate Takes — near-tied convergence candidates + the pick→ledger signal.
export {
  initAlternateTakesTable, captureAlternateTakes, claimAlternateTakesForTurn,
  purgeUnclaimedAlternateTakes,
  listAlternateTakeSets, latestAlternateTakeSet, recordTakePick,
  recordBranchTakeSet, recordHeadsTakeSet, buildTakeContinuationPrompt, takeEvidence,
  type AlternateTakeCandidate, type AlternateTakeSet, type AlternateTakeSource,
  type HeadTakeCandidate, type TakePickRecord, type TakePickOutcome,
} from './mcts/takes.js';
// Steer-as-Branch — a mid-turn redirect run as a parallel head that settles
// into the Alternate Takes pipeline against the live turn's answer.
export {
  BRANCH_HEAD_BUDGET, BRANCH_RATIONALE, STEER_BRANCH_RUN_ID_PREFIX,
  newBranchId, isSteerBranchRunId,
  startBranchHead, settleBranchIntoTakes, settlePendingBranch, settlePendingBranches,
  type BranchStatusEvent, type BranchStartInput, type SteerBranchHandle,
  type BranchSettleOutcome, type PendingBranch,
} from './steer-branch.js';

// Schemas
export { initSearchTables } from './mcts/schemas.js';
export {
  MctsSearchStore,
  initMctsSearchTable,
  persistableMCTSConfig,
  type PersistedMCTSConfig,
  type ResumableSearch,
  type MctsSearchRunSummary,
} from './mcts/search-store.js';
export { initScaffoldTables } from './scaffold/schemas.js';
export { initCraftScoreTables } from './craft/schemas.js';

// Scaffold management
export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap.js';
export { modifyScaffold, type ModifyResult, type ModifyScaffoldOpts } from './scaffold/modify.js';
export { rollbackScaffold } from './scaffold/rollback.js';
// Misevolution gate — fixed safety criteria over every evolution surface
// (scaffold acceptance + promotion, extracted tools, agent-authored tools,
// imported experience).
export {
  checkMisevolution, checkMisevolutionForSurface, recordMisevolutionVeto,
  type MisevolutionSurface, type MisevolutionVerdict, type MisevolutionViolation,
} from './scaffold/misevolution.js';
// Variant archive — DGM-style lineage + branch-base selection over the
// existing scaffold_versions/scaffold_evaluations rows (no parallel store).
export {
  listScaffoldArchive, listRejectedProposals, selectEvolutionBase,
  type ScaffoldArchiveEntry, type EvolutionBaseSelection,
  type RejectedProposal, type RejectionKind,
} from './scaffold/archive.js';
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
} from './scaffold/executor.js';
export { pumpScaffoldEvents } from './scaffold/event-pump.js';
export { scaffoldEventsToUIStream } from './scaffold/ui-stream.js';
// The two backend inference seams: the DO's UI message stream and a local
// turn's ChatEvent stream. Same decision, same delegation contract.
export { scaffoldInferenceTransform, type InferenceStreamResult } from './scaffold/inference-transform.js';
export { scaffoldChatTransform } from './scaffold/chat-transform.js';
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
} from './scaffold/shadow.js';
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
} from './scaffold/auto-judge.js';

// CraftStore quality
export { emaUpdate, effectiveScore, filterByEffectiveScore, updateCraftScores } from './craft/ema.js';
export { craftFailureMarker, CRAFT_NEUTRAL_PRIOR } from './craft/in-episode.js';
export { maybeStoreCraftedTool } from './craft/discovery.js';
export { periodicCraftConsolidation } from './craft/consolidation.js';
export { checkConflictsBeforeAdding, upsertCraftedTool } from './craft/conflict.js';
export { migrateCraftedToolDuplicates, type MigrationReport } from './craft/migrate-duplicates.js';

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
  DEVICE_PRESENCE_CONFIG_KEY,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
  DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
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
} from './execution/index.js';

// Client-safe workspace addressing and VFS contracts. The embedded Nimbus
// workspace host is exported separately from `@proteus/core/workspace` so a
// browser import of the main barrel cannot pull the server runtime into its
// bundle.
export {
  workspacePath, WORKSPACE_ROOT,
} from './vfs/workspace-path.js';
export type {
  WorkspaceBundle, WorkspaceOptions, WorkspaceVFS,
} from './vfs/nimbus-workspace.js';
export {
  makeVfsError, isVfsError, ERRNO, withVfsErrorHint, vfsAddressingHint,
  type VfsError, type VfsErrorCode,
} from './vfs/errno.js';
export { observeWrites, type WriteEvent, type WriteObserver } from './vfs/observe.js';

// File checkpoints — the shadow-git snapshot seam (backends implement it)
export {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_UNAVAILABLE_NO_GIT, summarizeRestorePlan,
  type FileCheckpoints, type CheckpointTurnMeta, type CheckpointAvailability,
  type FileCheckpointEntry, type FileCheckpointListing, type FileRestoreChange, type FileRestoreKind,
  type FileRestorePlan, type FileRestoreResult, type DeviceCheckpointHint,
} from './checkpoints/types.js';
// Shadow-git store format — the cross-engine contract (cli-backend imports
// it; the zero-dep pc-agent daemon pins it, enforced by the parity test).
export {
  CHECKPOINT_REF_PREFIX, CHECKPOINT_WORKDIR_MARKER, CHECKPOINT_EXCLUDES,
  checkpointSubject, parseCheckpointSubject, checkpointRefTimestampMs,
} from './checkpoints/format.js';

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
} from './memory/vector-store.js';
export {
  hybridSearch,
  memorySnippetRehydrator,
  type SnippetRehydrator,
  type LexicalHit,
  type HybridHit,
  type LexicalSearchFn,
  type HybridSearchOptions,
} from './memory/hybrid-search.js';

// Memory write primitive — single canonical "save a note to MEMORY.md".
// Used by workspace.saveNote, the `memory` builtin tool, and MCP saveNoteFromMcp.
// readMemoryTail is the shared bounded-tail read both backends weave per turn.
export { memoryBytes } from './memory/note.js';
export { appendMemoryNote, readMemoryTail, MEMORY_TAIL_MAX_CHARS } from './memory/note.js';

// Zero-LLM transcript search over the canonical `messages` table (FTS5).
// Backs the `memory` tool's `sessions` action on both backends.
export {
  SessionSearchStore,
  type SessionSearchHit, type SessionScrollMessage,
  type SessionScrollResult, type SessionSummary,
} from './memory/session-search.js';

// agent_facts — typed, idempotent, keyed world-model store. Built on DO SQL.
// Top-K recent facts are auto-rendered into the system prompt every turn.
export {
  initFactsTable, createFactsStore, renderFactsBlock,
  type Fact, type FactsStore, type FactUpsertResult,
} from './memory/facts.js';
export {
  JsonValueSchema, JsonObjectSchema, JsonArraySchema,
  parseJsonValue, parseJsonObject, parseJsonArray, decodeJsonValue, projectJsonValue,
  type JsonPrimitive, type JsonObject, type JsonValue,
} from './utils/json.js';

// Sleep-time compute — between-turn background memory compression
// (Letta-style; ~50% test-time token reduction reported).
export {
  runSleepTimeCompute, applySleepTimeUpdate,
  type SleepTimeInput, type SleepTimeUpdate,
} from './memory/sleep-time-compute.js';

// durable run-event log (Flue-style, SSE-resumable) — its own `run_events`
// table. The EventsHub's `agent_log` is a separate ledger (ingress events,
// phases, reactor decisions); the two coexist rather than one fronting the
// other, and the per-step telemetry sample reads this one.
export type {
  RunEvent, RunEventBase, RunEventInput, RunEventType, StepCost,
  CompletionGateRecord, TurnSteeringRecord, TurnSteeringTrigger, CraftCycleRecord,
  ExecutionRecoveryRecord,
  CacheHitStats, StepTelemetry,
} from './events/index.js';
export {
  FAILURE_WITHOUT_ERROR,
  initRunEventTables,
  parseStoredRunEvent,
  RunEventRecorder,
  cacheHitRate,
  summarizeSteps,
  CACHE_HIT_EMA_ALPHA,
  type RunEventListener,
  type RunEventQuery,
} from './events/index.js';

// EventsHub — events / triggers / turn runner / reply channels.
// Builds the agent_log ledger plus the trust, channel, trigger and budget
// primitives around it. Spec: docs/ARCHITECTURE.md — "Events and ingress".
export * from './events/hub/index.js';

// Ingress — the gated paths external signals take into that ledger: webhook
// auth + rate limiting, timer registration and firing, the inbound-email
// trust gate, the peer outbox, subordinate reports.
export * from './events/ingress/index.js';

// ExplorationStrategy — single seam for "search candidate continuations,
// score, pick best." MCTS / Heads / ToT / Reflexion / single-shot fit this.
export * from './strategy/index.js';

// Eval harness — A/B test arbitrary strategies/loops on a corpus of tasks.
export * from './eval/index.js';

// Bench harness — machine-scored, sealed-split, paired-statistics measurement
// of whether a variant (scaffold, memory, evolved state) actually helps. Pure
// math + report shapes; the executing runner lives in scripts/bench.ts.
export * from './bench/index.js';

// Voyager-style automatic curriculum + Absolute Zero learnability filter.
// Proposes next tasks at the "barely succeeds" sweet spot.
export * from './curriculum/index.js';

// provider abstraction — single registry for resolving model specs across
// Workers AI, AI Gateway, Codex (ChatGPT subscription), OpenAI, OpenRouter,
// and generic OpenAI-compatible upstreams. Auth resolution flows through
// the AuthResolver callback in ProviderDeps — secrets stay inside UserDO
// (cf-backend) and never enter the provider layer.
export * from './providers/index.js';
// Credential value shape (still exported for UserDO + tests; the previous
// CredentialStore interface is gone).
export type { Credential, BearerCredential, OAuthCredential, OpenAICompatCredential } from './credentials/store.js';

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
} from './plans/index.js';

// Wire constants shared by the cf-backend Worker and the CLI.
export {
  CLOUD_MAX_INLINE_ATTACHMENT_BYTES,
  DEVICE_CONNECT_PATH,
  ORCHESTRATOR_AGENT_SLUG,
  SUBORDINATE_AGENT_SLUG,
} from './cloud-wire.js';

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
} from './platform-catalog.js';

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
} from './safety/index.js';

// Utils
export { nanoid } from './utils/nanoid.js';
export { hmacSha256Hex, timingSafeEqual } from './utils/crypto.js';
// Confidence intervals — every score this system reports travels with one.
export {
  wilsonInterval, scoreInterval, lossInterval, formatScoreInterval, seededRandom,
  type ScoreInterval,
} from './utils/stats.js';
export { isoDate, today, nowMs } from './utils/date.js';

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
} from './heads/index.js';
export {
  DEFAULT_HEAD_BUDGET, DEFAULT_MERGE_STRATEGY,
  deriveChildBudget, budgetExhausted,
  initHeadsTables,
  HeadJournal, type HeadJournalRow, type LiveHeadRun, type AbandonedHeadRun,
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
} from './heads/index.js';

// Background-job system — auto-background long tool calls + wake-on-completion.
export {
  BackgroundJobStore, initBackgroundJobsTable, serializeJobResult, withBackgroundThreshold, withSpawnDetach,
  isBackgroundHandle, SPAWN_STARTED_OPTION, readSpawnStarted,
  BackgroundJobRunner, JobNotResumable, EVICTION_INTERRUPT_ERROR, BACKGROUND_POLICY, MAX_CONCURRENT_DETACHED_JOBS,
  type BackgroundJob, type BackgroundJobStatus, type BackgroundHandle, type BackgroundRefusal, type ThresholdDeps,
  type BackgroundPolicy, type DetachOutcome, type SessionSurface,
  type BackgroundJobRunnerDeps, type JobResumer, type JobClaim,
} from './jobs/index.js';

// The agent's own task list — what the `tasks` tool writes and the Tasks
// surface reads.
export {
  TaskListStore, initTaskListTable, TASK_STATUSES, MAX_TASK_TITLE_CHARS,
  type AgentTask, type AgentTaskTree, type TaskStatus,
  type TaskAddResult, type TaskAddRejection,
} from './tasks/store.js';

// Backend-agnostic orchestration — per-turn accounting shared by both backends.
export {
  TurnAccumulator,
  type StepLike, type ToolResultLike, type TurnSinks,
} from './orchestrator/turn-accumulator.js';
export {
  AgentOrchestrator, type AgentOrchestratorDeps,
  type TurnContinuity, DEFAULT_SETTLE_TIMEOUT_MS, DEFAULT_SESSION_REFLECTION_INTERVAL,
} from './orchestrator/agent-orchestrator.js';
export { SignalDelivery } from './orchestrator/signals.js';
export {
  TurnSteering, isFailingToolResult, TURN_STEERING_HEADER,
  IDENTICAL_CALLS_BEFORE_STEER, CONSECUTIVE_FAILURES_BEFORE_STEER, LONG_TURN_STEPS_BEFORE_STEER,
  STEPS_WITHOUT_PROGRESS_BEFORE_STEER,
  type TurnProgressInputs,
} from './orchestrator/turn-steering.js';
export { CraftCycle } from './orchestrator/craft-cycle.js';
export {
  CompletionGate, observeCompletionState, completionGateText,
  COMPLETION_GATE_EVENT, COMPLETION_GATE_HEADER, COMPLETION_PROBE_COMMANDS,
  COMPLETION_OBSERVATION_MAX_CHARS, COMPLETION_TASK_ECHO_MAX_CHARS,
  type TurnCompletionFacts,
} from './orchestrator/completion-gate.js';
export { assembleTurnMessages, type TurnContextInput } from './orchestrator/turn-context.js';
export {
  openTurnRun, closeTurnRun, snapshotCompletedTurn,
  persistMeasuredPromptTokens, applyOverflowRecovery,
  type CompactionTriggerState,
} from './orchestrator/turn-lifecycle.js';
export {
  createScaffoldLLMStream, createScaffoldCallTool, createScaffoldHistory,
  SCAFFOLD_HISTORY_DEFAULT_LIMIT, SCAFFOLD_HISTORY_MAX_LIMIT,
  SCAFFOLD_HISTORY_DEFAULT_MESSAGE_CHARS, SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS,
  SCAFFOLD_HISTORY_MAX_PAGE_CHARS,
  type ScaffoldBridgeOpts, type ScaffoldHistoryQuery, type ScaffoldHistoryReader,
  type ScaffoldHistoryEntry, type ScaffoldHistoryPage,
} from './orchestrator/scaffold-host.js';
export {
  BACKGROUNDABLE_TOOLS, wrapToolsForBackground, resumeForkBackgroundJob,
} from './orchestrator/background-tools.js';
export { buildStrategyForkDeps, type ForkDepsWiring } from './orchestrator/fork-deps.js';
export { createDurableMctsSession } from './orchestrator/mcts-session.js';
export {
  skillsVfsOver, resolveTurnSkills, filterToolNamesBySkills, filterToolSetBySkills,
  renderFactsForTurn, type TurnSkillsConfig, type TurnSkillSurface,
} from './orchestrator/turn-surface.js';
export { ModelCatalogSession } from './orchestrator/model-catalog.js';
export {
  serializeContentForHeads, narrowInheritedRole, headPhaseRunEvent,
  inheritedContextFromHistory, inheritedContextFromRows,
  INHERITED_CONTEXT_CAP, inheritedContextOmissionNote,
} from './orchestrator/heads-support.js';
export { recordGroundedHeadsTake } from './mcts/takes.js';

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
} from './skills/index.js';
export type {
  ParsedSkill, SkillSource, ActiveSkillSet,
  ActivationReason, SkillParseResult, SkillErrorCode,
  SkillsVfs, DiscoverOpts, LoadActiveSkillsOpts,
} from './skills/index.js';

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
} from './evolution/control.js';
export {
  runGepa, runScaffoldGepa,
  DEFAULT_GEPA_BUDGET,
  // SQL persistence — needed by the orchestrator to create tables + run.
  initGepaTables, startGepaRun, finishGepaRun,
  listGepaRuns, loadGepaCandidates, makePersistingHook,
} from './evolution/gepa/index.js';
export type {
  EvalInstance, MetricOutcome, GepaMetric, ReflectionLM,
  GepaCandidate, GepaConstraints, GepaBudget, GepaConfig,
  GepaIterationState, GepaResult,
  RunScaffoldGepaOpts, RunScaffoldGepaResult,
  GepaRunSummary,
} from './evolution/gepa/index.js';

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
} from './layergate/index.js';
export type {
  Layer, Probe, PipelineSubjects, SubjectName,
  Baseline, LayerGateReport, LayerScore, Fault, FaultImpact,
} from './layergate/index.js';

// Backend conformance gate — the manifest of which composition root wires
// which capability (or why deliberately not), plus the comparator the
// per-backend harnesses run their observed surfaces through. Kills the
// "X never worked on Y backend" class: a forgotten wire can no longer look
// like a design decision.
export {
  BACKEND_CONFORMANCE, CONFORMANCE_PLANES, CONFORMANCE_ROOTS, PLANE_UNIVERSE, WIRED,
  compareSurface, normalizeObservedTables, observedActionEnum, phantomCallables,
  renderConformanceFindings,
} from './conformance/index.js';
export type {
  CapabilityStatus, ConformanceFinding, ConformanceFindingKind, ConformanceManifest,
  ConformancePlane, ConformanceReport, ConformanceRoot, ObservedSurface, RootStatuses,
} from './conformance/index.js';

// ── Read models ──
// The folds an operator surface asks for: what the workspace is, what a run
// did, what changed on disk, what work is detached, what the knobs are set to.
// Every one reads storage the agent already owns, so none of them is
// backend-shaped — a backend supplies its transport and nothing else.
export {
  classifyEvolutionType, getRunTimeline, runEventToSpan, safeJsonParse, toolKindFor,
} from './read-models/timeline.js';
export type { RunTimelineDeps, TimelineKind, TimelineSpan } from './read-models/timeline.js';
export { getRunEvents, getRunSummaries, listRuns } from './read-models/runs.js';
export type { RunListEntry, RunSummary } from './read-models/runs.js';
export {
  censusToolFailures, classifyToolFailure, toolFailureKey,
} from './read-models/tool-failures.js';
export type { ToolFailure, ToolFailureCensus } from './read-models/tool-failures.js';
export {
  getExecutorDiff, getWorkspaceDiff, initWorkspaceBaselineTable, resetWorkspaceBaseline,
  walkWorkspaceTextFiles,
} from './read-models/workspace-diff.js';
export type { ExecutorDiffResult, WorkspaceDiffResult } from './read-models/workspace-diff.js';
export {
  computeWorkspaceDiff, diffLines, fileDiff, parseGitDiff, MAX_LINES_PER_FILE,
} from './vfs/diff.js';
export type { DiffLine, FileDiff, FileStatus, LineDiff } from './vfs/diff.js';
export {
  getExecutorFiles, readExecutorFile, sortDirEntries, executorFiles, writeExecutorFileOp,
  listEnvironments, normalizeDir, joinDir, parentDir,
} from './read-models/files.js';
export type {
  DirEntry, ExecutorFileLookup, ExecutorRowLookup, ExecutorWriteResult,
  EnvironmentInfo, MountInfo,
} from './read-models/files.js';
export { readLatestSearchTree, readSearchTree, readSearchForest } from './read-models/search-tree.js';
export { readForkRunParams } from './read-models/fork-params.js';
export { readExplorationCanvas } from './read-models/exploration-canvas.js';
export type { ExplorationCanvasView } from './read-models/exploration-canvas.js';
export type {
  ForkRunParams, ForkSettlePolicy, CompetedForkParams, MergedForkParams,
} from './read-models/fork-params.js';
export { listForkRuns, readForkRun } from './read-models/fork-runs.js';
export type { ForkRunSummary, ForkRunStatus, ForkSettle } from './read-models/fork-runs.js';
export { buildPendingActions } from './read-models/pending-actions.js';
export { getAgentStatus, getChatHistory, getToolList } from './read-models/status.js';
export { uiMessageText } from './utils/ui-message.js';
export type { PendingAction, PendingActionKind, PendingActionInputs } from './read-models/pending-actions.js';
export type {
  AgentStatus, AgentStatusDeps, ChatHistoryEntry, ToolListEntry,
} from './read-models/status.js';
export {
  cancelBackgroundJob, cancelCurrentWork, clearBackgroundJobs, dismissBackgroundJob,
  jobResult, listBackgroundJobs, retryBackgroundJob,
} from './read-models/background-jobs.js';
export type {
  BackgroundJobControl, BackgroundJobPlaneDeps, CancelWorkDeps, CancelWorkOutcome, RetryOutcome,
} from './read-models/background-jobs.js';
export {
  getAlwaysActiveSkills, getEvolutionConfig, getMctsConfig, getReasoningEffort,
  getShellApprovalMode, getStoredModelSpec, setAlwaysActiveSkills, setEvolutionConfig,
  setMctsConfig, setModel, setReasoningEffort, setShellApprovalMode,
  getShellApprovalGrants, revokeShellApprovalGrants,
} from './read-models/config-plane.js';
export type {
  EvolutionConfigView, MctsConfigView, SetModelDeps,
} from './read-models/config-plane.js';
export {
  getEvolutionChangelog, getUnseenChangelog, markChangelogSeen, pickAlternateTake, proposeCurriculumTasks,
} from './read-models/evolution-views.js';
export type { EvolutionChangelogView, TakePickDeps } from './read-models/evolution-views.js';
