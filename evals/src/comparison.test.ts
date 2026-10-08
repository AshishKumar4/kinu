import { describe, expect, test } from 'bun:test';
import { compareEvalResults, evalGateVerdict, fisherExact, renderEvalComparison, validateEvalResults, whyIncomplete } from './comparison';
import type { PlatformReport } from './platform';
import { mannWhitney } from './shifts';

/**
 * `infra`: the deployment ended the turn in error. `refused`: it answered the turn's request with this failure.
 * `reset`: it answered that the workspace's isolate was reset for memory. `hung`: the watch's account of what held it.
 * `cancelled`: the run's cancel ended the trial, and what held its workspace then.
 */
type Trial = {
  pass: boolean; infra?: boolean; refused?: string; reset?: string; hung?: string; cancelled?: string; heldBy?: string[]; productSha?: string;
  taskVersion?: string; failed?: string; trial?: number;
  inputTokens?: number; cacheReadTokens?: number; costUsd?: number; model?: string; durationMs?: number; harnessInfra?: boolean;
  badInputCalls?: number;
  /** Provider-reported requests, oldest first. */
  steps?: { actor: string; inputTokens: number; cacheReadTokens: number }[];
  toolFailures?: { tool: string; cause: string; count: number }[];
  workspace?: string;
};

function outcomeOf(trial: Trial) {
  if (trial.infra === true) return { status: 'error' };

  if (trial.reset !== undefined) return { status: 'reset', message: trial.reset };

  if (trial.hung !== undefined) return { status: 'hung', message: trial.hung, ...trial.heldBy !== undefined && { heldBy: trial.heldBy } };

  if (trial.cancelled !== undefined) return { status: 'cancelled', message: trial.cancelled, heldBy: trial.heldBy ?? [] };

  return trial.refused === undefined ? { status: 'completed' } : { status: 'refused', message: trial.refused };
}

/** One task file's vitest JSON result, cut to the fields the comparison reads. */
function fileResult(taskId: string, trials: readonly Trial[], side: { productSha: string; evalCommit: string },
  timing?: { startTime?: number; endTime?: number }) {
  const assertionResults = trials.map((trial, index) => ({
    status: trial.pass ? 'passed' : 'failed',
    duration: trial.durationMs ?? 60_000,
    meta: {
      harness: {
        run: {
          session: {
            metadata: {
              taskId, taskVersion: trial.taskVersion ?? 'v1', evalCommit: side.evalCommit, productSha: trial.productSha ?? side.productSha, arm: 'product',
              trial: trial.trial ?? index + 1, ...trial.workspace !== undefined && { workspace: trial.workspace },
            },
            events: [],
          },
          usage: {
            model: trial.model ?? 'workers-ai/@cf/zai-org/glm-5.3', inputTokens: trial.inputTokens,
            metadata: {
              cacheReadTokens: trial.cacheReadTokens, costUsd: trial.costUsd,
              steps: (trial.steps ?? []).map((step, stepIndex) => ({
                ...step, timestamp: '2026-10-08T00:00:00.000Z', runId: 'run', stepIndex, outputTokens: 10, cacheWriteTokens: 0,
              })),
            },
          },
          output: {
            toolFailures: trial.toolFailures ?? [],
            metrics: {
              modelTurns: 4, toolCalls: 6, toolErrors: trial.badInputCalls ?? (trial.toolFailures ?? []).reduce((sum, failure) => sum + failure.count, 0), badInputCalls: trial.badInputCalls ?? 0, unknownToolCalls: 0,
              providerWaits: 2, providerWaitMs: 30_000,
            },
            turns: [{
              part: 'build', turn: 1,
              outcome: outcomeOf(trial),
              checks: trial.refused === undefined && trial.reset === undefined && trial.hung === undefined && trial.cancelled === undefined
                ? [{ id: trial.failed ?? 'builds', pass: trial.pass, evidence: trial.pass ? { calls: 3 } : { answered: 1 } }]
                : [],
            }],
          },
          errors: trial.harnessInfra === true ? [{ name: 'InfraError', message: 'the public request disconnected' }] : [],
        },
      },
    },
  }));

  return { name: `/repo/evals/tasks/${taskId}.eval.ts`, ...timing, assertionResults };
}

function report(taskId: string, trials: readonly Trial[], side: { productSha: string; evalCommit: string }): string {
  return JSON.stringify({ testResults: [fileResult(taskId, trials, side)] });
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

describe('mannWhitney', () => {
  test('is two-sided and exact, ties sharing their rank', () => {
    // Of the 20 ways to split six trials in two, one puts the three smallest first and one the three largest.
    expect(mannWhitney([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.1, 10);
    expect(mannWhitney([3, 3, 3], [3, 3, 3])).toBe(1);
    expect(mannWhitney([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [2, 3, 2, 4, 3, 2, 5, 3, 2, 4])).toBeLessThan(0.001);
  });
});

describe('compareEvalResults', () => {
  const SPREAD = [2, 3, 2, 4, 3, 2, 5, 3, 2, 4];

  // "Evals should show no degradations" (the owner): more malformed calls or tokens is one, as a fall in passes is.
  test.each([
    { moved: 'badInputCalls', before: {}, after: (index: number) => ({ badInputCalls: SPREAD[index] }), verdict: 'regressed' },
    { moved: 'toolErrors', before: {}, after: (index: number) => ({ toolFailures: [{ tool: 'shell', cause: 'error', count: SPREAD[index] ?? 1 }] }), verdict: 'regressed' },
    { moved: 'inputTokens', before: { inputTokens: 1_000 }, after: (index: number) => ({ inputTokens: 1_000 * (SPREAD[index] ?? 1) }), verdict: 'regressed' },
    { moved: 'inputTokens', before: { inputTokens: 5_000 }, after: (index: number) => ({ inputTokens: 1_000 * (SPREAD[index] ?? 1) }), verdict: 'unchanged' },
    // How long a trial took is the task's and the machine's, not a regression of the build.
    { moved: 'wallTimeMs', before: { durationMs: 60_000 }, after: (index: number) => ({ durationMs: 60_000 * (SPREAD[index] ?? 1) }), verdict: 'unchanged' },
  ])('$moved moving beyond noise is named for its task, and the verdict is $verdict', ({ moved, before, after, verdict }) => {
    const comparison = compareEvalResults(
      report('budget-board', trialsOf(9, 10, before), BASE),
      report('budget-board', trialsOf(9, 10).map((trial, index) => ({ ...trial, ...after(index) })), NEXT),
    );

    const row = comparison.rows[0];

    expect(comparison.verdict).toBe(verdict);
    expect(row?.reason === null ? row.shifts.find((shift) => shift.measure === moved)?.pValue : null).toBeLessThan(0.05);
    expect(row?.reason === null ? row.shifts.find((shift) => shift.measure === 'modelSteps')?.pValue : null).toBe(1);
  });

  test('a regression in a measure is said in the promote verdict, by task, measure and spread', () => {
    const after = trialsOf(9, 10).map((trial, index) => ({ ...trial, badInputCalls: SPREAD[index] }));
    const comparison = compareEvalResults(report('budget-board', trialsOf(9, 10), BASE), report('budget-board', after, NEXT));
    const complete = { baseline: null, candidate: null };

    expect(evalGateVerdict(comparison, complete)).toMatchObject({ pass: false });
    expect(evalGateVerdict(comparison, complete).reason).toContain('calls refused as bad input 0.0 [0.0\u20130.0] \u2192 3.0 [2.0\u20133.8]');
  });

  test('every check attempted is compared by its own pass rate', () => {
    const comparison = compareEvalResults(report('t', trialsOf(10, 10), BASE), report('t', trialsOf(3, 10), NEXT));
    const row = comparison.rows[0];

    expect(row?.reason === null ? row.checks : null).toEqual([
      { check: 't1 builds', baseline: { attempted: 10, passed: 10 }, candidate: { attempted: 10, passed: 3 }, pValue: fisherExact({ passed: 10, trials: 10 }, { passed: 3, trials: 10 }) },
    ]);
  });

  // oh-my-pi holds 95–100% after a conversation's first request (the owner). ChatGPT spends the owner's plan and never gates.
  test.each([
    { model: 'workers-ai/@cf/zai-org/glm-5.3', warm: 900, verdict: 'regressed' },
    { model: 'workers-ai/@cf/zai-org/glm-5.3', warm: 980, verdict: 'unchanged' },
    { model: 'chatgpt/gpt-6.1-sol', warm: 900, verdict: 'unchanged' },
  ])('$model reading $warm of 1000 prompt tokens from cache after each first request is $verdict', ({ model, warm, verdict }) => {
    const steps = [
      { actor: 'main', inputTokens: 1_000, cacheReadTokens: 0 },
      { actor: 'hire-1', inputTokens: 1_000, cacheReadTokens: 0 },
      { actor: 'main', inputTokens: 1_000, cacheReadTokens: warm },
    ];

    const comparison = compareEvalResults(report('t', trialsOf(9, 10, { model }), BASE), report('t', trialsOf(9, 10, { model, steps }), NEXT));

    expect(comparison.profiles[0]?.candidate.steadyCacheHitRate).toBe(warm / 1_000);
    expect(comparison.verdict).toBe(verdict);
  });

  // The platform's own account of the trials' workspaces, joined by name: a bug in more of them is a regression.
  test('a task whose workspaces saw platform bugs in significantly more trials regressed, and unread logs gate nothing', () => {
    const named = (prefix: string) => trialsOf(9, 10).map((trial, index) => ({ ...trial, workspace: `${prefix}-${String(index)}` }));

    const read = (prefix: string, threw: number): PlatformReport => ({
      measured: true, worker: 'kinu', from: 0, to: 1, sampling: 1,
      workspaces: Array.from({ length: 10 }, (_, index) => ({
        workspace: `${prefix}-${String(index)}`, objects: 2, failures: [], idleWakes: 0,
        ended: index < threw ? [{ outcome: 'exception', count: 1 }, { outcome: 'canceled', count: 3 }] : [{ outcome: 'canceled', count: 3 }],
      })),
    });

    const [before, after] = [report('t', named('eval-t-base'), BASE), report('t', named('eval-t-next'), NEXT)];
    const compared = compareEvalResults(before, after, {}, { baseline: read('eval-t-base', 0), candidate: read('eval-t-next', 8) });

    expect(compared.verdict).toBe('regressed');
    expect(compared.platform?.tasks[0]?.candidate).toMatchObject({ trials: 10, bugTrials: 8, exceptions: 8, canceled: 30 });
    expect(compareEvalResults(before, after, {}, { baseline: read('eval-t-base', 0), candidate: { measured: false, why: 'no token' } }).verdict).toBe('unchanged');
    expect(renderEvalComparison(compared)).toContain('| t | 0/10: 0 thrown, 0 over limits, 0 idle wakes, 30 cancelled | 8/10: 8 thrown');
  });

  test('the run report gives each task\u2019s failed calls by tool and cause, and every value beside its change', () => {
    const failing = (count: number) => trialsOf(9, 10, { inputTokens: 1000, toolFailures: [{ tool: 'file', cause: 'bad_input', count }] });
    const rendered = renderEvalComparison(compareEvalResults(report('t', failing(1), BASE), report('t', failing(2), NEXT)));

    expect(rendered).toContain('| `file` | bad_input | 10 | 20 |');
    expect(rendered).toContain('| **Run** | 90.0% (0 pp) |');
    expect(rendered).toMatch(/\| t \| 90\.0% \(0 pp\) \|[^\n]*\| 2\.0 \(\+1\.0\) \|/u);
  });

  // The exact test needs four trials a side to call any fall; below that a run cannot say a task held.
  test.each([
    { trials: 3, before: 3, after: 0, verdict: 'regressed' },
    { trials: 3, before: 1, after: 0, verdict: 'regressed' },
    { trials: 3, before: 3, after: 1, verdict: 'inconclusive' },
    { trials: 3, before: 3, after: 3, verdict: 'inconclusive' },
    { trials: 4, before: 4, after: 4, verdict: 'unchanged' },
    { trials: 5, before: 5, after: 1, verdict: 'regressed' },
    { trials: 5, before: 5, after: 2, verdict: 'unchanged' },
  ])('$before/$trials \u2192 $after/$trials is $verdict', ({ trials, before, after, verdict }) => {
    const comparison = compareEvalResults(report('t', trialsOf(before, trials), BASE), report('t', trialsOf(after, trials), NEXT));

    expect(comparison.verdict).toBe(verdict);

    if (verdict === 'inconclusive') expect(renderEvalComparison(comparison)).toContain('Too few trials to tell any fall from noise');
  });

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

  test('a turn that hung fails on the build: counted, compared and named, never infrastructure', () => {
    const hung = 'the workspace stayed busy with its ledger silent for 361 s: held by working helper task-helper';
    const hanging = report('t', [...trialsOf(1, 9), { pass: false, hung }], NEXT);
    const comparison = compareEvalResults(report('t', trialsOf(9, 10), BASE), hanging);

    expect(validateEvalResults(hanging, 10)).toHaveLength(1);
    expect([comparison.verdict, comparison.rows[0]?.reason]).toEqual(['regressed', null]);
    expect(renderEvalComparison(comparison)).toContain('`t1 deployment.hung` | 0 | 1 |');
  });

  // A run cancelled with trials open did not finish them: no result for or against the build, and no verdict.
  test('a report with trials the run cancelled is incomplete, naming each and what held it', () => {
    const cancelled = 'cancelled by SIGTERM, held by running shell job bgjob-server (workspace: node server.js) for 1450 s';
    const text = report('t', [...trialsOf(8, 9), { pass: false, cancelled, heldBy: ['running shell job'], trial: 10 }], NEXT);

    expect(() => validateEvalResults(text, 10)).toThrow(`t on workers-ai/@cf/zai-org/glm-5.3 (product) was cancelled with trials open: trial 10: ${cancelled}`);
    expect(whyIncomplete(text, { trials: 10 })).toContain(`trial 10: ${cancelled}`);
  });

  test('a hang is counted by what held it, so a silent job is never read as a model hang', () => {
    const job = { pass: false, hung: 'held by running shell job bgjob-server (workspace: node server.js)', heldBy: ['running shell job'] };
    const run = { pass: false, hung: 'held by open run run-1', heldBy: ['open run'] };
    const markdown = renderEvalComparison(compareEvalResults(report('t', trialsOf(10, 10), BASE), report('t', [...trialsOf(7, 8), job, run], NEXT)));

    expect(markdown).toContain('`t1 deployment.hung (held by running shell job)` | 0 | 1 |');
    expect(markdown).toContain('`t1 deployment.hung (held by open run)` | 0 | 1 |');
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

describe('metric accounting', () => {
  test('cache rates weight prompt tokens within cohorts and across unequal tasks, separately on each model and side', () => {
    const model = 'opencode-go/muse-spark-1.3-contributor';

    const leg = (side: { productSha: string; evalCommit: string }, reads: readonly [number, number, number]) => JSON.stringify({
      testResults: [
        fileResult('alpha', [
          { pass: true, model, inputTokens: 100, cacheReadTokens: reads[0] },
          { pass: false, model, inputTokens: 900, cacheReadTokens: reads[1] },
        ], side),
        fileResult('beta', [
          { pass: true, model, inputTokens: 2000, cacheReadTokens: reads[2] },
          { pass: true, model: 'openrouter/inception/mercury-2.5', inputTokens: 10_000, cacheReadTokens: 0 },
        ], side),
      ],
    });

    const comparison = compareEvalResults(leg(BASE, [60, 360, 1800]), leg(NEXT, [20, 180, 600]));
    const cohort = comparison.rows.find((row) => row.taskId === 'alpha' && row.model === model);
    const pooled = comparison.profiles.find((profile) => profile.model === model);

    expect(cohort?.baseline?.cacheHitRate).toBe(0.42);
    expect(cohort?.candidate?.cacheHitRate).toBe(0.2);
    expect(pooled?.baseline?.cacheHitRate).toBe(0.74);
    expect(pooled?.candidate.cacheHitRate).toBeCloseTo(0.2666666667, 10);
  });

  test('a missing prompt or cache-read count invalidates the whole non-infra cohort and pooled model', () => {
    for (const missing of [{ inputTokens: 900 }, { cacheReadTokens: 360 }, {}]) {
      const comparison = compareEvalResults(null, report('t', [
        { pass: true, inputTokens: 100, cacheReadTokens: 60 },
        { pass: false, ...missing },
      ], NEXT));

      expect(comparison.rows[0]?.candidate?.cacheHitRate).toBeNull();
      expect(comparison.profiles[0]?.candidate.cacheHitRate).toBeNull();
    }
  });

  test('infra trials do not enter cache rates, resets do, and all attempted trials still enter spend', () => {
    const infra: Trial[] = [
      { pass: false, infra: true, inputTokens: 100_000, cacheReadTokens: 0, costUsd: 0.1 },
      { pass: false, harnessInfra: true, costUsd: 0.2 },
    ];

    const comparison = compareEvalResults(null, report('t', [
      { pass: true, inputTokens: 100, cacheReadTokens: 60, costUsd: 0.01 },
      { pass: false, reset: 'the isolate was reset for memory', inputTokens: 100, cacheReadTokens: 0, costUsd: 0.03 },
      ...infra,
    ], NEXT));

    expect(comparison.rows[0]?.candidate?.cacheHitRate).toBe(0.3);
    expect(comparison.profiles[0]?.candidate.cacheHitRate).toBe(0.3);
    expect(comparison.totals.candidate.costUsd).toBeCloseTo(0.34, 10);
    expect(compareEvalResults(null, report('t', infra, NEXT)).rows[0]?.candidate?.cacheHitRate).toBeNull();
  });

  test('the report distinguishes an unreported cache count from a reported cold cache', () => {
    const comparison = compareEvalResults(
      report('t', [{ pass: true, inputTokens: 100 }], BASE),
      report('t', [{ pass: true, inputTokens: 100, cacheReadTokens: 0 }], NEXT),
    );

    expect(renderEvalComparison(comparison)).toContain('— → 0.0%');
  });

  test('one unreported cost makes cohort, model and suite cost unknown, but a reported zero remains measured', () => {
    const compare = (lastCost?: number) => compareEvalResults(null, report('t', [
      { pass: true, costUsd: 0.01 }, { pass: false, costUsd: lastCost },
    ], NEXT));

    const unknown = compare();
    const known = compare(0);

    expect(unknown.rows[0]?.candidate?.meanCostUsd).toBeNull();
    expect(unknown.profiles[0]?.candidate.meanCostUsd).toBeNull();
    expect(unknown.totals.candidate.costUsd).toBeNull();
    expect(known.rows[0]?.candidate?.meanCostUsd).toBe(0.005);
    expect(known.profiles[0]?.candidate.meanCostUsd).toBe(0.005);
    expect(known.totals.candidate.costUsd).toBe(0.01);
  });

  test('suite wall spans the earliest start to the latest end, not summed concurrent durations or file order', () => {
    const baseline = JSON.stringify({ testResults: [
      fileResult('late', [{ pass: true, durationMs: 180_000 }], BASE, { startTime: 61_000, endTime: 241_000 }),
      fileResult('early', [{ pass: true, durationMs: 120_000 }, { pass: true, durationMs: 90_000 }], BASE,
        { startTime: 1000, endTime: 121_000 }),
    ] });

    const candidate = JSON.stringify({ testResults: [
      fileResult('late', [{ pass: true, durationMs: 180_000 }], NEXT, { startTime: 101_000, endTime: 281_000 }),
      fileResult('early', [{ pass: true, durationMs: 120_000 }, { pass: true, durationMs: 90_000 }], NEXT,
        { startTime: 21_000, endTime: 141_000 }),
    ] });

    const comparison = compareEvalResults(baseline, candidate);

    expect(comparison.totals.baseline?.wallTimeMs).toBe(240_000);
    expect(comparison.totals.candidate.wallTimeMs).toBe(260_000);
    expect(compareEvalResults(null, report('t', [{ pass: true }], NEXT)).totals.candidate.wallTimeMs).toBeNull();
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

  test('a task whose trials were skipped is named with how many did not run, not as a schema error', () => {
    // The 2026-10-01 staging pass: eight task files' suites failed before their trials, which the report lists as
    // "skipped" with no harness run. The verdict must say which tasks did not run.
    const skipped = { name: '/repo/evals/tasks/budget-board.eval.ts', assertionResults: [1, 2, 3].map(() => ({ status: 'skipped', meta: {} })) };
    const text = leg.replace(/\]\}\s*$/, `,${JSON.stringify(skipped)}]}`);

    expect(whyIncomplete(text, { trials: 10 })).toBe('budget-board.eval.ts: 3 of its trials did not run (skipped)');
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
