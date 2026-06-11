// MCTS as an ExplorationStrategy.
//
// Wraps the existing `runMCTS` engine behind the StrategyContext/StrategyResult
// contract so callers (think tool, eval harness) can dispatch by strategy id
// instead of importing runMCTS directly.
//
// Per-strategy options (StrategyContext.options.mcts):
//   { budget?, branches?, maxDepth?, explorationWeight?, session }
// The host injects the operator's stored MCTS overrides
// (AgentConfigStore.getMctsOverrides) alongside the session; an explicit
// caller budget (ctx.budget.maxIterations) still wins.
import { runMCTS } from '../mcts/engine.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { ExplorationStrategy, StrategyContext, StrategyResult } from './types.js';
import type { SessionWriter } from '../mcts/record-node.js';

interface MCTSStrategyOptions {
  /** Default iteration budget when the caller doesn't pass one explicitly. */
  budget?: number;
  branches?: number;
  maxDepth?: number;
  explorationWeight?: number;
  pruneThreshold?: number;
  minAcceptableScore?: number;
  maxCostUSD?: number;
  judgeSamples?: number;
  maxEvalLLMCalls?: number;
  takesEpsilon?: number;
  /** SessionWriter for trajectory recording. Required (provided by caller). */
  session: SessionWriter;
}

export function createMCTSStrategy(): ExplorationStrategy {
  return {
    id: 'mcts',
    label: 'MCTS (parallel tree search)',
    description:
      'Monte Carlo Tree Search: compare competing approaches when the right path ' +
      'is unclear. Branches propose text + code but cannot run tools mid-exploration; ' +
      'proposed code IS executed during scoring, so runnable proposals score honestly.',
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      const t0 = Date.now();
      const o = (ctx.options?.mcts ?? {}) as Partial<MCTSStrategyOptions>;
      if (!o.session) {
        throw new Error("MCTS strategy requires options.mcts.session (SessionWriter).");
      }
      const defaults = DEFAULT_CONFIG.mcts;
      const budget = ctx.budget?.maxIterations ?? o.budget ?? defaults.budget;
      const result = await runMCTS(ctx.rt, o.session, ctx.task, {
        budget,
        branches: o.branches ?? defaults.branches,
        maxDepth: o.maxDepth ?? defaults.maxDepth,
        explorationWeight: o.explorationWeight ?? defaults.explorationWeight,
        pruneThreshold: o.pruneThreshold ?? defaults.pruneThreshold,
        minAcceptableScore: o.minAcceptableScore ?? defaults.minAcceptableScore,
        maxCostUSD: o.maxCostUSD ?? defaults.maxCostUSD,
        judgeSamples: o.judgeSamples ?? defaults.judgeSamples,
        maxEvalLLMCalls: o.maxEvalLLMCalls ?? defaults.maxEvalLLMCalls,
        takesEpsilon: o.takesEpsilon ?? defaults.takesEpsilon,
        signal: ctx.signal,
      });
      // The winner's trajectory is the agent-readable answer.
      const text = result.trajectory.map(m => `${m.role}: ${m.content}`).join('\n');
      return {
        strategy: 'mcts',
        best: { text, payload: { winnerId: result.winnerId }, score: result.winnerValue, source: result.winnerId },
        all: [{ text, payload: result, score: result.winnerValue, source: result.winnerId }],
        cost: { durationMs: Date.now() - t0, iterations: budget },
        trace: `MCTS converged=${result.converged} winnerValue=${result.winnerValue.toFixed(3)}`,
      };
    },
  };
}
