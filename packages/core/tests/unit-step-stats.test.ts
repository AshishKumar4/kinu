// Step telemetry aggregates. The contract under test is that nothing here
// invents a number: an absent rate stays absent, an unpriced step stays
// unpriced, and an empty sample reports null rather than zero.
import { describe, test, expect } from 'bun:test';
import { cacheHitRate, summarizeSteps, type StepUsage } from '../src/index.ts';

const step = (u: Partial<StepUsage>): StepUsage =>
  ({ input: 0, cached: 0, output: 0, reasoning: 0, ...u });

describe('cacheHitRate', () => {
  test('is the cached share of input, which is a subset of it', () => {
    expect(cacheHitRate({ input: 1000, cached: 750 })).toBe(0.75);
    expect(cacheHitRate({ input: 1000, cached: 0 })).toBe(0);
    expect(cacheHitRate({ input: 1000, cached: 1000 })).toBe(1);
  });

  test('a step with no input has no hit rate — 0% would read as a cache miss', () => {
    expect(cacheHitRate({ input: 0, cached: 0 })).toBeNull();
  });
});

describe('summarizeSteps', () => {
  test('sums the provider-reported tokens verbatim', () => {
    const t = summarizeSteps([
      step({ input: 100, cached: 50, output: 10, reasoning: 5 }),
      step({ input: 200, cached: 150, output: 20, reasoning: 0 }),
    ], { windowLimit: 50 });
    expect(t.tokens).toEqual({ input: 300, cached: 200, output: 30, reasoning: 5 });
    expect(t.steps).toBe(2);
    expect(t.windowLimit).toBe(50);
  });

  test('mean, last and nearest-rank p95 over the rate sample', () => {
    // Ten steps, hit rates 0.1 … 1.0. Nearest-rank p95 of 10 samples is the
    // ceil(0.95*10)=10th smallest, i.e. the maximum.
    const samples = Array.from({ length: 10 }, (_, i) =>
      step({ input: 100, cached: (i + 1) * 10 }));
    const { cacheHit } = summarizeSteps(samples, { windowLimit: 100 });
    expect(cacheHit.samples).toBe(10);
    expect(cacheHit.last).toBeCloseTo(1.0, 10);
    expect(cacheHit.mean).toBeCloseTo(0.55, 10);
    expect(cacheHit.p95).toBeCloseTo(1.0, 10);
  });

  test('the EMA leans on the newest steps and reports its own alpha', () => {
    const cold = step({ input: 100, cached: 0 });
    const warm = step({ input: 100, cached: 100 });
    const { cacheHit } = summarizeSteps([cold, cold, cold, warm, warm], { windowLimit: 100, emaAlpha: 0.5 });
    // Mean is 0.4; the EMA weights the two warm steps far higher.
    expect(cacheHit.mean).toBeCloseTo(0.4, 10);
    expect(cacheHit.ema).toBeCloseTo(0.75, 10);
    expect(cacheHit.emaAlpha).toBe(0.5);
  });

  test('steps with no input are counted as steps but never as rate samples', () => {
    const t = summarizeSteps([
      step({ input: 0, output: 5 }),
      step({ input: 100, cached: 40 }),
    ], { windowLimit: 10 });
    expect(t.steps).toBe(2);
    expect(t.cacheHit.samples).toBe(1);
    expect(t.cacheHit.mean).toBeCloseTo(0.4, 10);
  });

  test('unpriced steps are counted as unpriced, never blended into the cost', () => {
    const t = summarizeSteps([
      step({ input: 100, output: 10, usd: 0.25 }),
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
    expect(t.cacheHit).toMatchObject({ samples: 0, last: null, mean: null, p95: null, ema: null });
  });

  test('a single sample is its own mean, p95 and EMA', () => {
    const { cacheHit } = summarizeSteps([step({ input: 100, cached: 30 })], { windowLimit: 10 });
    expect(cacheHit.mean).toBeCloseTo(0.3, 10);
    expect(cacheHit.p95).toBeCloseTo(0.3, 10);
    expect(cacheHit.ema).toBeCloseTo(0.3, 10);
  });
});
