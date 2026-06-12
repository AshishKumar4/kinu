// Regression: the heads strategy must NOT inherit a 60s wall-clock cap.
// The think tool used to default budget.wallClockMs to 60_000 for every call,
// which the heads strategy took as the whole-subtree budget and used to kill
// heads mid-work (tokens=0, "budget_exceeded"). The fix drops that default so
// the strategy falls through to DEFAULT_HEAD_BUDGET (5 min) unless a caller
// explicitly asks for a tighter bound.
import { describe, test, expect } from 'bun:test';
import { createHeadsStrategy } from '../src/strategy/heads.js';
import { DEFAULT_HEAD_BUDGET, type HeadBudget, type MergeResult } from '../src/heads/index.js';
import type { StrategyContext, StrategyBudget } from '../src/strategy/types.js';

function fakeMergeResult(): MergeResult {
  return {
    mergedNarrative: 'ok', selectedDecisions: [], unresolvedQuestions: [],
    recommendations: [], evidenceAggregate: [], headIds: ['h'],
    headScores: [], grounded: false,
    costSummary: { headCount: 1, totalTokens: 0, totalWallClockMs: 0, maxDepth: 3 },
  };
}

function ctxWith(budget: StrategyBudget | undefined, capture: (b: HeadBudget) => void): StrategyContext {
  return {
    task: 't',
    rt: {} as StrategyContext['rt'],
    model: {} as StrategyContext['model'],
    budget,
    options: {
      heads: {
        controller: { run: async (o: { parentBudget: HeadBudget }) => { capture(o.parentBudget); return fakeMergeResult(); } },
        heads: [{ task: 'a', rationale: 'r' }],
      },
    },
  };
}

describe('heads strategy wall-clock budget (#167 regression)', () => {
  test('falls through to DEFAULT_HEAD_BUDGET (5 min) when no wall-clock is supplied — never 60s', async () => {
    let captured: HeadBudget | null = null;
    await createHeadsStrategy().explore(ctxWith({ maxIterations: 10 }, (b) => { captured = b; }));
    expect(captured!.maxWallClockMs).toBe(DEFAULT_HEAD_BUDGET.maxWallClockMs);
    expect(captured!.maxWallClockMs).toBe(300_000);
    expect(captured!.maxWallClockMs).not.toBe(60_000);
  });

  test('honors an explicit ctx wall-clock budget when one is provided', async () => {
    let captured: HeadBudget | null = null;
    await createHeadsStrategy().explore(ctxWith({ wallClockMs: 12_345 }, (b) => { captured = b; }));
    expect(captured!.maxWallClockMs).toBe(12_345);
  });
});
