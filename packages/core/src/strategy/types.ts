// ExplorationStrategy — single seam for "explore N candidate continuations,
// score them, return the best." MCTS, Heads, Tree-of-Thoughts, Reflexion,
// single-shot — all fit this shape.
//
// All strategies hide behind the one `agents` tool's fork action
// dispatching over a strategy registry, so the agent surface stays small and
// stable while new strategies (ToT, GoT, Reflexion, RLM-on-subtask) drop in as
// registry entries — no tool/UI/orchestrator changes.

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { MissionScope } from '../mission-budget.js';
import type { LanguageModel } from 'ai';

export interface StrategyBudget {
  /** Max LLM calls / tree iterations / parallel heads, depending on strategy. */
  maxIterations?: number;
  /** Max wall-clock ms. */
  wallClockMs?: number;
  /** Max recursion depth for strategies that nest (RLM, ToT). */
  depth?: number;
  /** Max OUTPUT tokens per LLM generation (generation length — NOT the loop
   *  count; never reuse maxIterations for this). */
  maxOutputTokens?: number;
}

export interface StrategyContext {
  task: string;
  rt: AgentRuntime;
  /** Resolved language model for this exploration. */
  model: LanguageModel;
  budget?: StrategyBudget;
  /** Conversation context that exploration may want to see. */
  history?: ReadonlyArray<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  /** Per-strategy options. Strategies validate their own shape. */
  options?: Record<string, unknown>;
  /**
   * The mission budget this exploration charges. `ctx.rt.llm` is already
   * governed for whatever reaches a model through it in THIS process; this is
   * for the work that does not — a head resolving its own model in another
   * facet, which the wrapper cannot reach. Absent = unbudgeted.
   */
  mission?: MissionScope;
  signal?: AbortSignal;
}

/** A candidate solution found during exploration. */
export interface StrategyCandidate {
  /** Free-form answer / proposal. */
  text: string;
  /** Optional structured payload (e.g. MCTS node id, head report). */
  payload?: unknown;
  /** Quality score, normalized to [0..1]. */
  score: number;
  /** What produced this candidate (head id, node id, etc.). */
  source: string;
}

export interface StrategyResult {
  /** Strategy that produced the result. */
  strategy: string;
  /** Best candidate by score. */
  best: StrategyCandidate;
  /** All candidates considered (including pruned ones). */
  all: StrategyCandidate[];
  /** Free-form trace the LLM can use to follow what happened. */
  trace?: string;
  /** Cost summary — tokens, ms, iterations actually performed. */
  cost: {
    tokens?: number;
    durationMs: number;
    iterations?: number;
    /**
     * True when these tokens were ALREADY charged to the mission ledger by the
     * strategy itself. Heads do, per step, from the process that made each
     * call; the fork seam then records only the spawn, so spend is never
     * counted twice. A strategy whose work is not reachable from the ledger
     * leaves this unset and is charged the lump.
     */
    selfMetered?: boolean;
    /**
     * Distinct files the exploration changed — what it cost the WORKSPACE
     * rather than the ledger. Absent when the strategy changed no files or
     * cannot attribute the ones it did (see heads/file-changes.ts), which is
     * not the same claim as zero.
     */
    filesChanged?: number;
  };
}

export interface ExplorationStrategy {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
  /** Default true. False = registered for programmatic/eval use (the think
   *  tool still dispatches it by id) but omitted from the LLM-visible enum
   *  and docstring — e.g. the single-shot baseline, which a chat model never
   *  needs (it IS a single shot). */
  readonly advertised?: boolean;
  explore(ctx: StrategyContext): Promise<StrategyResult>;
}

export interface StrategyRegistry {
  register(strategy: ExplorationStrategy): void;
  get(id: string): ExplorationStrategy | undefined;
  list(): ExplorationStrategy[];
}

export function createStrategyRegistry(): StrategyRegistry {
  const byId = new Map<string, ExplorationStrategy>();
  const ordered: ExplorationStrategy[] = [];
  return {
    register(strategy) {
      if (byId.has(strategy.id)) throw new Error(`ExplorationStrategy ${strategy.id} already registered`);
      byId.set(strategy.id, strategy);
      ordered.push(strategy);
    },
    get(id) { return byId.get(id); },
    list() { return [...ordered]; },
  };
}
