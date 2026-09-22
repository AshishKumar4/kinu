// Pure scoreboard report and CI regression gate over runEvalPair results.
import { summarizeEval } from './types';
import type { EvalResult, EvalSummary } from './types';

/** Shared by the CI gate and the quality panel; overridable per run via --min-score / EVAL_MIN_SCORE. */
export const DEFAULT_QUALITY_THRESHOLD = 0.5;

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
  /** Candidate (B) mean judge score; the number the CI gate floors. */
  aggregateScore: number;
  regressionDelta: number;
  cases: EvalCaseScore[];
}

/** B is the candidate under test; A is the baseline. */
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
    // Empty error means no error: consumers read the field as "did this side fail".
    errorA: r.runA.error === '' ? undefined : r.runA.error,
    errorB: r.runB.error === '' ? undefined : r.runB.error,
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

/** Fails on zero cases or any errored case, since neither is a measurement. */
export function evaluateGate(report: EvalReport, threshold: number): GateResult {
  const score = report.aggregateScore;

  if (report.summary.total === 0) {
    return { pass: false, aggregateScore: score, threshold, reason: 'no eval cases ran — nothing to gate on' };
  }

  // Errored runs get judged as ties near 0.5, which would pass a 0.5 floor.
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
