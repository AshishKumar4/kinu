/**
 * AgentRuntime — the one struct the agent core receives.
 * Platform-specific; constructed by either CF or Linux backend.
 */

import type {
  Storage,
  Memory,
  Executor,
  LLM,
  Schedule,
  Identity,
  Shell,
} from './primitives.js';
import type { CraftedTool, CraftScoreEntry } from './craft.js';
import type { ExecutionRouter } from '../execution/types.js';
import type { FileCheckpoints } from '../checkpoints/types.js';

/** CraftStore interface — matches agent-utils CraftStore API */
export interface CraftStore {
  create(tool: Omit<CraftedTool, 'createdAt' | 'updatedAt'>): void;
  update(name: string, patch: Partial<CraftedTool>): void;
  get(name: string): CraftedTool | undefined;
  delete(name: string): void;
  list(): CraftedTool[];
  search(query: string, limit?: number): CraftedTool[];
  getAll(): CraftedTool[];
}

/**
 * A branch EXPLORES and reflects; it deliberately cannot score itself.
 * Scoring happens at the engine seam (mcts/engine.ts) through the grounded
 * evaluator, so no backend can reintroduce same-model self-rating.
 */
export interface BranchHandle {
  explore(
    priorHistory: Array<{ role: string; content: string }>,
    craftedTools: CraftedTool[],
    /** Distinct solution angles assigned to this branch's siblings in the same
     *  expansion. Threaded so each branch proposes something DISTINCT (MCTS
     *  branches explore in parallel and never see a sibling's output). Optional
     *  so backends/tests that don't enforce diversity still satisfy the type. */
    siblings?: readonly string[],
  ): Promise<{ text: string; codeUsed: string | null }>;
  generateReflection(task: string): Promise<string>;
}

/** Factory for creating isolated branch agents — injected by the backend */
export type SpawnBranch = (branchId: string) => Promise<BranchHandle>;
/** Factory for aborting a branch agent */
export type AbortBranch = (branchId: string, reason?: string) => Promise<void>;

export interface AgentRuntime {
  storage: Storage;
  memory: Memory;
  executor: Executor;
  llm: LLM;
  schedule: Schedule;
  identity: Identity;
  craftStore: CraftStore;
  /** Second LLM for cross-model judging (different model from the explorer) */
  judgeModel?: LLM;
  /**
   * The chat vendor's small tier, for MECHANICAL work — outcome
   * classification, pathology labels, one-sentence reflections, pattern
   * extraction, sleep-time compression. Same vendor, same credential, cheaper
   * model (providers/fast-model.ts selectFastModel).
   *
   * Optional, and every reader falls back to `llm`, so a backend that wires
   * none simply keeps today's behaviour. Never used for user-visible
   * generation or for anything that authors a scaffold: those stay on the
   * model the user chose.
   */
  fastLlm?: LLM;
  /** Platform-specific branch spawning — injected by CF or CLI backend */
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
  /**
   * Multi-executor routing. Manages named executor providers (workspace,
   * nimbus, sandbox, laptop) for the codemode sandbox. Optional — core
   * code that doesn't need multi-executor support ignores this field.
   */
  executionRouter?: ExecutionRouter;
  /**
   * POSIX shell bound to the agent's VFS. Supplied by the backend adapter
   * (CF: createShell(sqliteFS); CLI: createShell(sqliteFS)). The `run` tool
   * reads this directly for workspace-scoped commands; absence degrades to
   * router-only routing.
   */
  shell?: Shell;
  /**
   * Shadow-git file checkpoints over REAL filesystems (the local exec cwd /
   * device project dirs). Backends with host filesystem access supply an
   * engine; absence simply means no /undo for that backend's file surface.
   */
  checkpoints?: FileCheckpoints;
}
