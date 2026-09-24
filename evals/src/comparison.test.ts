import { describe, expect, test } from 'bun:test';
import { compareEvalResults, fisherExact, renderEvalComparison, validateEvalResults } from './comparison';
import { redact } from './redact';

type Trial = { pass: boolean; infra?: boolean; productSha?: string; taskVersion?: string; failed?: string; trial?: number };

/** A vitest JSON report of one task's trials, as the reporter writes it, cut to the fields the comparison reads. */
function report(taskId: string, trials: readonly Trial[], side: { productSha: string; evalCommit: string }): string {
  const assertionResults = trials.map((trial, index) => ({
    status: trial.pass ? 'passed' : 'failed',
    duration: 60_000,
    meta: {
      harness: {
        run: {
          session: {
            metadata: {
              taskId, taskVersion: trial.taskVersion ?? 'v1', evalCommit: side.evalCommit, productSha: trial.productSha ?? side.productSha, arm: 'product',
              trial: trial.trial ?? index + 1,
            },
            events: [],
          },
          usage: { model: 'workers-ai/@cf/zai-org/glm-5.3', metadata: {} },
          output: {
            metrics: { modelTurns: 4, toolCalls: 6, toolErrors: 0, providerWaits: 2, providerWaitMs: 30_000 },
            turns: [{
              outcome: { status: trial.infra === true ? 'error' : 'completed' },
              checks: [{ id: trial.failed ?? 'builds', pass: trial.pass, evidence: trial.pass ? { calls: 3 } : { answered: 1 } }],
            }],
          },
          errors: [],
        },
      },
    },
  }));

  return JSON.stringify({ testResults: [{ name: `/repo/evals/tasks/${taskId}.eval.ts`, assertionResults }] });
}

function trialsOf(passed: number, total: number, extra: Partial<Trial> = {}): Trial[] {
  return Array.from({ length: total }, (_unused, index) => ({ pass: index < passed, ...extra }));
}

const BASE = { productSha: 'aaaaaaaa1', evalCommit: 'eeeeeee1' };

const NEXT = { productSha: 'bbbbbbbb2', evalCommit: 'eeeeeee1' };

describe('fisherExact', () => {
  test('is two-sided and exact on small tables', () => {
    expect(fisherExact({ passed: 10, trials: 10 }, { passed: 0, trials: 10 })).toBeCloseTo(1.0825e-5, 8);
    expect(fisherExact({ passed: 9, trials: 10 }, { passed: 4, trials: 10 })).toBeCloseTo(0.0573, 4);
    expect(fisherExact({ passed: 5, trials: 10 }, { passed: 5, trials: 10 })).toBeCloseTo(1, 10);
  });
});

describe('compareEvalResults', () => {
  test('a significant fall on any task is a regression, whatever else rose', () => {
    const comparison = compareEvalResults(report('order-book', trialsOf(9, 10), BASE), report('order-book', trialsOf(2, 10), NEXT));

    expect(comparison.verdict).toBe('regressed');
    expect(comparison.rows[0]?.reason).toBeNull();
  });

  test('a fall within noise is unchanged', () => {
    expect(compareEvalResults(report('order-book', trialsOf(6, 10), BASE), report('order-book', trialsOf(4, 10), NEXT)).verdict).toBe('unchanged');
  });

  test('changed definitions, a new task version or infrastructure errors leave nothing to compare', () => {
    const changed = compareEvalResults(report('t', trialsOf(9, 10), BASE), report('t', trialsOf(1, 10), NEXT), { definitionsChanged: () => true });
    const versioned = compareEvalResults(report('t', trialsOf(9, 10), BASE), report('t', trialsOf(1, 10, { taskVersion: 'v2' }), NEXT));
    const broken = compareEvalResults(report('t', trialsOf(9, 10), BASE), report('t', [...trialsOf(1, 9), { pass: false, infra: true }], NEXT));

    expect([changed, versioned, broken].map((comparison) => [comparison.verdict, comparison.rows[0]?.reason]))
      .toEqual([['inconclusive', 'eval definition changed'], ['inconclusive', 'task version changed'], ['inconclusive', 'candidate infrastructure errors']]);
  });

  test('with no baseline the report stands alone and still names what failed', () => {
    const comparison = compareEvalResults(null, report('lending-library', trialsOf(3, 10, { failed: 'late-returns-suspend-for-a-week' }), NEXT));
    const markdown = renderEvalComparison(comparison);

    expect(comparison.verdict).toBe('inconclusive');
    expect(markdown).toContain('3/10');
    expect(markdown).toContain('`t1 late-returns-suspend-for-a-week` | \u2014 | 7 |');
  });

  test('a report that mixes two builds is refused rather than compared', () => {
    const mixed = report('t', [...trialsOf(5, 5), { pass: true, productSha: 'cccccccc3' }], BASE);

    expect(() => compareEvalResults(null, mixed)).toThrow(/mix builds/);
  });
});

describe('validateEvalResults', () => {
  test('a baseline needs every trial and no infrastructure failure, and reports its wall time', () => {
    expect(validateEvalResults(report('t', trialsOf(4, 10), BASE), 10)).toEqual([{ taskId: 't', slowestTrialMs: 60_000 }]);
    expect(() => validateEvalResults(report('t', trialsOf(4, 9), BASE), 10)).toThrow(/holds trials \[1, 2, 3, 4, 5, 6, 7, 8, 9\], expected 1 to 10/);
    expect(() => validateEvalResults(report('t', [...trialsOf(4, 9), { pass: false, infra: true }], BASE), 10)).toThrow(/infrastructure/);
  });

  test('a report joined from two jobs that ran the same block of trials is refused, though its count is right', () => {
    const block = (first: number) => Array.from({ length: 5 }, (_unused, index) => ({ pass: true, trial: first + index }));

    expect(validateEvalResults(report('t', [...block(1), ...block(6)], BASE), 10)).toHaveLength(1);
    expect(() => validateEvalResults(report('t', [...block(1), ...block(1)], BASE), 10)).toThrow(/expected 1 to 10 once each/);
  });
});

describe('redact', () => {
  test('scrubs what a public comment must not carry', () => {
    // Built from parts, as the repo's other redaction fixtures are, so no token-shaped literal sits in the tree.
    const syntheticKey = ['sk', 'live', '0123456789abcdef'].join('_');
    const text = `GET https://preview-0000000000-fixture.kinu.run/ Bearer abc.def-123 ${syntheticKey}`;

    expect(redact(text)).toBe('GET https://<preview>.kinu.run/ Bearer <redacted> <token>');
  });
});
