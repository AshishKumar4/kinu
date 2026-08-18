/**
 * Unit tests: cost estimation.
 */

import { describe, test, expect } from 'bun:test';
import { describeCostBasis, estimateCost } from '../src/mcts/cost';

describe('Cost estimation', () => {
  test('calculates correct total calls', () => {
    const est = estimateCost(20, 3, 4);
    // exploration: 20*3 = 60 (one explore call per branch — single-step rollouts)
    // evaluation: 20*3*4 = 240 (maxEvalLLMCalls = 4)
    // reflection: ceil(20*3*0.3) = 18
    // total: 318
    expect(est.totalCalls).toBe(318);
  });

  test('budget=1, branches=1 is minimal', () => {
    const est = estimateCost(1, 1, 1);
    // exploration: 1, evaluation: 1, reflection: ceil(0.3) = 1
    expect(est.totalCalls).toBe(3);
  });

  test('evaluation spend scales with the per-evaluation budget knob', () => {
    const lean = estimateCost(5, 3, 1);
    const grounded = estimateCost(5, 3, 4);
    expect(grounded.totalCalls - lean.totalCalls).toBe(5 * 3 * 3);
  });

  test('includes USD estimate', () => {
    const est = estimateCost(20, 3);
    expect(est.estimatedUSD).toBeGreaterThan(0);
    expect(est.description).toContain('$');
  });
});

/**
 * The defect these pin: one static blended rate for every model at once refused
 * searches the catalog prices at nothing and waved through searches on models
 * costing an order of magnitude more than the blend.
 *
 * Rates below are the real models.dev `cost` blocks (USD per 1M tokens), read
 * from the catalog the repo already integrates: `@cf/deepseek-ai/
 * deepseek-v4-pro-0813` is the shipped Workers AI default.
 */
describe('Cost estimation is model-aware', () => {
  const DEFAULT_SPEC = 'workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813';
  const DEFAULT_RATES = { input: 1.32, output: 3.96, cacheRead: 0.044 };

  test('a priced model is charged at its own input and output rates', () => {
    const est = estimateCost(20, 3, 4, { spec: DEFAULT_SPEC, pricing: DEFAULT_RATES });
    // 318 calls x the projected 1500-in / 500-out split, at the model's rates.
    const expected = (318 * 1_500 * 1.32 + 318 * 500 * 3.96) / 1_000_000;
    expect(est.estimatedUSD).toBeCloseTo(expected, 10);
    expect(est.basis).toEqual({ source: 'catalog', model: DEFAULT_SPEC, rates: DEFAULT_RATES });
  });

  test('the blended rate is NOT the default model rate — the old figure was 1.5x too high', () => {
    const blended = estimateCost(20, 3, 4);
    const priced = estimateCost(20, 3, 4, { spec: DEFAULT_SPEC, pricing: DEFAULT_RATES });
    expect(blended.estimatedUSD).toBeGreaterThan(priced.estimatedUSD);
    expect(blended.estimatedUSD / priced.estimatedUSD).toBeCloseTo(1.515, 2);
  });

  test('a model the catalog prices at zero costs zero — and says the catalog said so', () => {
    const est = estimateCost(20, 3, 4, {
      spec: 'kuae-cloud-coding-plan/GLM-4.7',
      pricing: { input: 0, output: 0 },
    });
    expect(est.estimatedUSD).toBe(0);
    expect(est.basis.source).toBe('catalog');
    // The whole point of the gate fix: free work is not refusable at any cap.
    expect(est.estimatedUSD > 0).toBe(false);
  });

  test('an UNPRICED model is not a free model — absent reads as blended, never as zero', () => {
    const unknown = estimateCost(20, 3, 4, { spec: 'ollama-cloud/deepseek-v4-pro', pricing: null });
    expect(unknown.estimatedUSD).toBeGreaterThan(0);
    expect(unknown.basis).toEqual({
      source: 'blended',
      model: 'ollama-cloud/deepseek-v4-pro',
      usdPer1kTokens: 0.003,
    });
    // Distinguishable from the catalog-priced zero above by basis alone, which
    // is the distinction a spend gate has to be able to make.
    const free = estimateCost(20, 3, 4, { spec: 'x/y', pricing: { input: 0, output: 0 } });
    expect(free.basis.source).not.toBe(unknown.basis.source);
  });

  test('an expensive model is no longer understated by the blend', () => {
    // anthropic/claude-fable-5 — the failure mode that matters more than
    // refusing free work: the blend waved this through at a fraction of cost.
    const est = estimateCost(20, 3, 4, {
      spec: 'anthropic/claude-fable-5',
      pricing: { input: 10, output: 50 },
    });
    const blended = estimateCost(20, 3, 4);
    expect(est.estimatedUSD).toBeGreaterThan(blended.estimatedUSD * 5);
  });

  test('no model named at all still blends, and states that the price is unknown', () => {
    const est = estimateCost(20, 3, 4);
    expect(est.basis).toEqual({ source: 'blended', model: null, usdPer1kTokens: 0.003 });
    expect(est.description).toContain('unknown, not zero');
  });

  test('the projection credits no prefix cache — a search that has not run has no warm cache', () => {
    const cached = estimateCost(20, 3, 4, {
      spec: DEFAULT_SPEC,
      pricing: { input: 1.32, output: 3.96, cacheRead: 0.000001 },
    });
    const uncached = estimateCost(20, 3, 4, {
      spec: DEFAULT_SPEC,
      pricing: { input: 1.32, output: 3.96 },
    });
    expect(cached.estimatedUSD).toBeCloseTo(uncached.estimatedUSD, 10);
  });
});

describe('describeCostBasis — the clause a refusal shows a human', () => {
  test('a catalog basis names the model and both rates', () => {
    const clause = describeCostBasis({
      source: 'catalog',
      model: 'workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813',
      rates: { input: 1.32, output: 3.96 },
    });
    expect(clause).toContain('workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813');
    expect(clause).toContain('$1.32/1M in');
    expect(clause).toContain('$3.96/1M out');
  });

  test('a blended basis names the model and says the price is unknown, not zero', () => {
    const clause = describeCostBasis({
      source: 'blended', model: 'ollama-cloud/kimi-k3', usdPer1kTokens: 0.003,
    });
    expect(clause).toContain('ollama-cloud/kimi-k3');
    expect(clause).toContain('unpriced in the catalog');
    expect(clause).toContain('unknown, not zero');
  });
});
