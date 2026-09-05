// Eval harness — generalizes runAutoShadowEval to compare arbitrary
// strategies/loops on a corpus of tasks.
//
// Use cases:
//   - A/B test "MCTS vs single-shot" on 30 tasks
//   - Validate a new search policy doesn't regress on existing corpus
//   - Score a scaffold mutation against a held-out task set
import * as v from 'valibot';
import type { JsonObject } from '../utils/json';

/** A single eval case — task + optional rubric for the judge. */
export interface EvalCase {
  id: string;
  task: string;
  /** Free-form rubric. When present, the judge uses it; otherwise generic
   *  "did it complete the task correctly?" judging. */
  rubric?: string;
  /** Hand-labeled reference answer. Optional; when present the judge
   *  compares both strategies against it for grounded scoring. */
  reference?: string;
  /** Free-form tags for slicing results (e.g. ["math", "tool-use"]). */
  tags?: string[];
  /**
   * The environment this case is handed before the turn — an opaque key the
   * tier running the case resolves to a seeder. Opaque on purpose: this module
   * owns the corpus FORMAT, and a union of environment names here would make
   * every new task family a change to core.
   */
  env?: string;
  /**
   * Per-instance parameters, so one verifier serves several sized instances of
   * the same family (n, k, seed) instead of one module per instance.
   *
   * `JsonObject` because a case is a line of JSONL: JSON is exactly what can
   * arrive here, and it is a concrete value contract rather than a dictionary of
   * `unknown` that every caller has to cast its way out of. The tier that
   * declared the parameters still narrows them at the point of use.
   */
  params?: JsonObject;
}

/** One strategy's run against one case. */
export interface EvalRun {
  caseId: string;
  strategyId: string;
  output: string;
  /** Self-reported score from the strategy (if available). */
  selfScore?: number;
  costTokens?: number;
  durationMs: number;
  error?: string;
}

/** Judge's verdict comparing two runs against a case. */
export const VerdictSchema = v.object({
  winner: v.picklist(['a', 'b', 'tie']),
  /** [0..1] for each strategy. */
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
