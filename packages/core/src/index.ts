// @proteus/core — barrel export

// Identity system
export { initAllTables } from './identity/schema.js';
export { readSoul, writeSoul } from './identity/soul.js';
export { createAgent, wrapDatabase, type AgentBirthConfig, type AgentDatabase } from './identity/create.js';
export { openAgent, type AgentResumeConfig, type AgentInfo } from './identity/open.js';
export { forkAgentStorage, readForkLineage, type ForkOpts, type ForkResult, type ForkLineageRow } from './identity/fork.js';

// Evolution engine (3-timescale auto-evolution)
export { EvolutionEngine } from './evolution/engine.js';
export {
  DEFAULT_EVOLUTION_CONFIG,
  type EvolutionConfig, type EvolutionEvent, type EvolutionListener,
  type CompletedTurn, type CompletedSession, type ToolCallRecord,
} from './evolution/types.js';
// v2.0: legacy `buildAgentTools` (6-tool surface) removed in favor of the
// canonical `buildBuiltinTools` exported below. See docs/V2-MIGRATION.md.

// Configuration
export { DEFAULT_CONFIG, DEFAULT_MAX_STEPS, mergeConfig, resolveMaxSteps } from './config.js';
export type { AgentConfig, MCTSDefaults, CraftStoreDefaults, ScaffoldDefaults } from './config.js';

// Types
export type * from './types/primitives.js';
export type * from './types/agent-runtime.js';
export type * from './types/mcts.js';
export type * from './types/craft.js';
export type * from './types/scaffold.js';
export type * from './types/evaluation.js';

// Chat engine (shared between server and CLI)
export { runChat, type ChatEvent, type ChatOptions } from './chat.js';

// LLM (Vercel AI SDK wrapper — shared across backends)
export { createVercelAILLM, collectStepText, createChatModel } from './llm.js';
export type { LLMProviderConfig, ChatModelConfig } from './llm.js';

// Canonical tool registry + factories (v2.0 — shared across CF and CLI)
export {
  BUILTIN_TOOLS,
  SESSION_TOOLS,
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
export { buildSystemPrompt, buildSystemPromptSync, type SystemPromptOptions } from './prompt.js';

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
export { estimateCost } from './mcts/cost.js';

// Schemas
export { initSearchTables } from './mcts/schemas.js';
export { initScaffoldTables } from './scaffold/schemas.js';
export { initCraftScoreTables } from './craft/schemas.js';

// Scaffold management
export { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from './scaffold/bootstrap.js';
export { modifyScaffold } from './scaffold/modify.js';
export { rollbackScaffold } from './scaffold/rollback.js';
export { runCanary, checkErrorRateAndRollbackIfNeeded } from './scaffold/staged-rollout.js';

// CraftStore quality
export { emaUpdate, effectiveScore, updateCraftScores } from './craft/ema.js';
export { maybeStoreCraftedTool } from './craft/discovery.js';
export { periodicCraftConsolidation } from './craft/consolidation.js';
export { checkConflictsBeforeAdding, upsertCraftedTool } from './craft/conflict.js';
export { migrateCraftedToolDuplicates, type MigrationReport } from './craft/migrate-duplicates.js';

// Execution layer
export {
  DefaultExecutionRouter,
  createInlineExecutor,
  createSandboxExecutor, type SandboxHandle,
  createSSHTunnelExecutor,
  // Legacy (shelved) — kept for type imports only.
  createNimbusExecutor, type NimbusStub,
  createContainerExecutor, type ContainerStub,
  type ExecutorCapability, type ExecutorKind, type ExecutorProvider,
  type ExecutorInfo, type ExecutionRouter, type InlineExecutorDeps,
} from './execution/index.js';

// Utils
export { nanoid } from './utils/nanoid.js';
export { isoDate, today, nowMs } from './utils/date.js';

// ── v2: unified sandbox abstraction (SandboxApi + impls) ──────────
// Strict typed contract for any execution environment. Each implementation
// (Virtual/Cloudflare/Nimbus/SSH) is one file; `sandboxToExecutorProvider`
// bridges to the existing codemode ExecutorProvider surface so legacy
// callers keep working.
export type {
  SandboxApi, SandboxFactory, SandboxRegistry, SandboxBuildContext,
  SandboxKind, SandboxCapability,
  ShellResult, ExecOptions, DirEntry, Stat, PortInfo,
  SpawnOptions, ProcessHandle, PtyHandle,
} from './sandbox/index.js';
export { SandboxError, isSandboxError, DefaultSandboxRegistry, sandboxToExecutorProvider } from './sandbox/index.js';
export {
  createVirtualSandbox, type VirtualSandboxDeps,
  createCloudflareSandbox, type CloudflareSandboxDeps,
  createNimbusSandbox, type NimbusSandboxOpts,
  createSSHSandbox, type SSHSandboxApi,
} from './sandbox/index.js';
