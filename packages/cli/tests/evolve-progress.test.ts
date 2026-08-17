/**
 * `proteus evolve` progress rendering. An evolution cycle spends minutes inside
 * runMCTS, so every search event has to reach the terminal — and a branch that
 * died on a provider error has to say so, since the engine scores it 0 and
 * carries on.
 */
import { describe, expect, test } from 'bun:test';
import type { MCTSProgressEvent } from '@proteus/core';
import { formatMctsProgress } from '../src/commands/evolve.js';

describe('evolve progress rendering', () => {
  test('a phase becomes transient status with the iteration and branch count', () => {
    const line = formatMctsProgress(
      { rootId: 'r1', type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 2, branches: 3 },
      2,
    );

    expect(line.sink).toBe('status');
    expect(line.text).toContain('[1/2]');
    expect(line.text).toContain('exploring 3 branches');
  });

  test('phases name what they are doing, and a single branch reads singular', () => {
    const phases: Array<MCTSProgressEvent & { type: 'phase' }> = [
      { rootId: 'r1', type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 1, branches: 1 },
      { rootId: 'r1', type: 'phase', phase: 'evaluate', iteration: 1, remainingBudget: 1, branches: 1 },
      { rootId: 'r1', type: 'phase', phase: 'reflect', iteration: 1, remainingBudget: 1, branches: 1 },
    ];

    expect(phases.map(p => formatMctsProgress(p, 1).text)).toEqual([
      '[1/1] exploring 1 branch...',
      '[1/1] evaluating 1 branch...',
      '[1/1] reflecting on 1 branch...',
    ]);
  });

  test('a branch failure is a persistent line naming the branch, stage and provider error', () => {
    const line = formatMctsProgress({
      rootId: 'r1',
      type: 'branch-failed',
      stage: 'explore',
      iteration: 2,
      branchId: 'a1b2c3d4-e5f6g7h8',
      error: 'Failed after 3 attempts. Last error: 429 rate limited',
    }, 4);

    expect(line.sink).toBe('log');
    expect(line.text).toContain('[2/4]');
    expect(line.text).toContain('a1b2c3d4-e5f6g7h8');
    expect(line.text).toContain('(explore)');
    expect(line.text).toContain('Failed after 3 attempts. Last error: 429 rate limited');
  });

  test('a completed iteration keeps its scores in the scrollback', () => {
    const line = formatMctsProgress(
      { rootId: 'r1', type: 'iteration-complete', iteration: 1, remainingBudget: 1, scores: [0.82, 0] },
      2,
    );

    expect(line.sink).toBe('log');
    expect(line.text).toContain('[1/2]');
    expect(line.text).toContain('scores 0.82, 0.00');
  });

  test('an unsupported branch language is visible as unverified grounding', () => {
    const line = formatMctsProgress({
      rootId: 'r1',
      type: 'grounding-unavailable',
      language: 'rust',
      canRun: ['javascript', 'python'],
      iteration: 2,
      remainingBudget: 1,
    }, 3);
    expect(line.sink).toBe('log');
    expect(line.text).toContain('[2/3]');
    expect(line.text).toContain('cannot run rust');
    expect(line.text).toContain('runnable: javascript, python');
  });
});
