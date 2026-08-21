/**
 * `kinu evolve` progress rendering. An evolution cycle spends minutes inside
 * runMCTS, so every search event has to reach the terminal — and a branch that
 * died on a provider error has to say so, since the engine scores it 0 and
 * carries on.
 */
import { describe, expect, test } from 'bun:test';
import type { MCTSProgressEvent } from '@kinu.run/core';
import { formatMctsProgress } from '../src/commands/evolve';

/** The renderer colours for a terminal; these tests assert its WORDS. Stripping
 *  at the seam keeps them true in a pipe, a PTY and under FORCE_COLOR alike —
 *  the deploy runs in a terminal and every local run was a pipe, which is how
 *  a green suite hid a red deploy twice in one day. */
function plain(text: string): string {
  return Bun.stripANSI(text);
}


describe('evolve progress rendering', () => {
  test('a phase becomes transient status with the iteration and branch count', () => {
    const line = formatMctsProgress(
      { rootId: 'r1', type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 2, branches: 3 },
      2,
    );

    expect(line.sink).toBe('status');
    expect(plain(line.text)).toContain('[1/2]');
    expect(plain(line.text)).toContain('exploring 3 branches');
  });

  test('phases name what they are doing, and a single branch reads singular', () => {
    const phases: Array<MCTSProgressEvent & { type: 'phase' }> = [
      { rootId: 'r1', type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 1, branches: 1 },
      { rootId: 'r1', type: 'phase', phase: 'evaluate', iteration: 1, remainingBudget: 1, branches: 1 },
      { rootId: 'r1', type: 'phase', phase: 'reflect', iteration: 1, remainingBudget: 1, branches: 1 },
    ];

    expect(phases.map(p => Bun.stripANSI(formatMctsProgress(p, 1).text))).toEqual([
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
    expect(plain(line.text)).toContain('[2/4]');
    expect(plain(line.text)).toContain('a1b2c3d4-e5f6g7h8');
    expect(plain(line.text)).toContain('(explore)');
    expect(plain(line.text)).toContain('Failed after 3 attempts. Last error: 429 rate limited');
  });

  test('a completed iteration keeps its scores in the scrollback', () => {
    const line = formatMctsProgress(
      { rootId: 'r1', type: 'iteration-complete', iteration: 1, remainingBudget: 1, scores: [0.82, 0] },
      2,
    );

    expect(line.sink).toBe('log');
    expect(plain(line.text)).toContain('[1/2]');
    expect(plain(line.text)).toContain('scores 0.82, 0.00');
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
    expect(plain(line.text)).toContain('[2/3]');
    expect(plain(line.text)).toContain('cannot run rust');
    expect(plain(line.text)).toContain('runnable: javascript, python');
  });
});
