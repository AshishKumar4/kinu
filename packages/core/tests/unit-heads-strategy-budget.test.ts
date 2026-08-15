// Regression: a fork must not inherit a wall clock nobody asked for.
// Two rounds of this. First the think tool defaulted budget.wallClockMs to
// 60_000 for every call, which the heads strategy took as the whole-subtree
// budget and used to kill heads mid-work (tokens=0, "budget_exceeded"); that
// default was dropped, leaving a 5-minute one underneath it, which killed a
// codebase audit the same way. There is now no default underneath at all — a
// deadline exists only when a caller names one.
import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createHeadsStrategy } from '../src/strategy/heads.js';
import { HeadController, HeadJournal, type HeadBudget, type MergeResult } from '../src/heads/index.js';
import type { StrategyContext, StrategyBudget } from '../src/strategy/types.js';
import { createTestRuntime } from './helpers.js';

function fakeMergeResult(over?: Partial<MergeResult['costSummary']>): MergeResult {
  return {
    mergedNarrative: 'ok', selectedDecisions: [], unresolvedQuestions: [],
    recommendations: [], blindSpots: [], evidenceAggregate: [], headIds: ['h'],
    headScores: [], fileChanges: [], grounded: false,
    costSummary: {
      headCount: 1, headsWithFindings: 1, totalTokens: 0, totalWallClockMs: 0, maxDepth: 3, ...over,
    },
  };
}

function ctxWith(
  budget: StrategyBudget | undefined,
  capture: (b: HeadBudget) => void,
  merge: MergeResult = fakeMergeResult(),
): StrategyContext {
  const { rt } = createTestRuntime();
  const controller = new HeadController({
    spawnHead: async () => { throw new Error('strategy test replaces controller.run'); },
    mergeLLM: async () => { throw new Error('strategy test replaces controller.run'); },
  }, new HeadJournal(rt.storage.sql));
  controller.run = async (options) => {
    if (!options.parentBudget) throw new Error('expected strategy parent budget');
    capture(options.parentBudget);
    return merge;
  };
  return {
    task: 't',
    mode: 'build',
    rt,
    model: new MockLanguageModelV3(),
    budget,
    options: {
      heads: {
        controller,
        heads: [{ task: 'a', rationale: 'r' }],
      },
    },
  };
}

function requireBudget(budget: HeadBudget | null): HeadBudget {
  if (!budget) throw new Error('expected captured head budget');
  return budget;
}

describe('heads strategy wall-clock budget (#167 regression)', () => {
  test('no wall-clock supplied → the fork gets none, not a default', async () => {
    let captured: HeadBudget | null = null;
    await createHeadsStrategy().explore(ctxWith({ maxIterations: 10 }, (b) => { captured = b; }));
    expect(requireBudget(captured).maxWallClockMs).toBeUndefined();
  });

  test('an entirely absent ctx budget also yields no deadline', async () => {
    let captured: HeadBudget | null = null;
    await createHeadsStrategy().explore(ctxWith(undefined, (b) => { captured = b; }));
    expect(requireBudget(captured).maxWallClockMs).toBeUndefined();
  });

  test('honors an explicit ctx wall-clock budget when one is provided', async () => {
    let captured: HeadBudget | null = null;
    await createHeadsStrategy().explore(ctxWith({ wallClockMs: 12_345 }, (b) => { captured = b; }));
    expect(requireBudget(captured).maxWallClockMs).toBe(12_345);
  });

  test('the fork the parent reads back says how many heads came back with anything', async () => {
    // The parent LLM continues its turn from this text, so it should be able to
    // see for itself that a delegation cost tokens and returned nothing.
    const result = await createHeadsStrategy().explore(
      ctxWith(undefined, () => {}, fakeMergeResult({ headCount: 3, headsWithFindings: 0, totalTokens: 53_755 })),
    );
    expect(result.best.text).toContain('heads=3 (0 with findings)');
    expect(result.best.text).toContain('tokens=53755');
  });
});
