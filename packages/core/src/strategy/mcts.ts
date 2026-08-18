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
import * as v from 'valibot';
import { runMCTS } from '../mcts/engine';
import { DEFAULT_CONFIG } from '../config';
import { strategyOption, type ExplorationStrategy, type StrategyContext, type StrategyResult } from './types';
import type { SessionWriter } from '../mcts/record-node';
import { MctsSearchStore } from '../mcts/search-store';
import type { MCTSProgressEvent } from '../types/mcts';

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

const SessionWriterSchema = v.custom<SessionWriter>((input) => v.safeParse(v.object({
  appendMessage: v.function(),
  getHistory: v.function(),
}), input).success);
const ProgressSinkSchema = v.custom<(event: MCTSProgressEvent) => void>(
  (input) => v.safeParse(v.function(), input).success,
);
const MCTSStrategyOptionsSchema: v.GenericSchema<Partial<MCTSStrategyOptions>> = v.object({
  budget: v.optional(v.number()),
  branches: v.optional(v.number()),
  maxDepth: v.optional(v.number()),
  explorationWeight: v.optional(v.number()),
  pruneThreshold: v.optional(v.number()),
  minAcceptableScore: v.optional(v.number()),
  maxCostUSD: v.optional(v.number()),
  judgeSamples: v.optional(v.number()),
  maxEvalLLMCalls: v.optional(v.number()),
  takesEpsilon: v.optional(v.number()),
  session: v.optional(SessionWriterSchema),
  search: v.optional(v.instance(MctsSearchStore)),
  onProgress: v.optional(ProgressSinkSchema),
});

export function createMCTSStrategy(): ExplorationStrategy {
  return {
    id: 'mcts',
    label: 'MCTS (parallel tree search)',
    description:
      'Monte Carlo Tree Search: compare competing approaches when the right path ' +
      'is unclear. Build branches are execution-grounded; Plan branches remain read-only ' +
      'and compare planning alternatives without executing proposals or evolving state.',
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      const t0 = Date.now();
      const o = v.parse(MCTSStrategyOptionsSchema, strategyOption(ctx.options, 'mcts') ?? {});
      if (!o.session) {
        throw new Error("MCTS strategy requires options.mcts.session (SessionWriter).");
      }
      const defaults = DEFAULT_CONFIG.mcts;
      const budget = ctx.budget?.maxIterations ?? o.budget ?? defaults.budget;
      const result = await runMCTS(ctx.rt, o.session, ctx.task, {
        mode: ctx.mode,
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
        search: o.search,
        onProgress: o.onProgress,
        // Branch rollouts resolve their own model in another process, so the
        // governed `ctx.rt.llm` never sees them; the engine debits each rollout
        // from the report that comes back with it and stops opening expansions
        // once the ledger is spent.
        mission: ctx.mission,
        // Asked of every rollout whether or not a mission labelled this search:
        // the debit above is a cap, this is the ledger.
        reportModelCall: ctx.reportModelCall,
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
          selfMetered: ctx.mission ? true : undefined,
        },
        trace: `MCTS converged=${result.converged} winnerValue=${result.winnerValue.toFixed(3)}`,
      };
    },
  };
}
