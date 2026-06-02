// ExplorationStrategy — single seam for "explore N candidate continuations,
// score them, return the best." MCTS, Heads, Tree-of-Thoughts, Reflexion,
// single-shot — all fit this shape.
//
// All strategies hide behind one `think(strategy, task, budget)` tool
// dispatching over a strategy registry, so the agent surface stays small and
// stable while new strategies (ToT, GoT, Reflexion, RLM-on-subtask) drop in as
// registry entries — no tool/UI/orchestrator changes.

import type { AgentRuntime } from '../types/agent-runtime.js';
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
  cost: { tokens?: number; durationMs: number; iterations?: number };
}

export interface ExplorationStrategy {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
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
