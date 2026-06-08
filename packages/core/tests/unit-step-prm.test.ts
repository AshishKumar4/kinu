import { describe, test, expect } from 'bun:test';
import { scoreStepWithJudge, blendStepScore } from '../src/index.ts';
import { createJSONLLM, createScriptedLLM } from '@proteus/test-utils';

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
