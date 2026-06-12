/**
 * Unit tests: sibling diversity at MCTS expansion (DO-NOW #1).
 */

import { describe, test, expect } from 'bun:test';
import { diversityAngle, siblingAngles, diversityDirective } from '../src/mcts/diversity.js';

describe('diversity angles', () => {
  test('single branch gets no siblings and an empty directive', () => {
    expect(siblingAngles(0, 1)).toEqual([]);
    expect(diversityDirective(siblingAngles(0, 1))).toBe('');
  });

  test('each branch in an N-way expansion is handed every OTHER branch angle', () => {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const sibs = siblingAngles(i, n);
      expect(sibs.length).toBe(n - 1);
      // A branch never sees its own angle in its sibling list.
      expect(sibs).not.toContain(diversityAngle(i, n));
    }
  });

  test('sibling angles are DISTINCT within one expansion (no near-duplicate prompts)', () => {
    const n = 4;
    const angles = Array.from({ length: n }, (_, i) => diversityAngle(i, n));
    expect(new Set(angles).size).toBe(n);
  });

  test('directive names the sibling angles and demands a distinct approach', () => {
    const directive = diversityDirective(['the simplest possible solution']);
    expect(directive).toContain('the simplest possible solution');
    expect(directive).toMatch(/DISTINCT/);
  });
});
