// Eval-harness A/B arm contract; its only consumers are `eval/runner.ts` and `scripts/eval.ts`.

import type { AgentRuntime } from '../types/agent-runtime';
import type { LanguageModel } from 'ai';
import type { WorkMode } from '../types/turn';

export interface StrategyContext {
  task: string;
  /** Trusted parent work mode. An arm must preserve Plan's mutation bar. */
  mode: WorkMode;
  rt: AgentRuntime;
  model: LanguageModel;
  history?: ReadonlyArray<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  signal?: AbortSignal;
}

export interface StrategyCandidate {
  text: string;
  /** Normalized to [0..1]. */
  score: number;
  /** What produced this candidate (arm id, head id, node id, …). */
  source: string;
}

export interface StrategyResult {
  strategy: string;
  best: StrategyCandidate;
  /** Includes pruned candidates. */
  all: StrategyCandidate[];
  cost: {
    /** Absent when nothing was reported, which is not zero. */
    tokens?: number;
    durationMs: number;
    iterations?: number;
  };
}

export interface ExplorationStrategy {
  readonly id: string;
  explore(ctx: StrategyContext): Promise<StrategyResult>;
}
