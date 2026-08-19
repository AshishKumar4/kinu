// Branching Heads as an ExplorationStrategy.
//
// Wraps HeadController.run behind the StrategyContext/StrategyResult shape.
// Per-strategy options (StrategyContext.options.heads):
//   { controller: HeadController, heads: SplitRequest['heads'],
//     mergeStrategy?, maxDepth?, inheritedContext?, onPhase? }
// `controller`, `inheritedContext` and `onPhase` are host-injected; `heads` /
// `mergeStrategy` come from the LLM.
//
// NO MODEL-FACING ACTION REACHES THIS PROJECTION. The `agents` tool dispatches
// `swarm`, which runs the engine directly, so nothing looks a strategy up by id
// any more. The heads RUNTIME is a different thing and is very much live — a
// split runs through `HeadController`, which five sites construct — and this
// wrapper is only the ExplorationStrategy shape over it, kept because the eval
// harness compares strategies through that shape.
import type { HeadController, SplitPhaseEvent } from '../heads/controller';
import type {
  HeadBudget, SerializedMessage, SplitRequest, MergeStrategy, MergeResult,
} from '../heads/types';
import { DEFAULT_HEAD_BUDGET, DEFAULT_MERGE_STRATEGY } from '../heads/types';
import { formatHeadFileChanges, HEAD_FILE_CHANGE_PROVENANCE } from '../heads/file-changes';
import { strategyOption, type ExplorationStrategy, type StrategyContext, type StrategyResult } from './types';

interface HeadsStrategyOptions {
  controller: HeadController;
  heads: SplitRequest['heads'];
  mergeStrategy?: MergeStrategy;
  maxDepth?: number;
  maxWallClockMs?: number;
  inheritedContext?: SerializedMessage[];
  defaultModel?: string;
  /** Host event sink — fires once on split (real head ids) and once on merge. */
  onPhase?: (event: SplitPhaseEvent) => void;
  /** Host hook fired once the merge completes, carrying the full MergeResult
   *  (per-head grounded scores + texts) and the split task. The host records an
   *  Alternate-Takes set from the comparable heads so the pick lands in the
   *  preference ledger — host-injected, like onPhase. */
  onComplete?: (merge: MergeResult, task: string) => void;
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
      // SAFETY: agents-tool constructs this host-owned strategy option by
      // merging its HeadController and callbacks with the schema-parsed head specs.
      const o = (strategyOption(ctx.options, 'heads') ?? {}) as Partial<HeadsStrategyOptions>;
      if (!o.controller) {
        throw new Error('Heads strategy requires options.heads.controller (HeadController).');
      }
      if (!o.heads || o.heads.length === 0) {
        throw new Error('Heads strategy requires `heads` (an array of 2–6 head specs).');
      }

      const strategy: MergeStrategy = o.mergeStrategy ?? DEFAULT_MERGE_STRATEGY;
      // A wall clock exists only if someone asked for one; there is no default
      // to fall through to.
      const wallClockMs = o.maxWallClockMs ?? ctx.budget?.wallClockMs;
      const parentBudget: HeadBudget = wallClockMs === undefined
        ? { maxDepth: o.maxDepth ?? DEFAULT_HEAD_BUDGET.maxDepth, spawnedAt: Date.now() }
        : {
            maxDepth: o.maxDepth ?? DEFAULT_HEAD_BUDGET.maxDepth,
            maxWallClockMs: wallClockMs,
            spawnedAt: Date.now(),
          };

      const runOptions: Parameters<HeadController['run']>[0] = {
        parentHeadId: null,
        inheritedContext: o.inheritedContext ?? [],
        request: {
          rationale: ctx.task,
          heads: o.heads,
          mergeStrategy: strategy,
        },
        parentBudget,
        mode: ctx.mode,
        model: o.defaultModel,
        onPhase: o.onPhase,
      };
      // Labels only: HeadInput crosses a process boundary as data, and the far
      // side rebuilds a port over whatever reaches the ledger there.
      if (ctx.mission) runOptions.missionLabels = ctx.mission.labels;
      const merge = await o.controller.run(runOptions);

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

      const cost: StrategyResult['cost'] = {
        // Absent when no head's provider reported usage. Propagated as absence
        // so the spawn seam can decline to charge rather than bill a zero.
        tokens: merge.costSummary.totalTokens,
        durationMs: Date.now() - t0,
        iterations: merge.costSummary.headCount,
      };
      if (merge.fileChanges.length > 0) {
        cost.filesChanged = new Set(
          merge.fileChanges.flatMap((head) => head.changes.map((change) => change.path)),
        ).size;
      }
      if (ctx.mission) cost.selfMetered = true;

      return {
        strategy: 'heads',
        best: {
          text: formatted,
          payload: merge,
          score: bestScore,
          source: 'merge',
        },
        all: candidates,
        // Each head debited its own steps as it ran, so the caller must not
        // charge the total a second time. File changes count distinct paths.
        cost,
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
  // Rendered apart from unresolved questions, not folded into them: an open
  // question is one the forks raised and the reader can weigh, while this is
  // ground none of them checked — so the narrative above is silent about it
  // for a reason the reader would otherwise never learn.
  if (result.blindSpots.length > 0) {
    lines.push('');
    lines.push('### Not covered by any fork');
    for (const b of result.blindSpots) lines.push(`- ${b}`);
  }
  // Deterministic, not synthesized: the merge model narrates the findings, but
  // what each head DID to the filesystem is a record, and a record that a model
  // paraphrases is a record you cannot act on. Absent entirely when no head
  // changed anything.
  if (result.fileChanges.length > 0) {
    lines.push('');
    lines.push('### Files changed');
    for (const head of result.fileChanges) {
      lines.push(`Head ${head.id}`);
      lines.push(...formatHeadFileChanges(head.changes));
    }
    lines.push('');
    lines.push(`_${HEAD_FILE_CHANGE_PROVENANCE}_`);
  }
  lines.push('');
  // `tokens` is stated as unreported rather than rendered as `undefined` — and
  // never as a `0`, which would read to the model as a free delegation.
  lines.push(
    `_(merge=${strategy}, ` +
    `heads=${result.costSummary.headCount} (${result.costSummary.headsWithFindings} with findings), ` +
    `tokens=${result.costSummary.totalTokens ?? 'unreported'}, ` +
    `wall=${Math.round(result.costSummary.totalWallClockMs / 100) / 10}s, ` +
    `depth=${result.costSummary.maxDepth})_`,
  );
  return lines.join('\n');
}
