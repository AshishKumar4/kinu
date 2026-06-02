// @proteus/core — barrel export

// Identity system
export { initAllTables } from './identity/schema.js';
export { readSoul, writeSoul } from './identity/soul.js';
export { createAgent, wrapDatabase, type AgentBirthConfig, type AgentDatabase } from './identity/create.js';
export { openAgent, type AgentResumeConfig, type AgentInfo } from './identity/open.js';
export { forkAgentStorage, readForkLineage, type ForkOpts, type ForkResult, type ForkLineageRow } from './identity/fork.js';

// Evolution engine (3-timescale auto-evolution)
export { EvolutionEngine, feedbackToQuality } from './evolution/engine.js';
export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig, type EvolutionEvent, type EvolutionListener,
  type CompletedTurn, type CompletedSession, type ToolCallRecord,
} from './evolution/types.js';
// Canonical `buildBuiltinTools` is exported below. The legacy
// `buildAgentTools` surface has been removed.

// Configuration
export { DEFAULT_CONFIG, DEFAULT_MAX_STEPS, mergeConfig, resolveMaxSteps } from './config.js';
export type { AgentConfig, MCTSDefaults, CraftStoreDefaults, ScaffoldDefaults } from './config.js';

// Typed accessors over the `agent_config` key/value table — collapses ~23
// raw-SQL sites into a deep module with known-key getters/setters.
export {
  createAgentConfigStore, initAgentConfigTable,
  AGENT_CONFIG_KEYS,
  type AgentConfigStore, type AgentConfigKey, type ShellApprovalMode,
} from './config/index.js';

// Types
export type * from './types/primitives.js';
export type * from './types/agent-runtime.js';
export type * from './types/backend-host.js';
export type * from './types/mcts.js';
export type * from './types/craft.js';
export type * from './types/scaffold.js';
export type * from './types/evaluation.js';

// Chat engine (shared between server and CLI)
export { runChat, type ChatEvent, type ChatOptions } from './chat.js';

// LLM (Vercel AI SDK wrapper — shared across backends)
export { createVercelAILLM, collectStepText, createChatModel } from './llm.js';
export type { LLMProviderConfig, ChatModelConfig } from './llm.js';

// Canonical tool registry + factories (shared across CF and CLI)
export {
  BUILTIN_TOOLS,
  ACTIVE_TOOLS,
  BUILTIN_TOOL_NAMES,
  BUILTIN_TOOL_DESCRIPTIONS,
  type BuiltinToolName,
} from './tools/registry.js';
export { buildBuiltinTools, type BuiltinToolDeps } from './tools/builtins.js';
export {
  codegenDisallowed,
  toCraftedToolSource,
  type CraftedToolExecute,
  type CraftedToolExecuteFn,
  type CraftedToolSource,
} from './tools/crafted-executor.js';
export { buildSystemPrompt, buildSystemPromptSync, FALLBACK_PURPOSE, type SystemPromptOptions } from './prompt.js';

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
export { pruneAndReflect } from './mcts/pruning.js';
export { evaluateWithMultiModelJudging } from './mcts/evaluation.js';
// Process Reward Models — step-level scoring for fine-grained MCTS pruning
// and scaffold runtime early-termination.
export {
  scoreStepWithJudge, blendStepScore,
  type StepScore, type StepScoreInput,
} from './mcts/step-prm.js';
export { estimateCost } from './mcts/cost.js';

// Schemas
export { initSearchTables } from './mcts/schemas.js';
export { initScaffoldTables } from './scaffold/schemas.js';
export { initCraftScoreTables } from './craft/schemas.js';

// Scaffold management
export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap.js';
export { modifyScaffold } from './scaffold/modify.js';
export { rollbackScaffold } from './scaffold/rollback.js';
// scaffold execution + shadow-mode rollout
export {
  runScaffold,
  type ScaffoldRunOptions,
  type ScaffoldRunResult,
  type ScaffoldEvent,
  type ScaffoldEmitFn,
} from './scaffold/executor.js';
export { scaffoldEventsToUIStream } from './scaffold/ui-stream.js';
export {
  initShadowTables,
  getPendingScaffold,
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
} from './scaffold/shadow.js';
// auto-judge shadow evaluation — sampled-per-turn closure of the
// shadow-rollout loop. Picks up pending scaffolds, runs them against the
// same task, asks a judge LLM to compare, records the result, optionally
// auto-applies promotion/rollback when minTrials is reached.
export {
  runAutoShadowEval,
  JudgeOutputSchema,
  DEFAULT_AUTO_JUDGE_CONFIG,
  type AutoJudgeConfig,
  type AutoShadowEvalResult,
  type JudgeOutput,
  type StructuredJudgeFn,
  type RunAutoShadowEvalOpts,
} from './scaffold/auto-judge.js';

// CraftStore quality
export { emaUpdate, effectiveScore, updateCraftScores } from './craft/ema.js';
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
  createSSHTunnelExecutor, type DeviceTransport,
  DeviceTunnel, type TunnelSocket, TUNNEL_DISCONNECTED,
  // Legacy (shelved) — kept for type imports only.
  createNimbusExecutor, type NimbusExecutorOpts,
  type ExecutorCapability, type ExecutorKind, type ExecutorProvider,
  type ExecutorInfo, type ExecutionRouter, type InlineExecutorDeps,
} from './execution/index.js';

// Vectorize-backed semantic memory (Workers AI embeddings + hybrid retrieval)
export {
  reciprocalRankFusion,
  createCloudflareVectorStore,
  createWorkersAIEmbedder,
  createNoopVectorStore,
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
  type LexicalHit,
  type HybridHit,
  type LexicalSearchFn,
  type HybridSearchOptions,
} from './memory/hybrid-search.js';

// Memory write primitive — single canonical "save a note to MEMORY.md".
// Used by workspace.saveNote, the `memory` builtin tool, and MCP saveNoteFromMcp.
export { appendMemoryNote } from './memory/note.js';

// agent_facts — typed, idempotent, keyed world-model store. Built on DO SQL.
// Top-K recent facts are auto-rendered into the system prompt every turn.
export {
  initFactsTable, createFactsStore, renderFactsBlock,
  type Fact, type FactsStore,
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

// InferenceLoop — universal contract for "run a turn." Adapts Think /
// scaffold / Heads / RLM behind one AsyncIterable<RunEvent> stream.
export * from './loops/types.js';

// ExplorationStrategy — single seam for "search candidate continuations,
// score, pick best." MCTS / Heads / ToT / Reflexion / single-shot fit this.
export * from './strategy/index.js';

// Eval harness — A/B test arbitrary strategies/loops on a corpus of tasks.
export * from './eval/index.js';

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

// safety — approval gating for shell exec
export {
  reviewCommand,
  formatApproval,
  withApprovalGate,
  type ApprovalDecision,
  type ApprovalRuleHit,
  type ApprovalResult,
} from './safety/index.js';

// Utils
export { nanoid } from './utils/nanoid.js';
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
  SplitRequest, MergeResult, MergeStrategy,
  BudgetSplit, SerializedMessage,
} from './heads/index.js';
export {
  DEFAULT_HEAD_BUDGET, DEFAULT_MERGE_STRATEGY,
  deriveChildBudget, budgetExhausted,
  initHeadsTables,
  HeadJournal, type HeadJournalRow,
  HeadController, type HeadRuntime, type SpawnedHead, type MergeLLMFn,
  type SplitPhaseEvent,
  MergeOutputSchema, EvidenceItemSchema, DecisionSchema, type MergeOutput,
} from './heads/index.js';

// Background-job system — auto-background >30s tool calls + wake-on-completion.
export {
  BackgroundJobStore, initBackgroundJobsTable, serializeJobResult, withBackgroundThreshold, isBackgroundHandle,
  type BackgroundJob, type BackgroundJobStatus, type BackgroundHandle, type ThresholdDeps,
} from './jobs/index.js';

// ── skills (Claude-Code / Hermes-compatible SKILL.md workflow store) ──
// VFS-backed under /workspace/skills/. A skill is natural-language workflow
// instructions + a tool-surface restriction (allowed_tools). Distinct from
// CraftedTools (executable JS): a skill steers the LLM; a crafted tool runs.
export {
  parseSkillFile, stringifySkillFile, validateSkillName,
  discoverSkills, skillPath, BUILTIN_SKILLS,
  resolveActiveSkills, extractExplicitInvocations,
  renderActiveSkillsSection, unionAllowedTools, toolAllowedBySkills,
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

