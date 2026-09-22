// Step telemetry invents no number: absent stays absent, unpriced stays unpriced, an empty sample is null.
import { describe, test, expect } from 'bun:test';
import { summarizeSteps, type StepCost, type Usage } from '../src/index';

const step = (usage: Usage, usd?: number): StepCost =>
  (usd === undefined ? { usage } : { usage, usd });

describe('the cache hit rate, through summarizeSteps', () => {
  // An unrateable step leaves the distribution null rather than reading as a 0% miss.
  const distribution = (usage: Usage) =>
    summarizeSteps([step(usage)], { windowLimit: 50 }).cacheHit;

  test('is the cache-read share of input, which is a subset of it', () => {
    const share = distribution({ input: 1000, cacheRead: 750 });
    expect(share.samples).toBe(1);
    expect(share.last).toBe(0.75);
    expect(share.mean).toBe(0.75);
    expect(share.p95).toBe(0.75);
    expect(share.ema).toBe(0.75);
    expect(distribution({ input: 1000, cacheRead: 0 }).mean).toBe(0);
    expect(distribution({ input: 1000, cacheRead: 1000 }).mean).toBe(1);
  });

  test('a step with no input has no hit rate — 0% would read as a cache miss', () => {
    expect(distribution({ input: 0, cacheRead: 0 })).toMatchObject({
      samples: 0, last: null, mean: null, p95: null, ema: null,
    });
  });

  test('an UNREPORTED cache read has no hit rate, where a reported zero has one', () => {
    // Workers AI reports cached_tokens: 0 (a real cold prompt); a provider silent on caching has no rate.
    expect(distribution({ input: 1000, cacheRead: 0 }).mean).toBe(0);
    expect(distribution({ input: 1000 })).toMatchObject({
      samples: 0, last: null, mean: null, p95: null, ema: null,
    });
  });

  test('an unreported input has no hit rate even when cacheRead is known', () => {
    expect(distribution({ cacheRead: 500 })).toMatchObject({
      samples: 0, last: null, mean: null, p95: null, ema: null,
    });
  });

  test('a report of nothing has no hit rate', () => {
    expect(distribution({})).toMatchObject({
      samples: 0, last: null, mean: null, p95: null, ema: null,
    });
  });
});

describe('summarizeSteps', () => {
  test('p99 uses nearest rank over the same reported sample as p95', () => {
    const samples = Array.from({ length: 100 }, (_, index) => step({ input: 100, cacheRead: index + 1 }));
    const { cacheHit } = summarizeSteps(samples, { windowLimit: 100 });

    expect(cacheHit.p95).toBe(0.95);
    expect(cacheHit.p99).toBe(0.99);
    expect(summarizeSteps([step({ input: 100, cacheRead: 30 })], { windowLimit: 100 }).cacheHit.p99).toBe(0.3);
    expect(summarizeSteps([step({ input: 100 })], { windowLimit: 100 }).cacheHit.p99).toBeNull();
    expect(summarizeSteps([], { windowLimit: 100 }).cacheHit.p99).toBeNull();
  });

  test('a cache warm is counted, and moves no number the conversation earned', () => {
    const turns = [step({ input: 100, cacheRead: 40 }), step({ input: 100, cacheRead: 60 })];
    const bare = summarizeSteps(turns, { windowLimit: 100 });

    const warmed = summarizeSteps(turns, {
      windowLimit: 100,
      warms: [step({ input: 40_004, cacheRead: 40_000 }), step({ input: 40_004, cacheRead: 40_000 })],
    });

    expect(warmed.cacheHit.warms).toBe(2);
    expect(bare.cacheHit.warms).toBe(0);
    expect(warmed.cacheHit.samples).toBe(bare.cacheHit.samples);
    expect(warmed.cacheHit.ema).toBe(bare.cacheHit.ema);
    expect(warmed.cacheHit.mean).toBe(bare.cacheHit.mean);
    expect(warmed.cacheHit.p95).toBe(bare.cacheHit.p95);
    expect(warmed.cacheHit.p99).toBe(bare.cacheHit.p99);
    expect(warmed.cacheHit.last).toBe(bare.cacheHit.last);
    expect(warmed.steps).toBe(2);
    expect(warmed.tokens).toEqual(bare.tokens);
  });

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
    expect(t.tokens).toEqual({ input: 100, output: 10 });
  });

  test('a step reporting genuine zeros is a report, not a silence', () => {
    const t = summarizeSteps([step({ input: 0, output: 0 })], { windowLimit: 50 });
    expect(t.stepsWithoutUsage).toBe(0);
    expect(t.tokens).toEqual({ input: 0, output: 0 });
  });

  test('mean, last and nearest-rank p95 over the rate sample', () => {
    // Nearest-rank p95 of 10 samples is the ceil(0.95*10)=10th smallest, the maximum.
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
