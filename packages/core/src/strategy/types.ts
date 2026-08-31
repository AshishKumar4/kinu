// ExplorationStrategy — single seam for "explore N candidate continuations,
// score them, return the best." MCTS, Heads, Tree-of-Thoughts, Reflexion,
// single-shot — all fit this shape.
//
// All strategies hide behind the one `agents` tool's fork action
// dispatching over a strategy registry, so the agent surface stays small and
// stable while new strategies (ToT, GoT, Reflexion, RLM-on-subtask) drop in as
// registry entries — no tool/UI/orchestrator changes.

import type { AgentRuntime } from '../types/agent-runtime';
import type { MissionScope } from '../mission-budget';
import type { ModelCallSink } from '../events/model-call';
import type { CostModel } from '../mcts/cost';
import type { LanguageModel } from 'ai';
import type { WorkMode } from '../prompting/surface';
import type { JsonValue } from '../utils/json';

export type StrategyOptionValue = JsonValue | object;
export interface BuiltinStrategyOptions {
  mcts?: StrategyOptionValue;
  heads?: StrategyOptionValue;
}
export type StrategyOptions = ReadonlyMap<string, StrategyOptionValue> | BuiltinStrategyOptions;

export function strategyOption(
  options: StrategyOptions | undefined,
  key: string,
): StrategyOptionValue | undefined {
  if (options && 'get' in options) return options.get(key);
  if (key === 'mcts') return options?.mcts;
  if (key === 'heads') return options?.heads;
  return undefined;
}

export interface StrategyBudget {
  /** Max LLM calls / tree iterations / parallel heads, depending on strategy. */
  maxIterations?: number;
  /** Max wall-clock ms. */
  wallClockMs?: number;
  /** Max recursion depth for strategies that nest (RLM, ToT). */
  depth?: number;
}

export interface StrategyContext {
  task: string;
  /** Trusted parent work mode. Strategies must preserve Plan's mutation bar
   * across every head they spawn. */
  mode: WorkMode;
  rt: AgentRuntime;
  /** Resolved language model for this exploration. */
  model: LanguageModel;
  budget?: StrategyBudget;
  /** Conversation context that exploration may want to see. */
  history?: ReadonlyArray<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  /** Per-strategy options. Strategies validate their own shape. */
  options?: StrategyOptions;
  /**
   * The mission budget this exploration charges. `ctx.rt.llm` is already
   * governed for whatever reaches a model through it in THIS process; this is
   * for the work that does not — a head resolving its own model in another
   * facet, which the wrapper cannot reach. Absent = unbudgeted.
   */
  mission?: MissionScope;
  /**
   * Where the model calls this exploration makes are reported.
   *
   * Threaded exactly like `mission` above and for the same reason — the work is
   * not reachable from the governed `ctx.rt.llm` — but answering a different
   * question. The mission port is a CAP that stops opening new work once a
   * declared budget is spent, and it is a no-op when no mission label exists;
   * this is the LEDGER, and a search nobody labelled costs exactly as much as
   * one somebody did. So a strategy reports through this unconditionally, while
   * it charges the mission only when there is a mission.
   *
   * Absent = unreported, which the coverage fraction states rather than hides.
   */
  reportModelCall?: ModelCallSink;
  /**
   * The model this exploration runs on and what the catalog charges for it,
   * for any strategy that gates on projected spend before starting (MCTS's
   * `maxCostUSD`). Read lazily — the catalog lookup lands asynchronously.
   *
   * Absent = that gate prices at the blended fallback and states it. A gate
   * that treated absence as free would wave through the most expensive models
   * in the catalog, which is the worse of the two failures.
   */
  costModel?: () => CostModel;
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
    /** Provider-reported tokens for the whole exploration. ABSENT when nothing
     *  was reported, which is not the same claim as zero: the spawn seam
     *  charges an unmeasured fork nothing rather than billing it as free
     *  (tools/agents-tool.ts). */
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
