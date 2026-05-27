// Eval runner — drives N cases × 2 strategies, asks a judge LLM for verdicts,
// returns aggregated EvalSummary. Stateless — caller owns persistence (writes
// to eval_results table or whatever the host wants).
import type { ExplorationStrategy, StrategyContext } from '../strategy/types.js';
import type { EvalCase, EvalRun, JudgeFn, EvalResult } from './types.js';

export interface RunEvalPairOpts {
  cases: EvalCase[];
  strategyA: ExplorationStrategy;
  strategyB: ExplorationStrategy;
  /** Built fresh per-case so each strategy gets its own rt/model/options. */
  buildContext: (caseInput: EvalCase) => StrategyContext;
  judge: JudgeFn;
  /** Optional per-result hook (e.g. persist to eval_results table). */
  onResult?: (result: EvalResult) => void | Promise<void>;
  /** Optional per-case-start hook. */
  onCase?: (caseInput: EvalCase, index: number, total: number) => void;
}

export async function runEvalPair(opts: RunEvalPairOpts): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (let i = 0; i < opts.cases.length; i++) {
    const c = opts.cases[i];
    opts.onCase?.(c, i, opts.cases.length);
    const runA = await runOne(opts.strategyA, c, opts.buildContext);
    const runB = await runOne(opts.strategyB, c, opts.buildContext);
    let verdict;
    try {
      verdict = await opts.judge(c, runA, runB);
    } catch (err) {
      verdict = { winner: 'tie' as const, scoreA: 0.5, scoreB: 0.5,
                  rationale: `judge error: ${(err as Error).message}` };
    }
    const result: EvalResult = {
      caseId: c.id,
      strategyA: opts.strategyA.id,
      strategyB: opts.strategyB.id,
      verdict, runA, runB,
    };
    out.push(result);
    if (opts.onResult) await opts.onResult(result);
  }
  return out;
}

async function runOne(
  strategy: ExplorationStrategy,
  c: EvalCase,
  buildContext: (c: EvalCase) => StrategyContext,
): Promise<EvalRun> {
  const t0 = Date.now();
  try {
    const result = await strategy.explore(buildContext(c));
    return {
      caseId: c.id,
      strategyId: strategy.id,
      output: result.best.text,
      selfScore: result.best.score,
      costTokens: result.cost.tokens,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      caseId: c.id,
      strategyId: strategy.id,
      output: '',
      durationMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}
