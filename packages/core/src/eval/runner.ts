// Eval runner — drives N cases × 2 strategies, asks a judge LLM for verdicts,
// returns aggregated EvalSummary. Stateless — caller owns persistence (writes
// to eval_results table or whatever the host wants).
import type { ExplorationStrategy, StrategyContext } from './strategy';
import type { EvalCase, EvalRun, JudgeFn, EvalResult } from './types';
import { renderThrownChain } from '../obs/index';

export interface RunEvalPairOpts {
  cases: EvalCase[];
  strategyA: ExplorationStrategy;
  strategyB: ExplorationStrategy;
  /** Built fresh per-case so each arm gets its own rt/model. */
  buildContext: (caseInput: EvalCase) => StrategyContext;
  judge: JudgeFn;
}

export async function runEvalPair(opts: RunEvalPairOpts): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  for (const c of opts.cases) {
    const runA = await runOne(opts.strategyA, c, opts.buildContext);
    const runB = await runOne(opts.strategyB, c, opts.buildContext);
    // A judge failure is a failed measurement, not a tie. It propagates so the
    // caller cannot build a report or pass a gate on scores nobody produced.
    const verdict = await opts.judge(c, runA, runB);
    out.push({
      caseId: c.id,
      strategyA: opts.strategyA.id,
      strategyB: opts.strategyB.id,
      verdict, runA, runB,
    });
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
    const message = renderThrownChain({ cause: err });
    return {
      caseId: c.id,
      strategyId: strategy.id,
      output: '',
      durationMs: Date.now() - t0,
      error: message,
    };
  }
}
