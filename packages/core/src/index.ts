// @proteus/core — barrel export

// Identity system
export { initActorTables, initAllTables, migrateWorkspaceStorage } from './identity/schema.js';
export {
  DEFAULT_SOUL_MD,
  SOUL_PATH,
  readSoul,
  renderSoulMarkdown,
  seedSoul,
  summarizeSoul,
  writeSoul,
} from './identity/soul.js';
export { createWorkspace, wrapDatabase, type WorkspaceBirthConfig, type AgentDatabase } from './identity/create.js';
export { openWorkspace, type WorkspaceResumeConfig, type WorkspaceInfo } from './identity/open.js';
export { forkWorkspaceStorage, readForkLineage, type ForkOpts, type ForkResult, type ForkLineageRow } from './identity/fork.js';
export {
  WORKSPACE_IDENTITY_SYSTEM_PROMPT,
  workspaceIdentityPrompt,
  applyWorkspaceTitle,
  createWorkspaceNameFromMission,
  deriveWorkspaceTitle,
  fallbackWorkspaceIdentity,
  isPlaceholderWorkspaceTitle,
  parseWorkspaceIdentityOutput,
  planWorkspaceTitle,
  resolveWorkspaceTitle,
  slugifyName,
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
  type CompletedTurn, type CompletedSession, type ToolCallRecord, type TurnUsage,
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
  isNegativeOutcome, recordOutcomeLabels, listOutcomeLabels, goldLabels,
  type OutcomeLabel, type OutcomeLabelRow,
  type TurnOutcome, type TurnOutcomeSource, type TurnOutcomeRow,
  type OutcomeEvalExpectation, type OutcomeEvalInstance, type OutcomeEvalSplit,
  type OutcomeSplitDegeneracy,
  type LessonRow, type LessonSource, type LessonStatus, type RealOutcomeRate,
} from './evolution/outcomes.js';
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
// Replay-eval harness — outcome-labeled turns re-run against the current
// config; the persisted loss curve.
export {
  initReplayTables, runReplayEval, listReplayEvals, DEFAULT_REPLAY_SAMPLE_SIZE,
  type ReplayEvalSummary, type ReplayInstanceResult, type RunReplayEvalOpts,
} from './evolution/replay.js';
// The durable evolution window + pending outcome review — the state neither
// backend's instance outlives (one process per `proteus exec`; DO eviction).
export {
  initSessionWindowTable, createSessionWindowStore, type SessionWindowStore,
} from './evolution/session-window.js';
// Evolution Changelog — the "what I changed about myself" digest over the
// durable ledgers, with real revert dispatch (the autonomy-flip transparency).
export {
  buildChangelog, countUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  type ChangelogEntry, type ChangelogEntryKind, type BuildChangelogOptions,
  type ChangelogRevertAction, type ChangelogRevertType,
  type ChangelogRevertContext, type ChangelogRevertResult,
} from './evolution/changelog.js';
// Canonical `buildBuiltinTools` is exported below; the older `buildAgentTools`
// surface is no longer exported.

// Configuration
export { DEFAULT_CONFIG, DEFAULT_MAX_STEPS, mergeConfig, resolveMaxSteps } from './config.js';
export type { AgentConfig, MCTSDefaults, CraftStoreDefaults, ScaffoldDefaults } from './config.js';

// Typed accessors over the `agent_config` key/value table — collapses ~23
// raw-SQL sites into a deep module with known-key getters/setters.
export {
  createAgentConfigStore, initAgentConfigTable,
  AGENT_CONFIG_KEYS, DEFAULT_AUTO_GEPA_EVERY_N_TURNS,
  DEFAULT_GEPA_EVAL_BUDGET, clampGepaEvalBudget,
  type AgentConfigStore, type AgentConfigKey, type MctsOverrides, type ShellApprovalMode,
} from './config/index.js';

// Types
export type * from './types/primitives.js';
export type * from './types/agent-runtime.js';
export type * from './types/backend-host.js';
export type * from './types/mcts.js';
export type * from './types/craft.js';
export type * from './types/scaffold.js';
export type * from './types/evaluation.js';

// Product self-customization lane — separate from scaffold evolution.
export {
  assertProductChangeTransition,
  PRODUCT_CHANGE_STATUSES,
  ProductChangeEngine,
  ProductChangeStore,
  approvalTypeForEnvironment,
  createProductChangeStore,
  createSandboxProductChangeExec,
  deployApprovalDigest,
  deployTargetAsCommand,
  initProductChangeTables,
  isEngineOwnedTransitionTarget,
  isProductChangeTerminal,
  isSecretProductPath,
  normalizeProductSourcePath,
  parseDeployOutput,
  productChangeSqlFromExec,
  redactProductDiff,
  validateProductPatchPath,
  type ApplyResult,
  type CheckRunResult,
  type DeployApprovalBinding,
  type DeployResult,
  type PreviewResult,
  type ProductChangeBoard,
  type ProductChangeApproval,
  type ProductChangeCheck,
  type ProductChangeDetail,
  type ProductChangeEngineOptions,
  type ProductChangeExec,
  type ProductChangeLedger,
  type ProductChangeRequest,
  type ProductChangeSqlExec,
  type ProductChangeSqlStore,
  type ProductChangeStatus,
  type ProductChangeStoreOptions,
  type ProductChangeTransitionResult,
  type ProductDeploymentRecord,
  type ProductPathValidation,
  type ProductSourceBinding,
  type ProductSourceBindingInput,
  type ProductSourceKind,
  type RollbackResult,
  type RunChecksResult,
} from './product-change/index.js';

// Cross-workspace experience transfer (owner-scoped library + gated imports).
// The gate, the staging ledger and the settle path are driven from inside core
// (the tool and EvolutionEngine), so what crosses the package boundary is the
// library a backend hosts, the two schema initializers, and the read surfaces.
export {
  createExperienceLibrary,
  findPublishable,
  initExperienceLibraryTables,
  initImportedExperienceTable,
  listImportedExperience,
  listPublishable,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperienceLibraryStore,
  type ExperiencePayload,
  type ExperienceSearchOptions,
  type ExperienceSqlExec,
  type ImportStatus,
  type ImportedExperienceRow,
  type PublishRefusal,
  type PublishSources,
  type PublishableCandidate,
} from './experience/index.js';
export {
  createExperienceTool,
  type ExperienceLibraryClient,
  type ExperienceToolDeps,
} from './tools/experience-tool.js';

// Chat engine (shared between server and CLI)
export { runChat, type ChatEvent, type ChatOptions } from './chat.js';

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
export { composePrepareStep, type StepCachePlan } from './prompting/prepare-step.js';
export {
  pruneStepToolOutputs,
  STEP_CONTEXT_BUDGET_RATIO,
  STEP_RECENT_TOOL_BUDGET_TOKENS,
  type StepPruneBudget,
} from './prompting/step-prune.js';
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
export { createVercelAILLM, collectStepText, createChatModel } from './llm.js';
export type { LLMProviderConfig, ChatModelConfig } from './llm.js';
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
  DELEGATION_FRAME,
  DELEGATION_RUNGS,
  DELEGATION_CONVERSE,
  renderToolSchemaDescription,
  type AgentsToolAction,
  type BuiltinToolName,
  type BuiltinToolSpec,
} from './tools/registry.js';
export { mcpToolKey, isMcpToolKey } from './tools/mcp-naming.js';
export {
  createAgentsTool, agentsActionsFor, renderAgentsToolDescription, resumableForkInput,
  type AgentsToolInput,
} from './tools/agents-tool.js';
export {
  buildBuiltinTools, PEER_REPLY_TOPIC,
  type AgentsToolDeps, type AgentsForkDeps,
  type BuiltinToolDeps, type ProductChangeToolDeps,
  type TeamToolDeps, type SubordinateRosterEntry, type SubordinateStatus,
  type PeersToolDeps, type ReportToolDeps,
  type PeerAskOutcome, type PeerSendOutcome, type PeerReplyOutcome, type PeerSpawnOutcome,
} from './tools/builtins.js';
// Web search + fetch — provider seam + key-less default + codemode provider.
export * from './web/index.js';
// Recursive Language Models — the llm.query codemode provider (both backends).
export { createRLMProvider, type CodemodeProvider, type RLMModelResolver, type RLMOptions } from './rlm.js';
export {
  clampToolResult,
  clampSerializedToolResult,
  withClampedToolResult,
  withClampedToolResults,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_OUTPUT_DIR,
  type ClampToolResultOptions,
} from './tools/clamp.js';
export {
  codegenDisallowed,
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
export {
  compilePromptSurface,
  executorIsSelectable,
  promptModeForTurnEvent,
  selectableRuntimeNames,
  uniqueBuiltinTools,
  uniqueExternalTools,
  uniquePromptExecutors,
  type PromptBackend,
  type PromptExecutorInfo,
  type PromptExternalToolInfo,
  type PromptMode,
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
  EphemeralContextLedger,
  executorAvailabilityLabel,
  fnv1a64,
  fnv1a64Bytes,
  renderSystemStateBlock,
  renderTurnLocalContext,
  turnLocalContextMessage,
  EPHEMERAL_CONTEXT_HEADER,
  TURN_CONTEXT_HEADER,
  type SystemStateContext,
  type TurnLocalContext,
} from './prompting/volatile-context.js';
export {
  applyCacheBreakpoints,
  cacheableSystem,
  hasCacheMarkers,
  markCacheTail,
  markLastToolForAnthropicCache,
  promptCacheOptions,
  resolvePromptCacheStrategy,
  ANTHROPIC_MAX_BREAKPOINTS,
  type CacheBreakpointInput,
  type CacheBreakpointPlan,
  type PromptCacheStrategy,
} from './prompting/cache-breakpoints.js';
export {
  extractJsonArray,
  extractJsonObject,
  jsonArrayOnlyInstruction,
  jsonObjectOnlyInstruction,
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
  BRANCH_HEAD_BUDGET, BRANCH_RATIONALE, newBranchId,
  startBranchHead, settleBranchIntoTakes, settlePendingBranch,
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
} from './mcts/search-store.js';
export { initScaffoldTables } from './scaffold/schemas.js';
export { initCraftScoreTables } from './craft/schemas.js';

// Scaffold management
export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap.js';
export { modifyScaffold, type ModifyResult, type ModifyScaffoldOpts } from './scaffold/modify.js';
export { rollbackScaffold } from './scaffold/rollback.js';
// Misevolution gate — fixed safety criteria over every evolution surface
// (scaffold acceptance + promotion, extracted tools, GEPA candidates).
export {
  checkMisevolution, recordMisevolutionVeto,
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
  type ScaffoldRunOptions,
  type ScaffoldRunResult,
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
  type PendingScaffold,
  type ShadowEvaluationRow,
  type ShadowVerdict,
  type ShadowVerdictTrial,
  type ShadowConfig,
  type ScaffoldStatus,
  type JudgeFn,
  type ShadowTrialVerdict,
} from './scaffold/shadow.js';
// auto-judge shadow evaluation — sampled-per-turn closure of the
// shadow-rollout loop. Picks up pending scaffolds, runs them against the
// same task, asks a judge LLM to compare, records the result, optionally
// auto-applies promotion/rollback when minTrials is reached.
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
export { maybeStoreCraftedTool } from './craft/discovery.js';
// SKILL.md export/import (Hermes-style git-friendly tool format)
export {
  craftedToolToSkillMd,
  parseSkillMd,
  exportAllSkillsToVfs,
  importSkillsFromVfs,
  type SkillMdParseResult,
  type ExportSkillsResult,
  type ImportSkillsResult,
} from './craft/skill-md.js';
export { periodicCraftConsolidation } from './craft/consolidation.js';
export { checkConflictsBeforeAdding, upsertCraftedTool } from './craft/conflict.js';
export { migrateCraftedToolDuplicates, type MigrationReport } from './craft/migrate-duplicates.js';

// Execution layer
export {
  DefaultExecutionRouter,
  createInlineExecutor,
  createSandboxExecutor, type SandboxHandle,
  type BackupOptions, type DirectoryBackup, type RestoreBackupResult,
  shouldBackupWorkspace, workspaceBackupOptions, BACKUP_MIN_INTERVAL_MS, BACKUP_TTL_SECONDS,
  isSandboxTransientError,
  createDeviceTunnelExecutor, type DeviceTransport,
  devicePresence, parseDevicePresence, deviceChangeNotice, observeDevicePresence,
  DEVICE_PRESENCE_CONFIG_KEY,
  type DeviceStatus, type DevicePresence, type DevicePresenceStore,
  DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED, NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  createNimbusExecutor, type NimbusExecutorOpts, type NimbusSandboxHandle,
  type ExecutorCapability, type ExecutorKind, type ExecutorProvider,
  type ExecutorLifecycleStatus, type ExecutorStatus,
  type ExecutorInfo, type ExecutionRouter, type InlineExecutorDeps,
} from './execution/index.js';

// File plane — CompositeVFS mount table + raw-handle mount adapters
export {
  CompositeVFS, EXECUTOR_MOUNT_PREFIX, cleanAbsolutePath,
  makeVfsError, isVfsError, ERRNO,
  createSandboxMountVFS, createNimbusMountVFS, createDeviceMountVFS,
  createParentRpcMountVFS,
  type MountPolicy, type MountSpec, type MountInfo, type MountConsistency,
  type ResolvedPath, type VfsError, type VfsErrorCode, type DeviceMountConsent,
  type ParentRpcFileHandle, type ParentRpcWrite, type ParentRpcResult, type ParentRpcError,
} from './vfs/index.js';

// File checkpoints — the shadow-git snapshot seam (backends implement it)
export {
  DEFAULT_CHECKPOINT_KEEP, CHECKPOINTS_UNAVAILABLE_NO_GIT, summarizeRestorePlan,
  type FileCheckpoints, type CheckpointTurnMeta, type CheckpointAvailability,
  type FileCheckpointEntry, type FileRestoreChange, type FileRestoreKind,
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

// Sleep-time compute — between-turn background memory compression
// (Letta-style; ~50% test-time token reduction reported).
export {
  runSleepTimeCompute, applySleepTimeUpdate,
  type SleepTimeInput, type SleepTimeUpdate,
} from './memory/sleep-time-compute.js';

// durable run-event log (Flue-style, SSE-resumable)
// NOTE: superseded by the unified `events/hub/agent_log` table. The
// RunEventRecorder API stays as a thin façade over `agent_log` writes for
// SSE-stream compatibility. New code uses the EventsHub directly.
export type {
  RunEvent, RunEventBase, RunEventInput, RunEventType,
} from './events/index.js';
export {
  initRunEventTables,
  RunEventRecorder,
  type RunEventListener,
  type RunEventQuery,
} from './events/index.js';

// EventsHub — events / triggers / turn runner / reply channels.
// Spec: docs/EVENTS-HUB-SPEC.md. Builds the single agent_log ledger and the
// six load-bearing primitives (trust, reactor, channels, triggers, budget,
// turn orchestration).
export * from './events/hub/index.js';

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

// Wire constants shared by the cf-backend Worker and the CLI.
export {
  DEVICE_CONNECT_PATH,
  MAX_INLINE_ATTACHMENT_BYTES,
  ORCHESTRATOR_AGENT_SLUG,
  SUBORDINATE_AGENT_SLUG,
} from './cloud-wire.js';

// safety — approval gating for shell exec + digest-bound approvals
export {
  reviewCommand,
  formatApproval,
  withApprovalGate,
  type ApprovalDecision,
  type ApprovalRuleHit,
  type ApprovalResult,
  argumentDigest,
  sha256Hex,
  stableStringify,
} from './safety/index.js';

// Utils
export { nanoid } from './utils/nanoid.js';
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
  BudgetSplit, SerializedMessage,
} from './heads/index.js';
export {
  DEFAULT_HEAD_BUDGET, DEFAULT_MERGE_STRATEGY,
  deriveChildBudget, budgetExhausted,
  initHeadsTables,
  HeadJournal, type HeadJournalRow,
  HeadController, type HeadRuntime, type HeadGrounding, type SpawnedHead, type MergeLLMFn,
  type SplitPhaseEvent,
  MergeOutputSchema, EvidenceItemSchema, DecisionSchema, type MergeOutput,
  extractHeadSteps, extractFinalText, synthesizeHeadSummary,
  HeadCapture, runHeadInference, buildHeadAccumulatorTools, buildHeadSandboxTools,
  buildHeadWebTools, buildHeadSystemPrompt, buildHeadMessages, withHeadCaptureRecording,
  MAX_HEAD_STEPS,
  type HeadInferenceDeps, type HeadSandboxVfs,
} from './heads/index.js';

// Background-job system — auto-background >30s tool calls + wake-on-completion.
export {
  BackgroundJobStore, initBackgroundJobsTable, serializeJobResult, withBackgroundThreshold, isBackgroundHandle,
  BackgroundJobRunner, JobNotResumable, EVICTION_INTERRUPT_ERROR,
  type BackgroundJob, type BackgroundJobStatus, type BackgroundHandle, type ThresholdDeps,
  type BackgroundJobRunnerDeps, type JobResumer, type JobClaim,
} from './jobs/index.js';

// Backend-agnostic orchestration — per-turn accounting shared by both backends.
export {
  TurnAccumulator,
  type StepLike, type ToolResultLike, type TurnSinks,
} from './orchestrator/turn-accumulator.js';
export {
  AgentOrchestrator, type AgentOrchestratorDeps,
} from './orchestrator/agent-orchestrator.js';
export { EventInjectionBuffer, type SettledInjections } from './orchestrator/event-injection.js';
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
  type ScaffoldBridgeOpts, type ScaffoldHistoryQuery,
  type ScaffoldHistoryEntry, type ScaffoldHistoryPage,
} from './orchestrator/scaffold-host.js';
export { runSampledShadowEval, type ShadowEvalConfig } from './orchestrator/shadow-eval.js';
export {
  BACKGROUNDABLE_TOOLS, wrapToolsForBackground, resumeForkBackgroundJob,
} from './orchestrator/background-tools.js';
export { buildStrategyForkDeps, type ForkDepsWiring } from './orchestrator/fork-deps.js';
export { createDurableMctsSession } from './orchestrator/mcts-session.js';
export {
  skillsVfsOver, resolveTurnSkills, filterToolNamesBySkills, filterToolSetBySkills,
  renderFactsForTurn, type TurnSkillsConfig,
} from './orchestrator/turn-surface.js';
export { ModelCatalogSession } from './orchestrator/model-catalog.js';
export {
  serializeContentForHeads, narrowInheritedRole,
  inheritedContextFromHistory, INHERITED_CONTEXT_CAP,
} from './orchestrator/heads-support.js';
export { recordGroundedHeadsTake } from './mcts/takes.js';

// ── skills (Claude-Code / Hermes-compatible SKILL.md workflow store) ──
// VFS-backed under /workspace/skills/. A skill is natural-language workflow
// instructions + a tool-surface restriction (allowed_tools). Distinct from
// CraftedTools (executable JS): a skill steers the LLM; a crafted tool runs.
export {
  parseSkillFile, stringifySkillFile, validateSkillName,
  discoverSkills, skillPath, BUILTIN_SKILLS,
  resolveActiveSkills, extractExplicitInvocations,
  renderActiveSkillsSection, unionAllowedTools, toolAllowedBySkills,
  ACTIVE_SKILLS_MAX_CHARS,
  runSkillsAction, SkillError, SKILLS_DIR,
} from './skills/index.js';
export type {
  ParsedSkill, SkillSource, SkillIndexEntry, ActiveSkillSet,
  ActivationReason, SkillsAction, SkillParseResult, SkillErrorCode,
  SkillsVfs, DiscoverOpts, LoadActiveSkillsOpts,
  SkillsToolDeps, SkillsToolOutcome,
} from './skills/index.js';

// ── GEPA (Genetic-Pareto Prompt Evolution) ──
// Offline batch optimisation of any string-addressable agent artifact —
// scaffold sources, crafted tool implementations, system-prompt sections.
// Complementary to the runtime mutable-scaffold loop. Paper: Agrawal et
// al., ICLR 2026 (arxiv 2507.19457).
// Only the entry points + persistence + types are public; the algorithm
// internals (pareto, mutate, merge helpers) stay inside evolution/gepa.
export {
  runGepa, runScaffoldGepa, runCraftedToolGepa,
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
  RunCraftedToolGepaOpts, RunCraftedToolGepaResult,
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
