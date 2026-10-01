import { describe, expect, test } from 'bun:test';
import { compareEvalResults, evalGateVerdict, fisherExact, renderEvalComparison, validateEvalResults, whyIncomplete } from './comparison';

/**
 * `infra`: the deployment ended the turn in error. `refused`: it answered the turn's request with this failure.
 * `reset`: it answered that the workspace's isolate was reset for memory.
 */
type Trial = {
  pass: boolean; infra?: boolean; refused?: string; reset?: string; productSha?: string; taskVersion?: string; failed?: string; trial?: number;
};

function outcomeOf(trial: Trial) {
  if (trial.infra === true) return { status: 'error' };

  if (trial.reset !== undefined) return { status: 'reset', message: trial.reset };

  return trial.refused === undefined ? { status: 'completed' } : { status: 'refused', message: trial.refused };
}

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
              outcome: outcomeOf(trial),
              checks: trial.refused === undefined && trial.reset === undefined
                ? [{ id: trial.failed ?? 'builds', pass: trial.pass, evidence: trial.pass ? { calls: 3 } : { answered: 1 } }]
                : [],
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

  test('a request the build refused fails its turn on the build: counted, compared and named, never infrastructure', () => {
    const refused = report('t', [...trialsOf(1, 9), { pass: false, refused: 'could not read the chat history: 500 Internal Server Error' }], NEXT);
    const comparison = compareEvalResults(report('t', trialsOf(9, 10), BASE), refused);

    expect(validateEvalResults(refused, 10)).toHaveLength(1);
    expect([comparison.verdict, comparison.rows[0]?.reason]).toEqual(['regressed', null]);
    expect(renderEvalComparison(comparison)).toContain('`t1 deployment.refused` | 0 | 1 |');
  });

  // A reset may be the build's own regression: never infrastructure, and a build that resets more is red even when
  // its pass rate held.
  test('workspaces reset for memory more often is a regression, compared by its own rate, never infrastructure', () => {
    const reset = 'could not read the events of run: 500 \u2014 Durable Object\'s isolate exceeded its memory limit and was reset.';
    const resetting = report('t', [...trialsOf(5, 5), ...Array.from({ length: 5 }, () => ({ pass: false, reset }))], NEXT);
    const comparison = compareEvalResults(report('t', trialsOf(5, 10), BASE), resetting);

    expect(validateEvalResults(resetting, 10)).toHaveLength(1);
    expect([comparison.verdict, comparison.rows[0]?.reason]).toEqual(['regressed', null]);
    expect(renderEvalComparison(comparison)).toContain('Reset for memory more often: t 0/10 \u2192 5/10');
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

describe('evalGateVerdict, what a promote reads', () => {
  /** Both legs of one run: the baseline and the candidate deployment, measured under the same definitions. */
  const complete = { baseline: null, candidate: null };

  test('two complete legs stand when nothing fell, and say what they found', () => {
    const verdict = evalGateVerdict(compareEvalResults(report('order-book', trialsOf(6, 10), BASE), report('order-book', trialsOf(6, 10), NEXT)), complete);

    expect(verdict).toEqual({ pass: true, reason: expect.stringContaining('Unchanged') });
  });

  test('a significant fall fails it, naming the task and both pass counts', () => {
    const verdict = evalGateVerdict(compareEvalResults(report('order-book', trialsOf(9, 10), BASE), report('order-book', trialsOf(2, 10), NEXT)), complete);

    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('order-book');
    expect(verdict.reason).toContain('9/10');
    expect(verdict.reason).toContain('2/10');
  });

  test('a baseline leg that is not a complete report fails it, naming the baseline and why', () => {
    const verdict = evalGateVerdict(
      compareEvalResults(report('order-book', trialsOf(6, 10), BASE), report('order-book', trialsOf(6, 10), NEXT)),
      { baseline: 'order-book has 10 infrastructure failures', candidate: null },
    );

    expect(verdict).toEqual({ pass: false, reason: expect.stringMatching(/^The baseline's report is not complete: order-book has 10 infrastructure failures/) });
  });

  test('a candidate leg that is not a complete report fails it, naming the candidate and why, whatever the comparison says', () => {
    const verdict = evalGateVerdict(
      compareEvalResults(report('order-book', trialsOf(6, 10), BASE), report('order-book', trialsOf(6, 9), NEXT)),
      { baseline: null, candidate: 'order-book holds trials [1..9]' },
    );

    expect(verdict).toEqual({ pass: false, reason: expect.stringMatching(/^The candidate's report is not complete: order-book holds trials \[1\.\.9\]/) });
  });

  test('no baseline report fails it: nothing was compared', () => {
    expect(evalGateVerdict(compareEvalResults(null, report('order-book', trialsOf(10, 10), NEXT)), complete))
      .toEqual({ pass: false, reason: expect.stringMatching(/^No baseline/) });
  });

  test('legs that could not be compared fail it, with the reason each task could not be', () => {
    const verdict = evalGateVerdict(
      compareEvalResults(report('order-book', trialsOf(6, 10), BASE), report('order-book', trialsOf(6, 10, { taskVersion: 'v2' }), NEXT)), complete,
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('task version changed');
  });
});

describe('whyIncomplete, whether a leg can stand in a verdict', () => {
  const leg = report('order-book', trialsOf(6, 10), NEXT);

  test('a leg with every task, every trial, no infrastructure failure and the planned build is complete', () => {
    expect(whyIncomplete(leg, { trials: 10, taskFiles: ['order-book.eval.ts'], build: 'bbbbbbbb2' })).toBeNull();
    expect(whyIncomplete(leg, { trials: 10, build: 'bbbbbbb' })).toBeNull();
  });

  test('a task of these definitions missing from the leg is named', () => {
    expect(whyIncomplete(leg, { trials: 10, taskFiles: ['order-book.eval.ts', 'launch-prep.eval.ts'] })).toBe('launch-prep.eval.ts did not run');
  });

  test('a leg that ran on another build than the one planned for it is named, with both builds', () => {
    expect(whyIncomplete(leg, { trials: 10, build: 'aaaaaaaa1' })).toBe('its trials ran on build bbbbbbbb2, not the planned aaaaaaaa1');
  });

  test('missing trials are named as validateEvalResults names them', () => {
    expect(whyIncomplete(report('order-book', trialsOf(6, 9), NEXT), { trials: 10 })).toContain('holds trials [1, 2, 3, 4, 5, 6, 7, 8, 9]');
  });
});
