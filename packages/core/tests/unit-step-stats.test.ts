// Step telemetry aggregates. The contract under test is that nothing here
// invents a number: an absent rate stays absent, an unpriced step stays
// unpriced, a field no step reported stays absent from the totals, and an empty
// sample reports null rather than zero.
import { describe, test, expect } from 'bun:test';
import { cacheHitRate, summarizeSteps, type StepCost, type Usage } from '../src/index.ts';

/** A step whose provider reported `u`, priced at `usd` when given. */
const step = (usage: Usage, usd?: number): StepCost =>
  (usd === undefined ? { usage } : { usage, usd });

describe('cacheHitRate', () => {
  test('is the cache-read share of input, which is a subset of it', () => {
    expect(cacheHitRate({ input: 1000, cacheRead: 750 })).toBe(0.75);
    expect(cacheHitRate({ input: 1000, cacheRead: 0 })).toBe(0);
    expect(cacheHitRate({ input: 1000, cacheRead: 1000 })).toBe(1);
  });

  test('a step with no input has no hit rate — 0% would read as a cache miss', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0 })).toBeNull();
  });

  test('an UNREPORTED cache read has no hit rate, where a reported zero has one', () => {
    // The distinction this type exists for. Workers AI reports
    // prompt_tokens_details.cached_tokens: 0 (a real cold prompt, rate 0), while
    // a provider that mentions caching not at all has no rate to report — and
    // rendering that as 0% would claim a total miss on absent evidence.
    expect(cacheHitRate({ input: 1000, cacheRead: 0 })).toBe(0);
    expect(cacheHitRate({ input: 1000 })).toBeNull();
  });

  test('an unreported input has no hit rate even when cacheRead is known', () => {
    expect(cacheHitRate({ cacheRead: 500 })).toBeNull();
  });

  test('a report of nothing has no hit rate', () => {
    expect(cacheHitRate({})).toBeNull();
  });
});

describe('summarizeSteps', () => {
  test('sums the provider-reported tokens verbatim', () => {
    const t = summarizeSteps([
      step({ input: 100, cacheRead: 50, output: 10, reasoning: 5 }),
      step({ input: 200, cacheRead: 150, output: 20, reasoning: 0 }),
    ], { windowLimit: 50 });
    expect(t.tokens).toEqual({ input: 300, cacheRead: 200, output: 30, reasoning: 5 });
    expect(t.steps).toBe(2);
    expect(t.windowLimit).toBe(50);
  });

  test('a field NO step reported is absent from the totals, not summed to zero', () => {
    const t = summarizeSteps([
      step({ input: 100, output: 10 }),
      step({ input: 200, output: 20 }),
    ], { windowLimit: 50 });
    expect(t.tokens).toEqual({ input: 300, output: 30 });
    expect('cacheRead' in t.tokens).toBe(false);
    expect('reasoning' in t.tokens).toBe(false);
    expect('cacheWrite1h' in t.tokens).toBe(false);
  });

  test('a field only some steps reported totals only those steps', () => {
    const t = summarizeSteps([
      step({ input: 100, output: 10 }),
      step({ input: 200, output: 20, cacheWrite: 64, cacheWrite1h: 32 }),
    ], { windowLimit: 50 });
    expect(t.tokens.cacheWrite).toBe(64);
    expect(t.tokens.cacheWrite1h).toBe(32);
  });

  test('the provider-reported neuron figure accumulates', () => {
    const t = summarizeSteps([
      step({ input: 88, output: 24, neurons: 19.2 }),
      step({ input: 92, output: 21, neurons: 6.2 }),
    ], { windowLimit: 50 });
    expect(t.tokens.neurons).toBeCloseTo(25.4, 5);
  });

  test('steps whose provider reported nothing are counted, not silently free', () => {
    const t = summarizeSteps([
      step({ input: 100, output: 10 }),
      step({}),
      step({}),
    ], { windowLimit: 50 });
    expect(t.steps).toBe(3);
    expect(t.stepsWithoutUsage).toBe(2);
    // The totals cover only the one reporting step, and the counter says so.
    expect(t.tokens).toEqual({ input: 100, output: 10 });
  });

  test('a step reporting genuine zeros is a report, not a silence', () => {
    const t = summarizeSteps([step({ input: 0, output: 0 })], { windowLimit: 50 });
    expect(t.stepsWithoutUsage).toBe(0);
    expect(t.tokens).toEqual({ input: 0, output: 0 });
  });

  test('mean, last and nearest-rank p95 over the rate sample', () => {
    // Ten steps, hit rates 0.1 … 1.0. Nearest-rank p95 of 10 samples is the
    // ceil(0.95*10)=10th smallest, i.e. the maximum.
    const samples = Array.from({ length: 10 }, (_, i) =>
      step({ input: 100, cacheRead: (i + 1) * 10 }));
    const { cacheHit } = summarizeSteps(samples, { windowLimit: 100 });
    expect(cacheHit.samples).toBe(10);
    expect(cacheHit.last).toBeCloseTo(1.0, 10);
    expect(cacheHit.mean).toBeCloseTo(0.55, 10);
    expect(cacheHit.p95).toBeCloseTo(1.0, 10);
  });

  test('the EMA leans on the newest steps and reports its own alpha', () => {
    const cold = step({ input: 100, cacheRead: 0 });
    const warm = step({ input: 100, cacheRead: 100 });
    const { cacheHit } = summarizeSteps([cold, cold, cold, warm, warm], { windowLimit: 100, emaAlpha: 0.5 });
    // Mean is 0.4; the EMA weights the two warm steps far higher.
    expect(cacheHit.mean).toBeCloseTo(0.4, 10);
    expect(cacheHit.ema).toBeCloseTo(0.75, 10);
    expect(cacheHit.emaAlpha).toBe(0.5);
  });

  test('steps with no input are counted as steps but never as rate samples', () => {
    const t = summarizeSteps([
      step({ input: 0, output: 5 }),
      step({ input: 100, cacheRead: 40 }),
    ], { windowLimit: 10 });
    expect(t.steps).toBe(2);
    expect(t.cacheHit.samples).toBe(1);
    expect(t.cacheHit.mean).toBeCloseTo(0.4, 10);
  });

  test('steps that never mentioned caching are not rate samples', () => {
    const t = summarizeSteps([
      step({ input: 100, output: 10 }),
      step({ input: 100, output: 10 }),
    ], { windowLimit: 10 });
    expect(t.steps).toBe(2);
    // No rate is inferable from either, so the distribution is empty rather
    // than two fabricated 0% misses.
    expect(t.cacheHit.samples).toBe(0);
    expect(t.cacheHit.mean).toBeNull();
    expect(t.cacheHit.ema).toBeNull();
  });

  test('unpriced steps are counted as unpriced, never blended into the cost', () => {
    const t = summarizeSteps([
      step({ input: 100, output: 10 }, 0.25),
      step({ input: 100, output: 10 }),
    ], { windowLimit: 10 });
    expect(t.usd).toBeCloseTo(0.25, 10);
    expect(t.pricedSteps).toBe(1);
    expect(t.unpricedSteps).toBe(1);
  });

  test('an empty sample reports null rates and zero cost, never NaN', () => {
    const t = summarizeSteps([], { windowLimit: 100 });
    expect(t.steps).toBe(0);
    expect(t.usd).toBe(0);
    expect(t.stepsWithoutUsage).toBe(0);
    expect(t.tokens).toEqual({});
    expect(t.cacheHit).toMatchObject({ samples: 0, last: null, mean: null, p95: null, ema: null });
  });

  test('a single sample is its own mean, p95 and EMA', () => {
    const { cacheHit } = summarizeSteps([step({ input: 100, cacheRead: 30 })], { windowLimit: 10 });
    expect(cacheHit.mean).toBeCloseTo(0.3, 10);
    expect(cacheHit.p95).toBeCloseTo(0.3, 10);
    expect(cacheHit.ema).toBeCloseTo(0.3, 10);
  });
});
