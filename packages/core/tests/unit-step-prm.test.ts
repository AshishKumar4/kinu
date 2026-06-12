import { describe, test, expect } from 'bun:test';
import { scoreStepWithJudge, blendStepScore, beamPruneByStepScore } from '../src/index.ts';
import { createJSONLLM, createScriptedLLM } from '@proteus/test-utils';
import type { LLM } from '../src/types/primitives.ts';

/** A judge returning fixed JSON; counts how many times it was asked. */
function countingJudge(json: string): LLM & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async *stream() { yield json; },
    async complete() { calls++; return json; },
  };
}

describe('PRM step scoring', () => {
  test('parses valid judge response', async () => {
    const judge = createJSONLLM({ score: 0.85, rationale: 'clear progress toward answer' });
    const result = await scoreStepWithJudge(judge, {
      task: 'compute fibonacci',
      priorTrajectory: 'thought about it',
      step: { action: 'write recursive fn', observation: 'works for n<10' },
    });
    expect(result.score).toBeCloseTo(0.85, 2);
    expect(result.rationale).toContain('progress');
  });

  test('clamps score to [0..1]', async () => {
    const judge = createJSONLLM({ score: 1.5, rationale: 'x' });
    const r = await scoreStepWithJudge(judge, {
      task: 't', priorTrajectory: '',
      step: { action: 'a', observation: 'o' },
    });
    expect(r.score).toBe(1);
  });

  test('penalizes unparseable response instead of returning neutral success', async () => {
    const judge = createScriptedLLM(['I refuse']);
    const r = await scoreStepWithJudge(judge, {
      task: 't', priorTrajectory: '',
      step: { action: 'a', observation: 'o' },
    });
    expect(r.score).toBe(0);
    expect(r.rationale).toBe('unparseable');
  });

  test('penalizes judge transport failure instead of returning neutral success', async () => {
    const judge = {
      complete: async () => { throw new Error('provider down'); },
    };
    const r = await scoreStepWithJudge(judge, {
      task: 't', priorTrajectory: '',
      step: { action: 'a', observation: 'o' },
    });
    expect(r.score).toBe(0);
    expect(r.rationale).toBe('judge-error');
  });

  test('blendStepScore discounts new step', () => {
    expect(blendStepScore(0.5, 1.0, 0.7)).toBeCloseTo(0.65, 2);
    expect(blendStepScore(0.5, 0.0, 0.7)).toBeCloseTo(0.35, 2);
  });
});

describe('beamPruneByStepScore — the MCTS beam-prune gate (#6)', () => {
  test('keeps proposals at/above threshold, one judge call per non-empty proposal', async () => {
    const j = countingJudge('{"score": 0.8, "rationale": "ok"}');
    const plan = await beamPruneByStepScore(j, 'task', ['a', 'b'], 0.3);
    expect(plan.map((p) => p.keep)).toEqual([true, true]);
    expect(plan.every((p) => p.stepScore === 0.8)).toBe(true);
    expect(j.calls()).toBe(2);
  });

  test('a below-threshold proposal is marked pruned (skip the grounded evaluator)', async () => {
    const plan = await beamPruneByStepScore(countingJudge('{"score": 0.1}'), 'task', ['weak'], 0.3);
    expect(plan[0]!.keep).toBe(false);
    expect(plan[0]!.stepScore).toBe(0.1);
  });

  test('empty proposals are pruned at score 0 WITHOUT a judge call', async () => {
    const j = countingJudge('{"score": 0.9}');
    const plan = await beamPruneByStepScore(j, 'task', ['', 'real'], 0.3);
    expect(plan[0]).toEqual({ stepScore: 0, keep: false });
    expect(plan[1]!.keep).toBe(true);
    expect(j.calls()).toBe(1);
  });
});
