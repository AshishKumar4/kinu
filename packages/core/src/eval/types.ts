import * as v from 'valibot';
import type { JsonObject } from '../utils/json';

/** Per-case (whole episode) ceilings scored beside the outcome, never enforced on the agent.
 *  An absent field is not scored: "no ceiling" and "ceiling of zero" are different facts. */
export const EvalBudgetSchema = v.object({
  /** Counted from `step_finish` rows. */
  steps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** Input plus output, one ceiling: which side a task spends on is a property of the task. */
  tokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** Share of tool calls that may fail, in [0,1]; nonzero because some cases are about recovering from one. */
  toolErrorRate: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  /** Wall, not model time: it includes every tool call. */
  wallMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export type EvalBudget = v.InferOutput<typeof EvalBudgetSchema>;

export interface EvalCase {
  id: string;
  task: string;
  /** Absent means generic "did it complete the task correctly?" judging. */
  rubric?: string;
  /** Hand-labeled; grounds the judge's scoring when present. */
  reference?: string;
  tags?: string[];
  /** Opaque key the running tier resolves to a seeder, so new task families need no core change. */
  env?: string;
  /** Per-instance parameters (n, k, seed) so one verifier serves several sizes; the tier narrows them. */
  params?: JsonObject;
  /** Absent: cost is still measured, just held to nothing. */
  budget?: EvalBudget;
}

export interface EvalRun {
  caseId: string;
  strategyId: string;
  output: string;
  selfScore?: number;
  costTokens?: number;
  durationMs: number;
  error?: string;
}

export const VerdictSchema = v.object({
  winner: v.picklist(['a', 'b', 'tie']),
  scoreA: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  scoreB: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  rationale: v.pipe(v.string(), v.minLength(1)),
});

export type Verdict = v.InferOutput<typeof VerdictSchema>;

export type JudgeFn = (
  caseInput: EvalCase,
  runA: EvalRun,
  runB: EvalRun,
) => Promise<Verdict>;

export interface EvalResult {
  caseId: string;
  strategyA: string;
  strategyB: string;
  verdict: Verdict;
  runA: EvalRun;
  runB: EvalRun;
}

export interface EvalSummary {
  total: number;
  aWins: number;
  bWins: number;
  ties: number;
  avgScoreA: number;
  avgScoreB: number;
}

export function summarizeEval(results: EvalResult[]): EvalSummary {
  const summary: EvalSummary = {
    total: results.length,
    aWins: 0, bWins: 0, ties: 0,
    avgScoreA: 0, avgScoreB: 0,
  };

  for (const r of results) {
    if (r.verdict.winner === 'a') summary.aWins++;
    else if (r.verdict.winner === 'b') summary.bWins++;
    else summary.ties++;
    summary.avgScoreA += r.verdict.scoreA;
    summary.avgScoreB += r.verdict.scoreB;
  }

  if (results.length > 0) {
    summary.avgScoreA /= results.length;
    summary.avgScoreB /= results.length;
  }

  return summary;
}
