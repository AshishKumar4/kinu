import { describe, expect, test } from 'bun:test';
import { LAST_SEGMENTS, learningVerdict, reactivePlan, reactiveReply, seedInterval, type ArmRun, type SegmentResult } from './reactive';

const FAMILIES = ['budget-board', 'chess', 'launch-prep', 'memory-recall'];

describe('the reactive user', () => {
  test('a pass moves on; a failure is corrected by naming what failed, then the request is repeated, then dropped', () => {
    expect(reactiveReply('total the March spend', [], 0)).toBeNull();
    expect(reactiveReply('total the March spend', ['totals-match'], 0)).toBe('That isn\'t right yet: totals-match fails.');
    expect(reactiveReply('total the March spend', ['totals-match', 'no-duplicates'], 0)).toBe('That isn\'t right yet: totals-match, no-duplicates fail.');
    expect(reactiveReply('total the March spend', ['totals-match'], 1)).toBe('total the March spend');
    expect(reactiveReply('total the March spend', ['totals-match'], 2)).toBeNull();
  });

  test('the plan is the same for a seed, and the held-out family appears only in the last segments', () => {
    const plan = reactivePlan(FAMILIES, 200, 1, 'memory-recall');

    expect(plan).toEqual(reactivePlan(FAMILIES, 200, 1, 'memory-recall'));
    expect(plan).not.toEqual(reactivePlan(FAMILIES, 200, 2, 'memory-recall'));
    expect(plan.slice(0, 200 - LAST_SEGMENTS)).not.toContain('memory-recall');
    expect(plan.slice(-LAST_SEGMENTS)).toContain('memory-recall');
    expect(new Set(plan.slice(0, 200 - LAST_SEGMENTS))).toEqual(new Set(['budget-board', 'chess', 'launch-prep']));
  });
});

describe('learning on must beat learning off', () => {
  const segment = (family: string, passed: boolean, toolErrors = 0): SegmentResult => ({ family, passed, replies: 2, toolErrors, steps: 6, thumbs: 0 });

  const arm = (name: 'learning-on' | 'learning-off', passes: number, satisfaction: number, toolErrors = 0): ArmRun => ({
    arm: name, seed: 1, spend: null, lastSatisfaction: satisfaction,
    segments: Array.from({ length: LAST_SEGMENTS }, (_, at) => segment(at % 5 === 0 ? 'memory-recall' : 'chess', at < passes, toolErrors)),
  });

  test('a clear gain over three seeds, guardrails flat and the held-out family kept, wins', () => {
    const runs = [40, 42, 41].map((passes, at) => ({ on: arm('learning-on', passes, 4.2 + at / 10), off: arm('learning-off', 30, 3.5), heldOut: 'memory-recall' }));

    expect(learningVerdict(runs)).toMatchObject({ wins: true, passRate: { mean: expect.closeTo(0.22, 2) } });
  });

  test('a gain bought with tool errors, or no gain, or one seed, does not win', () => {
    const run = (on: ArmRun) => ({ on, off: arm('learning-off', 30, 3.5), heldOut: 'memory-recall' });

    expect(learningVerdict([40, 42, 41].map((passes) => run(arm('learning-on', passes, 4.3, 1)))).wins).toBe(false);
    expect(learningVerdict([30, 31, 29].map((passes) => run(arm('learning-on', passes, 3.5)))).wins).toBe(false);
    expect(learningVerdict([run(arm('learning-on', 45, 4.5))]).wins).toBe(false);
  });

  test('the interval is the two-sided 95% t interval over seeds', () => {
    expect(seedInterval([1, 2, 3])).toEqual({ mean: 2, lo: expect.closeTo(2 - 4.303 / Math.sqrt(3), 6), hi: expect.closeTo(2 + 4.303 / Math.sqrt(3), 6) });
    expect(seedInterval([1])).toEqual({ mean: 1, lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY });
  });
});
