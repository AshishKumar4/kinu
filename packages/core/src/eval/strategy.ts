/**
 * The eval harness's strategy contract — "explore a task, return the best
 * answer with what it cost", as the one shape an A/B run compares two arms
 * through.
 *
 * IT LIVES HERE BECAUSE THE HARNESS IS ITS ONLY CONSUMER. It began in
 * `strategy/types.ts` as a plug-in seam: MCTS, Heads, single-shot and a
 * registry the agent's tool would dispatch over by id. No production path ever
 * built that registry — the `agents` tool runs `runSwarm` directly, and each
 * backend constructs its engines itself — so the registry and the three
 * adapters that implemented this interface (`strategy/{mcts,heads,single-shot}.ts`)
 * were removed. What remains is what `eval/runner.ts` and `scripts/eval.ts`
 * actually pass to each other, so it sits with them.
 *
 * The fields are therefore the harness's, not a generic search engine's: an
 * arm gets the task, the runtime and the model, and answers with candidates
 * and a cost. A caller wanting the tree search calls `runMCTS`; a caller
 * wanting the swarm calls `runSwarm`. Neither goes through here.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { LanguageModel } from 'ai';
import type { WorkMode } from '../prompting/surface';

export interface StrategyBudget {
  /** Generation cap for one arm's answer, in output tokens. */
}

export interface StrategyContext {
  task: string;
  /** Trusted parent work mode. An arm must preserve Plan's mutation bar. */
  mode: WorkMode;
  rt: AgentRuntime;
  /** Resolved language model for this arm. */
  model: LanguageModel;
  budget?: StrategyBudget;
  /** Conversation context an arm may want to see. */
  history?: ReadonlyArray<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  signal?: AbortSignal;
}

/** A candidate solution an arm produced. */
export interface StrategyCandidate {
  /** Free-form answer / proposal. */
  text: string;
  /** Quality score, normalized to [0..1]. */
  score: number;
  /** What produced this candidate (arm id, head id, node id, …). */
  source: string;
}

export interface StrategyResult {
  /** Strategy that produced the result. */
  strategy: string;
  /** Best candidate by score. */
  best: StrategyCandidate;
  /** All candidates considered (including pruned ones). */
  all: StrategyCandidate[];
  /** Cost summary — tokens, ms, iterations actually performed. */
  cost: {
    /** Provider-reported tokens for the whole run. ABSENT when nothing was
     *  reported, which is not the same claim as zero. */
    tokens?: number;
    durationMs: number;
    iterations?: number;
  };
}

export interface ExplorationStrategy {
  readonly id: string;
  explore(ctx: StrategyContext): Promise<StrategyResult>;
}
