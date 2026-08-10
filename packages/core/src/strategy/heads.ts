// Branching Heads as an ExplorationStrategy.
//
// Wraps HeadController.run behind the StrategyContext/StrategyResult shape.
// Per-strategy options (StrategyContext.options.heads):
//   { controller: HeadController, heads: SplitRequest['heads'],
//     mergeStrategy?, mergeModel?, maxDepth?, inheritedContext?, onPhase? }
// `controller`, `inheritedContext` and `onPhase` are host-injected (via the
// agents tool's fork defaultOptions); `heads` / `mergeStrategy` come from the LLM.
import type { HeadController, SplitPhaseEvent } from '../heads/controller.js';
import type {
  HeadBudget, SerializedMessage, SplitRequest, MergeStrategy, MergeResult,
} from '../heads/types.js';
import { DEFAULT_HEAD_BUDGET, DEFAULT_MERGE_STRATEGY } from '../heads/types.js';
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
  /** Host event sink — fires once on split (real head ids) and once on merge. */
  onPhase?: (event: SplitPhaseEvent) => void;
  /** Host hook fired once the merge completes, carrying the full MergeResult
   *  (per-head grounded scores + texts) and the split task. The host records an
   *  Alternate-Takes set from the comparable heads so the pick lands in the
   *  preference ledger — injected by the agents tool's fork defaultOptions, like onPhase. */
  onComplete?: (merge: MergeResult, task: string) => void;
}

/** The ephemeral-fork rung of the delegation ladder — the strategy an
 *  `agents` fork settles by when the caller names none (settle=merge). */
export const FORK_STRATEGY_ID = 'heads';

export function createHeadsStrategy(): ExplorationStrategy {
  return {
    id: FORK_STRATEGY_ID,
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
        throw new Error('Heads strategy requires `heads` (an array of 2–6 head specs).');
      }

      const strategy: MergeStrategy = o.mergeStrategy ?? DEFAULT_MERGE_STRATEGY;
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
          mergeStrategy: strategy,
          mergeModel: o.mergeModel,
        },
        parentBudget,
        model: o.defaultModel,
        onPhase: o.onPhase,
      });

      o.onComplete?.(merge, ctx.task);

      const formatted = formatMergeResult(merge, strategy);
      // Real grounded outcome per head (execution-banded when the head left
      // runnable code, else median judge). When the controller has no grounding
      // seam, merge.grounded is false and the scores are neutral 0.5 — an honest
      // "no signal" rather than the old unresolved-question formatting heuristic.
      const NEUTRAL = 0.5;
      const scoreById = new Map(merge.headScores.map((s) => [s.id, s.score]));
      const candidates = merge.headIds.map((id) => ({
        text: merge.mergedNarrative,
        payload: { headId: id, recommendations: merge.recommendations, unresolved: merge.unresolvedQuestions },
        score: scoreById.get(id) ?? NEUTRAL,
        source: id,
      }));
      // The merge represents the strongest thread that fed it.
      const bestScore = merge.grounded && merge.headScores.length > 0
        ? Math.max(...merge.headScores.map((s) => s.score))
        : NEUTRAL;

      return {
        strategy: 'heads',
        best: {
          text: formatted,
          payload: merge,
          score: bestScore,
          source: 'merge',
        },
        all: candidates,
        cost: {
          tokens: merge.costSummary.totalTokens,
          durationMs: Date.now() - t0,
          iterations: merge.costSummary.headCount,
        },
        trace: `Heads(n=${merge.headIds.length}) → merge(strategy=${strategy})`,
      };
    },
  };
}

/** Render a MergeResult into the agent-readable narrative the LLM continues
 *  its turn from: the synthesized narrative plus selected decisions, open
 *  questions, recommendations, and a one-line cost summary. */
function formatMergeResult(result: MergeResult, strategy: MergeStrategy): string {
  const lines: string[] = [];
  lines.push(result.mergedNarrative);
  if (result.selectedDecisions.length > 0) {
    lines.push('');
    lines.push('### Selected decisions');
    for (const d of result.selectedDecisions) {
      lines.push(`- **${d.question}** → ${d.choice} _(${d.rationale})_`);
    }
  }
  if (result.unresolvedQuestions.length > 0) {
    lines.push('');
    lines.push('### Unresolved questions');
    for (const q of result.unresolvedQuestions) lines.push(`- ${q}`);
  }
  if (result.recommendations.length > 0) {
    lines.push('');
    lines.push('### Recommendations');
    for (const r of result.recommendations) lines.push(`- ${r}`);
  }
  lines.push('');
  lines.push(
    `_(merge=${strategy}, ` +
    `heads=${result.costSummary.headCount} (${result.costSummary.headsWithFindings} with findings), ` +
    `tokens=${result.costSummary.totalTokens}, ` +
    `wall=${Math.round(result.costSummary.totalWallClockMs / 100) / 10}s, ` +
    `depth=${result.costSummary.maxDepth})_`,
  );
  return lines.join('\n');
}
