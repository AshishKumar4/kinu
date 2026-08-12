// MCTS as an ExplorationStrategy.
//
// Wraps the existing `runMCTS` engine behind the StrategyContext/StrategyResult
// contract so callers (the agents tool's fork action, eval harness) can dispatch by strategy id
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
import type { MctsSearchStore } from '../mcts/search-store.js';
import type { MCTSProgressEvent } from '../types/mcts.js';

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
  /** Durable search checkpoint (host-injected) — enables evict-resume (B6). */
  search?: MctsSearchStore;
  /** Per-iteration progress sink (host-injected). This is what makes a running
   *  search visible: without it the tree only changes when something polls. */
  onProgress?: (event: MCTSProgressEvent) => void;
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
        ...(o.search ? { search: o.search } : {}),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        // Branch rollouts resolve their own model in another process, so the
        // governed `ctx.rt.llm` never sees them; the engine debits each rollout
        // from the report that comes back with it and stops opening expansions
        // once the ledger is spent.
        ...(ctx.mission ? { mission: ctx.mission } : {}),
      });
      // The winner's trajectory is the agent-readable answer.
      const text = result.trajectory.map(m => `${m.role}: ${m.content}`).join('\n');
      return {
        strategy: 'mcts',
        best: { text, payload: { winnerId: result.winnerId }, score: result.winnerValue, source: result.winnerId },
        all: [{ text, payload: result, score: result.winnerValue, source: result.winnerId }],
        cost: {
          durationMs: Date.now() - t0,
          iterations: budget,
          // Every rollout was debited as it returned (mcts/engine.ts), so the
          // fork seam must record the spawn and nothing else.
          ...(ctx.mission ? { selfMetered: true } : {}),
        },
        trace: `MCTS converged=${result.converged} winnerValue=${result.winnerValue.toFixed(3)}`,
      };
    },
  };
}
