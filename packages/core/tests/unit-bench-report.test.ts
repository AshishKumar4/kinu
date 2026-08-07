import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_ATTEMPT_BUDGET, GAIN_CALIBRATION, attemptPassed, benchConfigHash,
  buildBenchReport, buildGainReport, caseIsUnstable, decideBenchOutcome,
  pairedBinaryComparison, renderBenchSummary, renderGainSummary, runOrder, usageTokens,
} from '../src/index.ts';
import type {
  AttemptOutcome, BenchRunConfig, PairedOutcome, SealedScorecard,
} from '../src/index.ts';

const CONFIG: BenchRunConfig = {
  corpus: 'tests/bench/tasks.jsonl',
  budget: DEFAULT_ATTEMPT_BUDGET,
  seed: 1,
  variantA: 'baseline',
  variantB: 'candidate',
  repeats: 1,
  manifestHash: 'abc123',
};

function attempt(taskId: string, variantId: string, passed: boolean, extra: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return {
    taskId, variantId, slot: variantId === CONFIG.variantA ? 'a' : 'b', repeat: 0,
    passed, checks: [{ id: 'c', passed, exitCode: passed ? 0 : 1, durationMs: 5, output: '' }],
    durationMs: 10, tokens: 100, peakPromptTokens: 1000, budgetBreach: null, ...extra,
  };
}

/** All the repeats of one task under one variant. */
function repeats(taskId: string, variantId: string, passes: readonly boolean[]): AttemptOutcome[] {
  return passes.map((passed, repeat) => attempt(taskId, variantId, passed, { repeat }));
}

function scorecard(spec: { a: boolean; b: boolean }[]): SealedScorecard {
  const outcomes: PairedOutcome[] = spec.map((s, i) => ({ taskId: `s${i}`, a: [s.a], b: [s.b] }));
  return { tasks: spec.length, manifestHash: 'sealed-hash', stats: pairedBinaryComparison(outcomes, { seed: 1, iterations: 1000 }) };
}

describe('benchConfigHash', () => {
  test('changes when the budget changes — two envelopes are not comparable', () => {
    const bigger = { ...CONFIG, budget: { ...CONFIG.budget, maxTokens: CONFIG.budget.maxTokens * 2 } };
    expect(benchConfigHash(bigger)).not.toBe(benchConfigHash(CONFIG));
  });

  test('changes when the repeat count changes — pass^3 is not pass^1', () => {
    expect(benchConfigHash({ ...CONFIG, repeats: 3 })).not.toBe(benchConfigHash(CONFIG));
  });

  test('changes when the corpus manifest changes', () => {
    expect(benchConfigHash({ ...CONFIG, manifestHash: 'other' })).not.toBe(benchConfigHash(CONFIG));
  });

  test('is stable for identical config', () => {
    expect(benchConfigHash({ ...CONFIG })).toBe(benchConfigHash(CONFIG));
  });
});

describe('buildBenchReport', () => {
  test('pairs attempts by task and counts budget breaches', () => {
    const report = buildBenchReport({
      runId: 'r1', config: CONFIG, sealed: null, sealAccessOrdinal: null,
      devAttempts: [
        attempt('t1', 'baseline', false), attempt('t1', 'candidate', true),
        attempt('t2', 'baseline', true), attempt('t2', 'candidate', false, { budgetBreach: 'wall-clock' }),
      ],
    });
    expect(report.dev.tasks).toBe(2);
    expect(report.dev.stats.onlyA).toBe(1);
    expect(report.dev.stats.onlyB).toBe(1);
    expect(report.budgetBreaches).toBe(1);
    expect(report.dev.cases.map((c) => c.taskId)).toEqual(['t1', 't2']);
  });

  test('an unpaired task is an error — a paired design cannot drop half a pair', () => {
    expect(() => buildBenchReport({
      runId: 'r1', config: CONFIG, sealed: null, sealAccessOrdinal: null,
      devAttempts: [attempt('t1', 'baseline', false)],
    })).toThrow(/unpaired/);
  });

  test('a missing repeat is an error too — a lost attempt would silently change pass^k', () => {
    const config = { ...CONFIG, repeats: 3 };
    expect(() => buildBenchReport({
      runId: 'r1', config, sealed: null, sealAccessOrdinal: null,
      devAttempts: [
        ...repeats('t1', 'baseline', [false, false, false]),
        ...repeats('t1', 'candidate', [true, true]),
      ],
    })).toThrow(/expected 3 attempt\(s\) per variant, got 3 and 2/);
  });

  test('folds repeats into one case row and averages the per-attempt cost', () => {
    const config = { ...CONFIG, repeats: 3 };
    const report = buildBenchReport({
      runId: 'r1', config, sealed: null, sealAccessOrdinal: null,
      devAttempts: [
        ...repeats('t1', 'baseline', [true, false, true]),
        ...repeats('t1', 'candidate', [true, true, true]),
        // Emitted out of repeat order on purpose: the report must not depend
        // on the order the runner happened to produce.
        attempt('t2', 'baseline', false, { repeat: 1, tokens: 400, durationMs: 30, peakPromptTokens: 9000 }),
        attempt('t2', 'baseline', false, { repeat: 0, tokens: 200, durationMs: 10, peakPromptTokens: 3000 }),
        attempt('t2', 'baseline', false, { repeat: 2, tokens: 300, durationMs: 20, budgetBreach: 'tokens', peakPromptTokens: 6000 }),
        ...repeats('t2', 'candidate', [false, false, false]),
      ],
    });
    const [t1, t2] = report.dev.cases;
    expect(t1).toMatchObject({ taskId: 't1', attempts: 3, passesA: 2, passesB: 3 });
    expect(t2).toMatchObject({ taskId: 't2', attempts: 3, passesA: 0, passesB: 0 });
    // Mean per attempt, so a k=3 row reads against the same per-attempt budget.
    expect(t2!.tokensA).toBe(300);
    // Cost fields are means so a k=3 row reads against the same per-attempt
    // budget a k=1 row does — except the PEAK, which is a maximum: averaging
    // peaks would report a working set no attempt ever reached.
    expect(t2!.peakPromptTokensA).toBe(9000);
    expect(t2!.durationMsA).toBe(20);
    expect(t2!.breachA).toBe('tokens');
    expect(report.budgetBreaches).toBe(1);
    expect(caseIsUnstable(t1!)).toBe(true);
    expect(caseIsUnstable(t2!)).toBe(false);
    // pass@1 counts every attempt; pass^3 counts only clean sweeps.
    expect(report.dev.stats.passAtOneA).toBeCloseTo(1 / 3, 10);
    expect(report.dev.stats.passAllA).toBe(0);
    expect(report.dev.stats.passAllB).toBe(0.5);
  });

  test('an attempt from an unknown variant is refused', () => {
    expect(() => buildBenchReport({
      runId: 'r1', config: CONFIG, sealed: null, sealAccessOrdinal: null,
      devAttempts: [attempt('t1', 'someone-else', true)],
    })).toThrow(/unknown variant/);
  });
});

describe('decideBenchOutcome — rejection by default', () => {
  test('no held-out measurement rejects, however good dev looked', () => {
    expect(decideBenchOutcome(null).accept).toBe(false);
  });

  test('a split too small to reach significance rejects and says to grow it', () => {
    const decision = decideBenchOutcome(scorecard(Array.from({ length: 4 }, () => ({ a: false, b: true }))));
    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain('grow the corpus');
  });

  test('a negative held-out effect rejects', () => {
    const decision = decideBenchOutcome(scorecard(Array.from({ length: 8 }, () => ({ a: true, b: false }))));
    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain('not an improvement');
  });

  test('an improvement that is not significant rejects', () => {
    const decision = decideBenchOutcome(scorecard([
      { a: false, b: true }, { a: false, b: true }, { a: true, b: false },
      ...Array.from({ length: 9 }, () => ({ a: true, b: true })),
    ]));
    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain('not significant');
  });

  test('a significant held-out improvement is kept, with a power caveat when underpowered', () => {
    const decision = decideBenchOutcome(scorecard(Array.from({ length: 6 }, () => ({ a: false, b: true }))));
    expect(decision.accept).toBe(true);
    expect(decision.reason).toContain('significant');
    // 6 pairs cannot have 80% power for any attainable effect; the finding
    // stands but the magnitude is flagged as inflated.
    expect(decision.caveat).toContain('overestimate');
  });

  test('variants that never disagreed reject', () => {
    const decision = decideBenchOutcome(scorecard(Array.from({ length: 10 }, () => ({ a: true, b: true }))));
    expect(decision.accept).toBe(false);
    expect(decision.reason).toContain('never disagreed');
  });
});

describe('renderBenchSummary', () => {
  test('shows the budget, the seal ordinal, and the decision', () => {
    const report = buildBenchReport({
      runId: 'r1', config: CONFIG,
      devAttempts: [attempt('t1', 'baseline', false), attempt('t1', 'candidate', true)],
      sealed: scorecard(Array.from({ length: 6 }, () => ({ a: false, b: true }))),
      sealAccessOrdinal: 3,
    });
    const text = renderBenchSummary(report);
    expect(text).toContain('Budget: 300000ms wall-clock');
    expect(text).toContain('opened 3 time(s)');
    expect(text).toContain('DECISION: KEEP');
    expect(text).toContain('caveat:');
    expect(text).toContain('McNemar exact');
  });

  test('reports pass^k next to pass@1 and names the unstable tasks', () => {
    const config = { ...CONFIG, repeats: 3 };
    const report = buildBenchReport({
      runId: 'r1', config, sealed: null, sealAccessOrdinal: null,
      devAttempts: [
        ...repeats('steady', 'baseline', [true, true, true]),
        ...repeats('steady', 'candidate', [true, true, true]),
        ...repeats('wobbly', 'baseline', [true, false, true]),
        ...repeats('wobbly', 'candidate', [false, false, false]),
      ],
    });
    const text = renderBenchSummary(report);
    expect(text).toContain('Repeats: 3 attempt(s) per task per variant');
    expect(text).toContain('pass@1 A=83.3%  B=50.0%');
    expect(text).toContain('pass^3 A=50.0%  B=50.0%');
    expect(text).toContain('unstable: 1/2 task(s) (A=1, B=0)');
    expect(text).toContain('UNSTABLE on dev (repeats disagreed): 1/2 task(s)');
    expect(text).toContain('wobbly');
    expect(text).toContain('A=2/3');
    expect(text).toContain('~unstable');
    expect(text).toContain('exact sign test over tasks');
    expect(text).toContain('repeats buy precision within a task');
  });

  test('says every task agreed when the repeats were unanimous', () => {
    const config = { ...CONFIG, repeats: 2 };
    const report = buildBenchReport({
      runId: 'r1', config, sealed: null, sealAccessOrdinal: null,
      devAttempts: [
        ...repeats('t1', 'baseline', [false, false]),
        ...repeats('t1', 'candidate', [true, true]),
      ],
    });
    expect(renderBenchSummary(report)).toContain('UNSTABLE on dev: none');
  });

  test('says so plainly when the seal was never opened', () => {
    const report = buildBenchReport({
      runId: 'r1', config: CONFIG, sealed: null, sealAccessOrdinal: null,
      devAttempts: [attempt('t1', 'baseline', false), attempt('t1', 'candidate', true)],
    });
    expect(renderBenchSummary(report)).toContain('SEALED split: not opened');
    expect(renderBenchSummary(report)).toContain('DECISION: REJECT');
  });
});

describe('gain report', () => {
  test('reports a zero gain as a real result, with the calibration attached', () => {
    const report = buildGainReport({
      runId: 'g1', config: CONFIG,
      perTask: [
        { taskId: 't1', index: 0, stateful: 1, stateless: 1 },
        { taskId: 't2', index: 1, stateful: 0, stateless: 0 },
        { taskId: 't3', index: 2, stateful: 1, stateless: 1 },
      ],
    });
    expect(report.stats.gain).toBe(0);
    expect(report.calibration).toBe(GAIN_CALIBRATION);
    const text = renderGainSummary(report);
    expect(text).toContain('no measurable contribution');
    expect(text).toContain('CL-Bench reference');
  });

  test('orders the sequence by index so the learning curve reads left to right', () => {
    const report = buildGainReport({
      runId: 'g1', config: CONFIG,
      perTask: [
        { taskId: 'c', index: 2, stateful: 1, stateless: 0 },
        { taskId: 'a', index: 0, stateful: 0, stateless: 0 },
        { taskId: 'b', index: 1, stateful: 1, stateless: 0 },
      ],
    });
    expect(report.sequence).toEqual(['a', 'b', 'c']);
    expect(report.stats.normalizedGain).toBeCloseTo(2 / 3, 10);
  });
});

describe('run mechanics', () => {
  test('runOrder is deterministic per seed and varies across tasks', () => {
    expect(runOrder('t1', 7)).toBe(runOrder('t1', 7));
    const orders = new Set(Array.from({ length: 40 }, (_, i) => runOrder(`task-${i}`, 3)));
    expect(orders).toEqual(new Set(['ab', 'ba']));
  });

  test('usageTokens reads the ai-v6 LanguageModelV2 shape', () => {
    // Captured verbatim from a real doStream finish part — inputTokens and
    // outputTokens are OBJECTS here, and summing them directly yields a string.
    const usage = {
      inputTokens: { total: 1234, noCache: 1234, cacheRead: 0 },
      outputTokens: { total: 56, text: 56, reasoning: 0 },
      raw: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
    };
    expect(usageTokens(usage)).toBe(1290);
  });

  test('usageTokens also reads the normalized plain-number shape', () => {
    expect(usageTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15);
  });

  test('usageTokens never returns a non-number, whatever a provider sends', () => {
    for (const bad of [undefined, null, 'nonsense', 42, {}, { inputTokens: {} }, { inputTokens: NaN, outputTokens: 3 }]) {
      const result = usageTokens(bad);
      expect(typeof result).toBe('number');
      expect(Number.isFinite(result)).toBe(true);
    }
    expect(usageTokens({ inputTokens: NaN, outputTokens: 3 })).toBe(3);
  });

  test('attemptPassed requires every check, and no checks is not a pass', () => {
    expect(attemptPassed([])).toBe(false);
    expect(attemptPassed([{ id: 'a', passed: true, exitCode: 0, durationMs: 1, output: '' }])).toBe(true);
    expect(attemptPassed([
      { id: 'a', passed: true, exitCode: 0, durationMs: 1, output: '' },
      { id: 'b', passed: false, exitCode: 1, durationMs: 1, output: '' },
    ])).toBe(false);
  });
});
