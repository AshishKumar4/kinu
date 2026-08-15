// Scoreboard report + regression gate over runEvalPair results. Pure — no LLM,
// no IO. Turns raw EvalResult[] into a persistable/renderable report and applies
// a committed quality floor so CI can fail on a regression. Shared by the eval
// script (scripts/eval.ts) and any surface that renders a benchmark run.
import { summarizeEval } from './types.js';
import type { EvalResult, EvalSummary } from './types.js';

/** Committed quality floor for the CI benchmark gate and the quality panel's
 *  reference line — the single source of truth both share. Calibrate after the
 *  first real run against production models; the eval script can override it
 *  per-invocation via --min-score / EVAL_MIN_SCORE. */
export const DEFAULT_QUALITY_THRESHOLD = 0.5;

/** One case's outcome, flattened from an EvalResult for reporting/rendering. */
export interface EvalCaseScore {
  caseId: string;
  winner: 'a' | 'b' | 'tie';
  scoreA: number;
  scoreB: number;
  rationale: string;
  durationMsA: number;
  durationMsB: number;
  errorA?: string;
  errorB?: string;
}

export interface EvalReportMeta {
  ranAt?: number;
  strategyA: string;
  strategyB: string;
  modelA?: string;
  modelB?: string;
  corpus?: string;
}

export interface EvalReport {
  ranAt: number;
  strategyA: string;
  strategyB: string;
  modelA?: string;
  modelB?: string;
  corpus?: string;
  summary: EvalSummary;
  /** The headline number the CI gate floors: mean judge score of the
   *  candidate strategy (B). Baseline (A) is summary.avgScoreA. */
  aggregateScore: number;
  /** aggregateScore − baseline; positive when the candidate beats the baseline. */
  regressionDelta: number;
  cases: EvalCaseScore[];
}

/** Flatten runEvalPair output into a structured, serializable report.
 *  Strategy B is the candidate / system-under-test; A is the baseline. */
export function buildEvalReport(results: EvalResult[], meta: EvalReportMeta): EvalReport {
  const summary = summarizeEval(results);
  const cases: EvalCaseScore[] = results.map((r) => ({
    caseId: r.caseId,
    winner: r.verdict.winner,
    scoreA: r.verdict.scoreA,
    scoreB: r.verdict.scoreB,
    rationale: r.verdict.rationale,
    durationMsA: r.runA.durationMs,
    durationMsB: r.runB.durationMs,
    errorA: r.runA.error || undefined,
    errorB: r.runB.error || undefined,
  }));
  return {
    ranAt: meta.ranAt ?? Date.now(),
    strategyA: meta.strategyA,
    strategyB: meta.strategyB,
    modelA: meta.modelA,
    modelB: meta.modelB,
    corpus: meta.corpus,
    summary,
    aggregateScore: summary.avgScoreB,
    regressionDelta: summary.avgScoreB - summary.avgScoreA,
    cases,
  };
}

export interface GateResult {
  pass: boolean;
  aggregateScore: number;
  threshold: number;
  reason: string;
}

/** CI quality floor: the candidate's aggregate judge score must clear the
 *  committed threshold. A run with zero cases fails — an empty corpus proves
 *  nothing and must not silently pass the gate. Neither does a run whose
 *  strategies errored. */
export function evaluateGate(report: EvalReport, threshold: number): GateResult {
  const score = report.aggregateScore;
  if (report.summary.total === 0) {
    return { pass: false, aggregateScore: score, threshold, reason: 'no eval cases ran — nothing to gate on' };
  }
  // A case whose strategy errored produced no answer, so the judge scored the
  // absence of one — typically as a tie at 0.5. With a corpus of those the
  // aggregate lands exactly on a 0.5 floor and passes, which is how a run where
  // every single model call failed returned a green gate.
  const errored = report.cases.filter((c) => c.errorA !== undefined || c.errorB !== undefined).length;
  if (errored > 0) {
    return {
      pass: false,
      aggregateScore: score,
      threshold,
      reason: `${errored}/${report.cases.length} case(s) errored — the run is not a measurement`,
    };
  }
  const pass = score >= threshold;
  return {
    pass,
    aggregateScore: score,
    threshold,
    reason: pass
      ? `aggregate ${score.toFixed(3)} ≥ threshold ${threshold.toFixed(3)}`
      : `aggregate ${score.toFixed(3)} < threshold ${threshold.toFixed(3)} — quality regression`,
  };
}

/** Compact human summary of a benchmark run for stdout / CI logs. */
export function renderEvalSummary(report: EvalReport, gate?: GateResult): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`Eval: ${report.strategyB}${report.modelB ? ` (${report.modelB})` : ''} vs ${report.strategyA}${report.modelA ? ` (${report.modelA})` : ''} (baseline)`);
  if (report.corpus) lines.push(`Corpus: ${report.corpus}`);
  lines.push(`Cases: ${s.total}   B-wins: ${s.bWins}   A-wins: ${s.aWins}   ties: ${s.ties}`);
  lines.push(`Aggregate (B): ${s.avgScoreB.toFixed(3)}   Baseline (A): ${s.avgScoreA.toFixed(3)}   Δ: ${report.regressionDelta >= 0 ? '+' : ''}${report.regressionDelta.toFixed(3)}`);
  for (const c of report.cases) {
    const flag = c.errorA || c.errorB ? ' ⚠' : '';
    lines.push(`  ${c.caseId.padEnd(14)} A=${c.scoreA.toFixed(2)} B=${c.scoreB.toFixed(2)} → ${c.winner}${flag}`);
  }
  if (gate) lines.push(`Gate: ${gate.pass ? 'PASS' : 'FAIL'} — ${gate.reason}`);
  return lines.join('\n');
}
