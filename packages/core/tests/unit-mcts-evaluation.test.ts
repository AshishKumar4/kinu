// Behavior tests for the grounded MCTS branch evaluator.
//   Layer 1: execution grounding — code-bearing branches run in the executor,
//            pass/fail picks the score band (fail ceiling < pass floor).
//   Layer 2: judge ensemble — k samples, median, parse-failures dropped;
//            prose-only branches are judge-only at reduced confidence.
import { describe, test, expect } from 'bun:test';
import { evaluateWithMultiModelJudging } from '../src/index.ts';
import { createScriptedLLM, createJSONLLM } from '@proteus/test-utils';
import type { Executor, LLM } from '../src/index.ts';

function exec(verdict: { error?: string } = {}): Executor {
  return {
    async execute() { return { result: undefined, ...verdict }; },
  } as unknown as Executor;
}

/** Judge that always returns the same JSON score and counts/records calls. */
function countingJudge(json: string): LLM & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async *stream() { yield json; },
    async complete(prompt: string) { prompts.push(prompt); return json; },
  };
}

describe('execution grounding dominates', () => {
  test('failing code scores below passing code even when the judge loves both', async () => {
    const judge = createJSONLLM({ score: 1.0, rationale: 'looks perfect' });
    const failing = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: 'flawless prose',
      codeUsed: 'throw new Error("boom")',
      executor: exec({ error: 'boom' }),
      judge,
      explorer: judge,
    });
    const passing = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: 'modest prose',
      codeUsed: 'const x = 42;',
      executor: exec(),
      judge,
      explorer: judge,
    });
    expect(failing.grounding).toBe('execution');
    expect(failing.execution?.passed).toBe(false);
    expect(failing.score).toBeLessThanOrEqual(0.3);
    expect(passing.execution?.passed).toBe(true);
    expect(passing.score).toBeGreaterThanOrEqual(0.6);
    expect(failing.score).toBeLessThan(passing.score);
  });

  test('code is extracted from the trajectory fence when codeUsed is absent', async () => {
    const judge = createJSONLLM({ score: 0.5 });
    const result = await evaluateWithMultiModelJudging({
      task: 'sum a list',
      trajectory: 'My approach:\n```js\nconst sum = [1,2].reduce((a,b)=>a+b,0);\n```',
      executor: exec(),
      judge,
      explorer: judge,
    });
    expect(result.grounding).toBe('execution');
    expect(result.execution?.passed).toBe(true);
  });

  test('a throwing executor counts as a failed run, never neutral', async () => {
    const judge = createJSONLLM({ score: 0.9 });
    const result = await evaluateWithMultiModelJudging({
      task: 'do it',
      trajectory: 'prose',
      codeUsed: 'const a = 1;',
      executor: { async execute() { throw new Error('LOADER down'); } } as unknown as Executor,
      judge,
      explorer: judge,
    });
    expect(result.execution?.passed).toBe(false);
    expect(result.execution?.error).toContain('LOADER down');
    expect(result.score).toBeLessThanOrEqual(0.3);
  });

  test('judge-generated assertions are appended to the run', async () => {
    const executed: string[] = [];
    const executor: Executor = {
      async execute(code: string) { executed.push(code); return { result: undefined }; },
    } as unknown as Executor;
    // 1st call = assertion generation, then 3 judge samples.
    const judge = createScriptedLLM([
      '```js\nif (add(1, 2) !== 3) throw new Error("add broken");\n```',
      '{"score": 0.5}', '{"score": 0.5}', '{"score": 0.5}',
    ]);
    await evaluateWithMultiModelJudging({
      task: 'verify add works',
      trajectory: 'use add',
      codeUsed: 'function add(a, b) { return a + b; }',
      executor,
      judge,
      explorer: judge,
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('function add');
    expect(executed[0]).toContain('add broken');
  });

  test('UNVERIFIABLE assertion reply falls back to a bare run', async () => {
    const executed: string[] = [];
    const executor: Executor = {
      async execute(code: string) { executed.push(code); return { result: undefined }; },
    } as unknown as Executor;
    const judge = createScriptedLLM(['UNVERIFIABLE', '{"score": 0.5}', '{"score": 0.5}', '{"score": 0.5}']);
    const result = await evaluateWithMultiModelJudging({
      task: 'side-effecting setup',
      trajectory: 'prose',
      codeUsed: 'const ready = true;',
      executor,
      judge,
      explorer: judge,
    });
    expect(executed).toEqual(['const ready = true;']);
    expect(result.execution?.assertionsGenerated).toBe(false);
  });
});

describe('judge ensemble — median, parse-failure-robust', () => {
  test('takes the median of k parsed samples', async () => {
    const judge = createScriptedLLM(['{"score": 0.2}', '{"score": 0.8}', '{"score": 0.6}']);
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(), judge, explorer: judge,
    });
    // prose-only: 0.75 × median(0.2, 0.8, 0.6) = 0.75 × 0.6
    expect(result.grounding).toBe('judge');
    expect(result.judgeSamplesUsed).toBe(3);
    expect(result.score).toBeCloseTo(0.75 * 0.6, 10);
  });

  test('a failed parse is a dropped sample, never a 0', async () => {
    const judge = createScriptedLLM(['I refuse to score', '{"score": 0.8}', '{"score": 0.8}']);
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(), judge, explorer: judge,
    });
    // median(0.8, 0.8) — the unparseable sample does not drag the score down.
    expect(result.judgeSamplesUsed).toBe(2);
    expect(result.score).toBeCloseTo(0.75 * 0.8, 10);
  });

  test('a throwing judge call is a dropped sample', async () => {
    let calls = 0;
    const judge: LLM = {
      async *stream() { yield ''; },
      async complete() {
        calls++;
        if (calls === 1) throw new Error('provider 500');
        return '{"score": 0.4}';
      },
    };
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(), judge, explorer: judge,
    });
    expect(result.judgeSamplesUsed).toBe(2);
    expect(result.score).toBeCloseTo(0.75 * 0.4, 10);
  });

  test('ALL samples failing → prose branch scores 0 (infrastructure failure is not neutral)', async () => {
    const judge = createScriptedLLM(['nope', 'nope', 'nope']);
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(), judge, explorer: judge,
    });
    expect(result.judgeSamplesUsed).toBe(0);
    expect(result.score).toBe(0);
  });

  test('ALL samples failing on a passing-code branch → band floor, still above any failing branch', async () => {
    const judge = createScriptedLLM(['nope', 'nope', 'nope', 'nope']);
    const result = await evaluateWithMultiModelJudging({
      task: 'do it', trajectory: 'prose', codeUsed: 'const ok = 1;',
      executor: exec(), judge, explorer: judge,
    });
    expect(result.score).toBe(0.6);
  });

  test('clamps judge scores to [0..1]', async () => {
    const high = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(),
      judge: createJSONLLM({ score: 1.5 }), explorer: createJSONLLM({ score: 1.5 }),
    });
    expect(high.score).toBeCloseTo(0.75, 10);
    const low = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(),
      judge: createJSONLLM({ score: -0.3 }), explorer: createJSONLLM({ score: -0.3 }),
    });
    expect(low.score).toBe(0);
  });

  test('uses the cross-model judge, not the explorer, when provided', async () => {
    const explorer = createScriptedLLM(['explorer would say 0.99']);
    const judge = createJSONLLM({ score: 0.42 });
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(), judge, explorer,
    });
    expect(result.score).toBeCloseTo(0.75 * 0.42, 10);
    expect(explorer.callCount).toBe(0);
  });

  test('falls back to the explorer model when no judge is configured (documented fallback)', async () => {
    const explorer = createJSONLLM({ score: 0.4 });
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(), explorer,
    });
    expect(result.score).toBeCloseTo(0.75 * 0.4, 10);
  });
});

describe('judge prompt content', () => {
  test('includes the task, siblings, and execution evidence', async () => {
    const judge = countingJudge('{"score": 0.5}');
    await evaluateWithMultiModelJudging({
      task: 'build the parser',
      trajectory: 'candidate approach text',
      codeUsed: 'throw new Error("parse fail")',
      siblings: ['sibling approach one', 'sibling approach two'],
      executor: exec({ error: 'parse fail' }),
      judge,
      explorer: judge,
      judgeSamples: 1,
      maxLLMCalls: 1, // no assertion call → prompts[0] is the judge prompt
    });
    const prompt = judge.prompts[0]!;
    expect(prompt).toContain('build the parser');
    expect(prompt).toContain('candidate approach text');
    expect(prompt).toContain('sibling approach one');
    expect(prompt).toContain('sibling approach two');
    expect(prompt).toContain('FAILED: parse fail');
  });
});

describe('budget knobs', () => {
  test('judgeSamples controls the ensemble size', async () => {
    const judge = countingJudge('{"score": 0.5}');
    await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(),
      judge, explorer: judge, judgeSamples: 5,
    });
    // maxLLMCalls default 4 caps the 5 requested samples (prose: no assertion call).
    expect(judge.prompts).toHaveLength(4);
  });

  test('maxLLMCalls caps total spend: assertion call + judge samples', async () => {
    const judge = countingJudge('{"score": 0.5}');
    await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'x', codeUsed: 'const a = 1;',
      executor: exec(), judge, explorer: judge,
      judgeSamples: 3, maxLLMCalls: 2,
    });
    // 1 assertion-generation call + 1 judge sample.
    expect(judge.prompts).toHaveLength(2);
    expect(judge.prompts[0]).toContain('verification harness');
  });

  test('maxLLMCalls=1 on a code branch skips assertions, keeps one judge sample', async () => {
    const judge = countingJudge('{"score": 0.5}');
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'x', codeUsed: 'const a = 1;',
      executor: exec(), judge, explorer: judge, maxLLMCalls: 1,
    });
    expect(judge.prompts).toHaveLength(1);
    expect(result.execution?.assertionsGenerated).toBe(false);
    expect(result.grounding).toBe('execution'); // bare run still grounds
  });
});

describe('degenerate inputs', () => {
  test('empty trajectory (failed exploration) scores 0 without any LLM calls', async () => {
    const judge = countingJudge('{"score": 0.9}');
    const result = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: '   ', executor: exec(), judge, explorer: judge,
    });
    expect(result.score).toBe(0);
    expect(judge.prompts).toHaveLength(0);
  });

  test('non-JS code fences stay judge-only (executors are JS sandboxes)', async () => {
    const judge = createJSONLLM({ score: 0.6 });
    const result = await evaluateWithMultiModelJudging({
      task: 'script it',
      trajectory: '```python\nprint("hi")\n```',
      executor: exec({ error: 'would be a false fail' }),
      judge,
      explorer: judge,
    });
    expect(result.grounding).toBe('judge');
    expect(result.score).toBeCloseTo(0.75 * 0.6, 10);
  });
});
