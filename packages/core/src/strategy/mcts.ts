// MCTS as an ExplorationStrategy.
//
// Wraps the existing `runMCTS` engine behind the StrategyContext/StrategyResult
// contract so callers (think tool, eval harness) can dispatch by strategy id
// instead of importing runMCTS directly.
//
// Per-strategy options (StrategyContext.options.mcts):
//   { branches?, maxDepth?, explorationWeight?, sessionWriter? }
import { runMCTS } from '../mcts/engine.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { ExplorationStrategy, StrategyContext, StrategyResult } from './types.js';
import type { SessionWriter } from '../mcts/record-node.js';

interface MCTSStrategyOptions {
  branches?: number;
  maxDepth?: number;
  explorationWeight?: number;
  pruneThreshold?: number;
  minAcceptableScore?: number;
  maxCostUSD?: number;
  /** SessionWriter for trajectory recording. Required (provided by caller). */
  session: SessionWriter;
}

export function createMCTSStrategy(): ExplorationStrategy {
  return {
    id: 'mcts',
    label: 'MCTS (parallel tree search)',
    description:
      'Monte Carlo Tree Search over parallel exploration branches. Best for ' +
      'multi-step planning where the right approach is not obvious upfront.',
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      const t0 = Date.now();
      const o = (ctx.options?.mcts ?? {}) as Partial<MCTSStrategyOptions>;
      if (!o.session) {
        throw new Error("MCTS strategy requires options.mcts.session (SessionWriter).");
      }
      const defaults = DEFAULT_CONFIG.mcts;
      const result = await runMCTS(ctx.rt, o.session, ctx.task, {
        budget: ctx.budget?.maxIterations ?? defaults.budget,
        branches: o.branches ?? defaults.branches,
        maxDepth: o.maxDepth ?? defaults.maxDepth,
        explorationWeight: o.explorationWeight ?? defaults.explorationWeight,
        pruneThreshold: o.pruneThreshold ?? defaults.pruneThreshold,
        minAcceptableScore: o.minAcceptableScore ?? defaults.minAcceptableScore,
        maxCostUSD: o.maxCostUSD ?? defaults.maxCostUSD,
      });
      // The winner's trajectory is the agent-readable answer.
      const text = result.trajectory.map(m => `${m.role}: ${m.content}`).join('\n');
      return {
        strategy: 'mcts',
        best: { text, payload: { winnerId: result.winnerId }, score: result.winnerValue, source: result.winnerId },
        all: [{ text, payload: result, score: result.winnerValue, source: result.winnerId }],
        cost: { durationMs: Date.now() - t0, iterations: ctx.budget?.maxIterations ?? defaults.budget },
        trace: `MCTS converged=${result.converged} winnerValue=${result.winnerValue.toFixed(3)}`,
      };
    },
  };
}
