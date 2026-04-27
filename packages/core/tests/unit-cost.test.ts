/**
 * Unit tests: cost estimation.
 */

import { describe, test, expect } from 'bun:test';
import { estimateCost } from '../src/mcts/cost.js';

describe('Cost estimation', () => {
  test('calculates correct total calls', () => {
    const est = estimateCost(20, 3, 3);
    // exploration: 20*3*3 = 180
    // evaluation: 20*3 = 60
    // reflection: ceil(20*3*0.3) = 18
    // total: 258
    expect(est.totalCalls).toBe(258);
  });

  test('budget=1, branches=1 is minimal', () => {
    const est = estimateCost(1, 1, 1);
    // exploration: 1, evaluation: 1, reflection: ceil(0.3) = 1
    expect(est.totalCalls).toBe(3);
  });

  test('includes USD estimate', () => {
    const est = estimateCost(20, 3);
    expect(est.estimatedUSD).toBeGreaterThan(0);
    expect(est.description).toContain('$');
  });
});
