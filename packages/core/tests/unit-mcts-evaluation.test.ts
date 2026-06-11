// Behavior tests for the multi-model MCTS evaluation pipeline.
//   Layer 1: execution-based scoring (verifiable tasks → executor verdict)
//   Layer 2: cross-model judge LLM scores the trajectory
import { describe, test, expect } from 'bun:test';
import { evaluateWithMultiModelJudging } from '../src/index.ts';
import { createScriptedLLM, createJSONLLM } from '@proteus/test-utils';
import type { Executor, LLM } from '../src/index.ts';

function exec(verdict: { error?: string } = {}): Executor {
  return {
    async execute() { return { result: undefined, ...verdict }; },
  } as unknown as Executor;
}

describe('evaluateWithMultiModelJudging — Layer 1: execution-based', () => {
  test('verifiable task: executor PASS → 0.9', async () => {
    const score = await evaluateWithMultiModelJudging(
      'verify that fn returns 42',
      'Here is my solution:\n```js\nif (fn() === 42) throw new Error("ok")\nelse throw new Error("nope")\n```',
      exec(),     // executor.execute returns no error → pass
      undefined as never,
      createScriptedLLM(['{"score": 0.5}']),
    );
    expect(score).toBe(0.9);
  });

  test('verifiable task: executor ERROR → 0.1', async () => {
    const score = await evaluateWithMultiModelJudging(
      'verify that fn returns 42',
      '```js\nthrow new Error("boom")\n```',
      exec({ error: 'boom' }),
      undefined as never,
      createScriptedLLM(['{"score": 0.5}']),
    );
    expect(score).toBe(0.1);
  });

  test('no verifier keyword in task → falls through to judge', async () => {
    const score = await evaluateWithMultiModelJudging(
      'write a haiku about debugging',
      '```js\nconsole.log("zen")\n```',
      exec(),
      undefined as never,
      createJSONLLM({ score: 0.7, rationale: 'good rhythm' }),
    );
    expect(score).toBe(0.7);
  });

  test('no code blocks → falls through to judge', async () => {
    const score = await evaluateWithMultiModelJudging(
      'verify the answer',
      'prose-only response',
      exec(),
      undefined as never,
      createJSONLLM({ score: 0.6 }),
    );
    expect(score).toBe(0.6);
  });
});

describe('evaluateWithMultiModelJudging — Layer 2: judge scoring', () => {
  test('clamps judge score to [0..1]', async () => {
    const tooHigh = await evaluateWithMultiModelJudging(
      'analyze', 'analysis', exec(), undefined as never,
      createJSONLLM({ score: 1.5 }),
    );
    expect(tooHigh).toBe(1);

    const tooLow = await evaluateWithMultiModelJudging(
      'analyze', 'analysis', exec(), undefined as never,
      createJSONLLM({ score: -0.3 }),
    );
    expect(tooLow).toBe(0);
  });

  test('uses judge model when provided (separate from explorer)', async () => {
    const explorer: LLM = createScriptedLLM(['explorer would say 0.99']);
    const judge: LLM = createJSONLLM({ score: 0.42 });
    const score = await evaluateWithMultiModelJudging(
      'analyze', 'analysis', exec(), judge, explorer,
    );
    expect(score).toBe(0.42);
    // The judge — not the explorer — should be the one consulted.
    expect((explorer as ReturnType<typeof createScriptedLLM>).callCount).toBe(0);
  });

  test('penalizes unparseable judge response instead of returning neutral success', async () => {
    const score = await evaluateWithMultiModelJudging(
      'analyze', 'analysis', exec(), undefined as never,
      createScriptedLLM(['I refuse to score']),
    );
    expect(score).toBe(0);
  });

  test('a high judge score passes through uncapped (no backwards calibration)', async () => {
    // Regression: calibrate() used to reduce to min(raw, historicalBest),
    // which penalized any branch that IMPROVED on the historical best.
    const score = await evaluateWithMultiModelJudging(
      'analyze', 'analysis', exec(), undefined as never,
      createJSONLLM({ score: 0.95 }),
    );
    expect(score).toBe(0.95);
  });
});
