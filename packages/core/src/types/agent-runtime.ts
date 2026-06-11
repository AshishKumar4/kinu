/**
 * AgentRuntime — the one struct the agent core receives.
 * Platform-specific; constructed by either CF or Linux backend.
 *
 * Architecture reference: final-architecture.md §3
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
}
