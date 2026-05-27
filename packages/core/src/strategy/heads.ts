// Branching Heads as an ExplorationStrategy.
//
// Wraps HeadController.run behind the StrategyContext/StrategyResult shape.
// Per-strategy options (StrategyContext.options.heads):
//   { controller: HeadController, heads: SplitRequest['heads'],
//     mergeStrategy?, mergeModel?, maxDepth?, inheritedContext? }
import type { HeadController } from '../heads/controller.js';
import type {
  HeadBudget, SerializedMessage, SplitRequest, MergeStrategy,
} from '../heads/types.js';
import { DEFAULT_HEAD_BUDGET } from '../heads/types.js';
import type { ExplorationStrategy, StrategyContext, StrategyResult } from './types.js';

interface HeadsStrategyOptions {
  controller: HeadController;
  heads: SplitRequest['heads'];
  mergeStrategy?: MergeStrategy;
  mergeModel?: string;
  maxDepth?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
  inheritedContext?: SerializedMessage[];
  defaultModel?: string;
}

export function createHeadsStrategy(): ExplorationStrategy {
  return {
    id: 'heads',
    label: 'Branching heads (parallel reasoning + merge)',
    description:
      'Spawn 2–6 parallel reasoning heads, each exploring a distinct angle of the task. ' +
      'Heads may use heterogeneous models. Findings are merged via structured LLM synthesis.',
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      const t0 = Date.now();
      const o = (ctx.options?.heads ?? {}) as Partial<HeadsStrategyOptions>;
      if (!o.controller) {
        throw new Error('Heads strategy requires options.heads.controller (HeadController).');
      }
      if (!o.heads || o.heads.length === 0) {
        throw new Error('Heads strategy requires options.heads.heads (array of head specs).');
      }

      const parentBudget: HeadBudget = {
        ...DEFAULT_HEAD_BUDGET,
        maxDepth: o.maxDepth ?? DEFAULT_HEAD_BUDGET.maxDepth,
        maxTokens: o.maxTokens ?? DEFAULT_HEAD_BUDGET.maxTokens,
        maxWallClockMs: o.maxWallClockMs ?? ctx.budget?.wallClockMs ?? DEFAULT_HEAD_BUDGET.maxWallClockMs,
        spawnedAt: Date.now(),
      };

      const merge = await o.controller.run({
        parentHeadId: null,
        inheritedContext: o.inheritedContext ?? [],
        request: {
          rationale: ctx.task,
          heads: o.heads,
          mergeStrategy: o.mergeStrategy,
          mergeModel: o.mergeModel,
        },
        parentBudget,
        model: o.defaultModel,
      });

      const candidates = merge.headIds.map((id) => ({
        text: merge.mergedNarrative,
        payload: { headId: id, recommendations: merge.recommendations, unresolved: merge.unresolvedQuestions },
        score: 1 - Math.min(0.5, merge.unresolvedQuestions.length * 0.1),
        source: id,
      }));

      return {
        strategy: 'heads',
        best: {
          text: merge.mergedNarrative,
          payload: merge,
          score: candidates[0]?.score ?? 1,
          source: 'merge',
        },
        all: candidates,
        cost: {
          tokens: merge.costSummary.totalTokens,
          durationMs: Date.now() - t0,
          iterations: merge.costSummary.headCount,
        },
        trace: `Heads(n=${merge.headIds.length}) → merge(strategy=${o.mergeStrategy ?? 'synthesize'})`,
      };
    },
  };
}
