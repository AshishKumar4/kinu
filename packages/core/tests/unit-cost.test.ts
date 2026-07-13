/**
 * Unit tests: cost estimation.
 */

import { describe, test, expect } from 'bun:test';
import { estimateCost } from '../src/mcts/cost.js';

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
