import { describe, test, expect } from 'bun:test';
import {
  buildEvalReport, evaluateGate, renderEvalSummary, DEFAULT_QUALITY_THRESHOLD,
} from '../src/index.ts';
import type { EvalResult } from '../src/index.ts';

function result(
  caseId: string,
  winner: 'a' | 'b' | 'tie',
  scoreA: number,
  scoreB: number,
  extra?: { errorA?: string; errorB?: string },
): EvalResult {
  return {
    caseId,
    strategyA: 'baseline',
    strategyB: 'candidate',
    verdict: { winner, scoreA, scoreB, rationale: `${caseId}-rationale` },
    runA: { caseId, strategyId: 'baseline', output: 'a', durationMs: 10, error: extra?.errorA },
    runB: { caseId, strategyId: 'candidate', output: 'b', durationMs: 20, error: extra?.errorB },
  };
}

describe('buildEvalReport', () => {
  test('flattens results + computes aggregate/regression', () => {
    const results = [
      result('c1', 'b', 0.4, 0.9),
      result('c2', 'a', 0.8, 0.6),
      result('c3', 'tie', 0.5, 0.5),
    ];
    const report = buildEvalReport(results, {
      ranAt: 123, strategyA: 'baseline', strategyB: 'candidate',
      modelA: 'm', modelB: 'm', corpus: 'seed.jsonl',
    });
    expect(report.ranAt).toBe(123);
    expect(report.summary.total).toBe(3);
    expect(report.aggregateScore).toBeCloseTo((0.9 + 0.6 + 0.5) / 3, 5);
    expect(report.regressionDelta).toBeCloseTo(((0.9 + 0.6 + 0.5) - (0.4 + 0.8 + 0.5)) / 3, 5);
    expect(report.cases.map((c) => c.caseId)).toEqual(['c1', 'c2', 'c3']);
    expect(report.cases[0].winner).toBe('b');
    expect(report.corpus).toBe('seed.jsonl');
  });

  test('carries per-run errors onto the case', () => {
    const report = buildEvalReport(
      [result('boom', 'b', 0, 1, { errorA: 'strategy A crashed' })],
      { strategyA: 'a', strategyB: 'b' },
    );
    expect(report.cases[0].errorA).toBe('strategy A crashed');
    expect(report.cases[0].errorB).toBeUndefined();
  });

  test('omits optional meta fields when absent', () => {
    const report = buildEvalReport([result('c', 'tie', 0.5, 0.5)], { strategyA: 'a', strategyB: 'b' });
    expect(report.modelA).toBeUndefined();
    expect(report.corpus).toBeUndefined();
  });
});

describe('evaluateGate', () => {
  const report = buildEvalReport([result('c1', 'b', 0.5, 0.8)], { strategyA: 'a', strategyB: 'b' });

  test('passes when aggregate clears the threshold', () => {
    const gate = evaluateGate(report, 0.7);
    expect(gate.pass).toBe(true);
    expect(gate.aggregateScore).toBeCloseTo(0.8, 5);
    expect(gate.reason).toContain('≥');
  });

  test('fails when aggregate is below the threshold', () => {
    const gate = evaluateGate(report, 0.9);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toContain('regression');
  });

  test('boundary: aggregate exactly at threshold passes', () => {
    const gate = evaluateGate(report, 0.8);
    expect(gate.pass).toBe(true);
  });

  test('empty corpus fails the gate (proves nothing)', () => {
    const empty = buildEvalReport([], { strategyA: 'a', strategyB: 'b' });
    const gate = evaluateGate(empty, 0);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toContain('no eval cases');
  });

  // A dead provider scores every case as a 0.5 tie, which clears a 0.5 floor.
  test('a run whose strategies errored fails, however the aggregate lands', () => {
    const broken = buildEvalReport(
      [result('c1', 'tie', 0.5, 0.5, { errorA: 'connection refused', errorB: 'connection refused' })],
      { strategyA: 'a', strategyB: 'b' },
    );
    const gate = evaluateGate(broken, 0.5);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toContain('errored');
    // Even a floor of zero cannot rescue it — there is nothing to floor.
    expect(evaluateGate(broken, 0).pass).toBe(false);
  });

  test('one errored case fails a run that would otherwise clear the floor', () => {
    const mixed = buildEvalReport(
      [result('c1', 'b', 0.9, 0.95), result('c2', 'tie', 0.5, 0.5, { errorB: 'timeout' })],
      { strategyA: 'a', strategyB: 'b' },
    );
    expect(evaluateGate(mixed, 0.5).pass).toBe(false);
    expect(evaluateGate(mixed, 0.5).reason).toContain('1/2');
  });

  test('default threshold is a committed floor', () => {
    expect(DEFAULT_QUALITY_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_QUALITY_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('renderEvalSummary', () => {
  test('produces a readable multi-line summary with the gate verdict', () => {
    const report = buildEvalReport(
      [result('c1', 'b', 0.4, 0.9), result('c2', 'a', 0.8, 0.6)],
      { strategyA: 'single-shot', strategyB: 'single-shot', modelB: 'gpt-x' },
    );
    const gate = evaluateGate(report, 0.5);
    const out = renderEvalSummary(report, gate);
    expect(out).toContain('Cases: 2');
    expect(out).toContain('c1');
    expect(out).toContain('Gate: PASS');
  });
});
