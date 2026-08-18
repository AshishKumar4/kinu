// Behavior tests for the grounded MCTS branch evaluator.
//   Layer 1: execution grounding — code-bearing branches run in the executor,
//            pass/fail picks the score band (fail ceiling < pass floor).
//   Layer 2: judge ensemble — k samples, median, parse-failures dropped;
//            prose-only branches are judge-only at reduced confidence.
import { describe, test, expect } from 'bun:test';
import { evaluateWithMultiModelJudging } from '../src/index.ts';
import { executionObservation, isParseFailure } from '../src/mcts/evaluation.ts';
import { createScriptedLLM, createJSONLLM } from '@proteus/test-utils';
import type { Executor, LLM } from '../src/index.ts';

function exec(verdict: { error?: string } = {}, languages: readonly [string, ...string[]] = ['javascript']): Executor {
  return {
    languages,
    async execute() { return { result: undefined, ...verdict }; },
  };
}

/** A branch answer: prose with its implementation fenced, the way a branch
 *  actually replies — the evaluator reads the code back out of it. */
function withCode(prose: string, code: string, language = 'js'): string {
  return `${prose}\n\`\`\`${language}\n${code}\n\`\`\``;
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
      trajectory: withCode('flawless prose', 'throw new Error("boom")'),
      executor: exec({ error: 'boom' }),
      judge,
      explorer: judge,
    });
    const passing = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: withCode('modest prose', 'const x = 42;'),
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

  test('code is read back out of the trajectory fence', async () => {
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
      trajectory: withCode('prose', 'const a = 1;'),
      executor: { languages: ['javascript'], async execute() { throw new Error('LOADER down'); } },
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
      languages: ['javascript'],
      async execute(code: string) { executed.push(code); return { result: undefined }; },
    };
    // 1st call = assertion generation, then 3 judge samples.
    const judge = createScriptedLLM([
      '```js\nif (add(1, 2) !== 3) throw new Error("add broken");\n```',
      '{"score": 0.5}', '{"score": 0.5}', '{"score": 0.5}',
    ]);
    await evaluateWithMultiModelJudging({
      task: 'verify add works',
      trajectory: withCode('use add', 'function add(a, b) { return a + b; }'),
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
      languages: ['javascript'],
      async execute(code: string) { executed.push(code); return { result: undefined }; },
    };
    const judge = createScriptedLLM(['UNVERIFIABLE', '{"score": 0.5}', '{"score": 0.5}', '{"score": 0.5}']);
    const result = await evaluateWithMultiModelJudging({
      task: 'side-effecting setup',
      trajectory: withCode('prose', 'const ready = true;'),
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

  test('a throwing judge call is a fault, not a thinner ensemble', async () => {
    let calls = 0;
    const judge: LLM = {
      async *stream() { yield ''; },
      async complete() {
        calls++;
        if (calls === 1) throw new Error('provider 500');
        return '{"score": 0.4}';
      },
    };
    // A sample the provider REFUSED is not a sample it declined to parse: the
    // engine's allSettled reports branch-failed with this reason and scores the
    // branch 0 (mcts/engine.ts). Dropped, the 500 is gone and the median is
    // reported as if the ensemble had answered.
    await expect(evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'analysis', executor: exec(), judge, explorer: judge,
    })).rejects.toThrow('provider 500');
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
      task: 'do it', trajectory: withCode('prose', 'const ok = 1;'),
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

describe('band loophole (WP-A5): prose cannot beat failed-but-attempted code', () => {
  test('prose is capped at the fail ceiling when a sibling produced code', async () => {
    const judge = createJSONLLM({ score: 1.0, rationale: 'great prose' });
    const prose = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: 'a beautifully argued prose approach, no code',
      siblings: ['```js\nconst x = 42;\n```'],
      siblingsProducedCode: true,
      executor: exec(),
      judge,
      explorer: judge,
    });
    // Without the cap this scored 0.75; now it tops out at the fail ceiling 0.30.
    expect(prose.grounding).toBe('judge');
    expect(prose.score).toBeCloseTo(0.30, 10);
  });

  test('a failed-code branch is never beaten by a prose sibling in the same expansion', async () => {
    const judge = createJSONLLM({ score: 1.0 });
    const failedCode = await evaluateWithMultiModelJudging({
      task: 'compute 42', trajectory: withCode('prose', 'throw new Error("boom")'),
      siblings: ['some prose sibling'], siblingsProducedCode: false,
      executor: exec({ error: 'boom' }), judge, explorer: judge,
    });
    const prose = await evaluateWithMultiModelJudging({
      task: 'compute 42', trajectory: 'prose sibling',
      siblings: ['```js code```'], siblingsProducedCode: true,
      executor: exec(), judge, explorer: judge,
    });
    expect(prose.score).toBeLessThanOrEqual(failedCode.score);
  });

  test('prose keeps full 0.75 confidence when NO sibling attempted code', async () => {
    const judge = createJSONLLM({ score: 1.0 });
    const prose = await evaluateWithMultiModelJudging({
      task: 'analyze', trajectory: 'prose', siblings: ['other prose'],
      siblingsProducedCode: false, executor: exec(), judge, explorer: judge,
    });
    expect(prose.score).toBeCloseTo(0.75, 10);
  });
});

describe('judge prompt content', () => {
  test('includes the task, siblings, and execution evidence', async () => {
    const judge = countingJudge('{"score": 0.5}');
    await evaluateWithMultiModelJudging({
      task: 'build the parser',
      trajectory: withCode('candidate approach text', 'throw new Error("parse fail")'),
      siblings: ['sibling approach one', 'sibling approach two'],
      executor: exec({ error: 'parse fail' }),
      judge,
      explorer: judge,
      judgeSamples: 1,
      maxLLMCalls: 1, // no assertion call → prompts[0] is the judge prompt
    });
    const prompt = judge.prompts[0] ?? '';
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
      task: 'analyze', trajectory: withCode('x', 'const a = 1;'),
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
      task: 'analyze', trajectory: withCode('x', 'const a = 1;'),
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

});

describe('grounding follows the executor, not a hardcoded language', () => {
  test('a Python candidate is EXECUTED when the executor declares python', async () => {
    const judge = createJSONLLM({ score: 0.5 });
    const ran: Array<{ code: string; language?: string }> = [];
    const python: Executor = {
      languages: ['python'],
      async execute(code, _providers, opts) {
        ran.push({ code, language: opts?.language });
        return code.includes('BROKEN') ? { result: undefined, error: 'boom' } : { result: undefined };
      },
    };

    const good = await evaluateWithMultiModelJudging({
      task: 'sum a list', trajectory: '```python\ndef total(xs): return sum(xs)\n```',
      executor: python, judge, explorer: judge,
    });
    const bad = await evaluateWithMultiModelJudging({
      task: 'sum a list', trajectory: '```py\nBROKEN\n```',
      executor: python, judge, explorer: judge,
    });

    expect(good.grounding).toBe('execution');
    expect(good.execution?.passed).toBe(true);
    expect(good.score).toBeGreaterThanOrEqual(0.6);
    expect(bad.execution?.passed).toBe(false);
    expect(bad.score).toBeLessThanOrEqual(0.3);
    // The executor was told which language to run it as — the seam carries it.
    expect(ran.every((r) => r.language === 'python')).toBe(true);
  });

  test('differing candidates do not collapse onto one judge-only value', async () => {
    // The exact production failure: a saturated judge plus no execution
    // grounding gave every branch the identical prose-band number, so UCT had
    // nothing to rank on. With the executor able to run them, they separate.
    const judge = createJSONLLM({ score: 1.0 });
    const python = exec({}, ['python']);
    const failing = exec({ error: 'AssertionError' }, ['python']);
    const scores = [
      (await evaluateWithMultiModelJudging({
        task: 't', trajectory: '```python\nok = 1\n```', executor: python, judge, explorer: judge,
      })).score,
      (await evaluateWithMultiModelJudging({
        task: 't', trajectory: '```python\nbad = 1\n```', executor: failing, judge, explorer: judge,
      })).score,
      (await evaluateWithMultiModelJudging({
        task: 't', trajectory: 'I would do it by hand.', executor: python, judge, explorer: judge,
      })).score,
    ];
    expect(new Set(scores).size).toBe(scores.length);
  });

  test('a language nothing can run is UNRUNNABLE, not prose — it never reads as a 0.75 score', async () => {
    const judge = createJSONLLM({ score: 0.6 });
    const result = await evaluateWithMultiModelJudging({
      task: 'script it',
      trajectory: '```python\nprint("hi")\n```',
      executor: exec({ error: 'would be a false fail' }),
      judge,
      explorer: judge,
    });
    // Not 'judge': the branch DID offer an implementation. Naming the language
    // is what lets the engine report the search as ungrounded.
    expect(result.grounding).toBe('unrunnable');
    expect(result.unrunnableLanguage).toBe('python');
    expect(result.score).toBeCloseTo(0.3 * 0.6, 10);
    expect(result.score).not.toBeCloseTo(0.75 * 0.6, 10);
  });

  test('an unrunnable branch cannot outrank a sibling whose code actually ran', async () => {
    // The invariant the whole band table exists for. At the old prose cap a
    // generously-judged unrunnable branch (0.75) beat a passing branch whose
    // judge was merely middling (0.6 + 0.4·0.3 = 0.72).
    const unrunnable = await evaluateWithMultiModelJudging({
      task: 't', trajectory: '```ruby\nputs 1\n```',
      executor: exec(), judge: createJSONLLM({ score: 1.0 }), explorer: createJSONLLM({ score: 1.0 }),
    });
    const passing = await evaluateWithMultiModelJudging({
      task: 't', trajectory: '```js\nconst x = 1;\n```',
      executor: exec(), judge: createJSONLLM({ score: 0.3 }), explorer: createJSONLLM({ score: 0.3 }),
    });
    expect(unrunnable.score).toBeLessThan(passing.score);
  });
});

describe('evaluation cascade — a branch that never parsed skips the judge ensemble', () => {
  /** A judge whose replies are scripted in order: the assertion harness first,
   *  then one reply per ensemble sample. */
  function sequencedJudge(replies: string[]): LLM & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      prompts,
      async *stream() { yield replies[0] ?? ''; },
      async complete(prompt: string) {
        prompts.push(prompt);
        return replies[prompts.length - 1] ?? '{"score": 0.5}';
      },
    };
  }

  /** An executor whose verdict depends on whether assertions were appended,
   *  so the attribution re-run is observable. Counts every call. */
  function stagedExec(byRun: Array<{ error?: string }>): Executor & { runs: string[] } {
    const runs: string[] = [];
    return {
      runs,
      languages: ['javascript'],
      async execute(code: string) {
        runs.push(code);
        return { result: undefined, ...byRun[runs.length - 1] };
      },
    };
  }

  test('unparseable code lands on the fail-band floor with zero judge samples', async () => {
    const judge = countingJudge('{"score": 0.9}');
    const result = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: withCode('here you go', 'const x = ('),
      executor: exec({ error: 'SyntaxError: Unexpected end of input' }),
      judge,
      explorer: judge,
      judgeSamples: 3,
      maxLLMCalls: 1,  // no assertion call, so the bare run is authoritative
    });
    expect(result.grounding).toBe('execution');
    expect(result.execution?.passed).toBe(false);
    expect(result.score).toBeCloseTo(0.05, 10);
    expect(result.judgeSamplesUsed).toBe(0);
    expect(judge.prompts).toHaveLength(0);
  });

  test('code that ran and THREW keeps its full judge ensemble — the band placement is real information', async () => {
    const judge = countingJudge('{"score": 0.8}');
    const result = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: withCode('here you go', 'throw new Error("boom")'),
      executor: exec({ error: 'boom' }),
      judge,
      explorer: judge,
      judgeSamples: 3,
      maxLLMCalls: 4,
    });
    expect(result.judgeSamplesUsed).toBe(3);
    expect(judge.prompts).toHaveLength(4);  // 1 assertion call + 3 judge samples
    expect(result.score).toBeCloseTo(0.05 + 0.25 * 0.8, 10);
  });

  test('a parse error the JUDGE\'s assertions caused is not charged to the branch', async () => {
    // Run 1 = code + a syntactically broken harness → parse error.
    // Run 2 = the attribution re-run of the code ALONE → clean.
    const executor = stagedExec([{ error: 'SyntaxError: Unexpected token )' }, {}]);
    // First reply is the (broken) harness, the rest are judge scores.
    const judge = sequencedJudge(['```js\nexpect(\n```', '{"score": 0.5}', '{"score": 0.5}']);
    const result = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: withCode('here you go', 'const x = 42;'),
      executor,
      judge,
      explorer: judge,
      judgeSamples: 2,
      maxLLMCalls: 3,
    });
    expect(executor.runs).toHaveLength(2);
    expect(executor.runs[1]).toBe('const x = 42;');
    // The branch keeps the original harness verdict AND its judge ensemble.
    expect(result.execution?.error).toBe('SyntaxError: Unexpected token )');
    expect(result.judgeSamplesUsed).toBe(2);
  });

  test('a parse error the BRANCH caused survives attribution and short-circuits', async () => {
    const executor = stagedExec([
      { error: 'SyntaxError: Unexpected end of input' },
      { error: 'SyntaxError: Unexpected end of input' },
    ]);
    const judge = countingJudge('```js\nif (x) {}\n```');
    const result = await evaluateWithMultiModelJudging({
      task: 'compute 42',
      trajectory: withCode('here you go', 'const x = ('),
      executor,
      judge,
      explorer: judge,
      judgeSamples: 3,
      maxLLMCalls: 4,
    });
    expect(executor.runs).toHaveLength(2);
    expect(result.score).toBeCloseTo(0.05, 10);
    expect(result.judgeSamplesUsed).toBe(0);
    // Only the assertion-generation call was spent; the ensemble was not.
    expect(judge.prompts).toHaveLength(1);
  });

  test('passing code never triggers the attribution re-run', async () => {
    const executor = stagedExec([{}]);
    const judge = countingJudge('{"score": 0.5}');
    await evaluateWithMultiModelJudging({
      task: 'compute 42', trajectory: withCode('ok', 'const x = 42;'),
      executor, judge, explorer: judge, judgeSamples: 1, maxLLMCalls: 1,
    });
    expect(executor.runs).toHaveLength(1);
  });

  test('an unrecognised error message falls through to the full judge path', async () => {
    const judge = countingJudge('{"score": 0.4}');
    const result = await evaluateWithMultiModelJudging({
      task: 'compute 42', trajectory: withCode('ok', 'const x = 42;'),
      executor: exec({ error: 'ECONNRESET talking to the sandbox' }),
      judge, explorer: judge, judgeSamples: 2, maxLLMCalls: 3,
    });
    expect(result.judgeSamplesUsed).toBe(2);
  });
});

describe('isParseFailure', () => {
  test('recognises engine parse messages and nothing else', () => {
    for (const message of [
      'SyntaxError: Unexpected token )',
      'Unexpected end of input',
      'Invalid or unexpected token',
      'missing ) after argument list',
      'unexpected identifier "foo"',
    ]) expect(isParseFailure(message)).toBe(true);

    for (const message of [
      'boom',
      'TypeError: x is not a function',
      'ReferenceError: fetch is not defined',
      'Assertion failed: expected 42',
      'Process exited with code 1',
    ]) expect(isParseFailure(message)).toBe(false);
  });
});

describe('a non-responding judge cannot hang the search', () => {
  // A judge whose provider call accepts the request and then never answers —
  // the promise stays pending forever. This is what froze a real production
  // MCTS search: the engine awaits the judge ensemble inside Promise.all, so a
  // single stuck call stalled the whole evaluation, and MCTS runs that inside a
  // durable background fiber with no wall clock, so the search hung on its first
  // expansion and its tree never grew again (read by the operator as "MCTS
  // never goes live").
  const hungJudge: LLM = {
    async *stream() { yield ''; },
    complete() { return new Promise<string>(() => { /* never settles */ }); },
  };

  // Rejects (→ a failing test with a clear message) if `p` has not settled in
  // `ms`, so the "without the fix it hangs" case fails fast instead of waiting
  // out bun's default timeout. The timer is always cleared.
  async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`evaluator did not settle within ${ms}ms`)), ms);
    });
    try { return await Promise.race([p, guard]); } finally { if (timer) clearTimeout(timer); }
  }

  test('prose-only branch drops the dead judge and settles instead of hanging', async () => {
    const result = await settlesWithin(
      evaluateWithMultiModelJudging({
        task: 'compare two approaches',
        trajectory: 'a thoughtful prose-only comparison',
        executor: exec(),
        judge: hungJudge,
        explorer: hungJudge,
        judgeCallTimeoutMs: 50,
      }),
      3000,
    );
    expect(result.grounding).toBe('judge');
    expect(result.judgeSamplesUsed).toBe(0);
    expect(result.score).toBe(0);
  });

  test('passing code still grounds to the pass floor when the judge never answers', async () => {
    const result = await settlesWithin(
      evaluateWithMultiModelJudging({
        task: 'return 42',
        trajectory: withCode('here is the code', 'const x = 42;'),
        executor: exec(),
        judge: hungJudge,
        explorer: hungJudge,
        judgeCallTimeoutMs: 50,
      }),
      3000,
    );
    expect(result.grounding).toBe('execution');
    expect(result.execution?.passed).toBe(true);
    expect(result.judgeSamplesUsed).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0.6); // PASS_FLOOR — execution carries it
  });
});

/**
 * LATS backpropagates `passed_test_count / len(tests)` (programming/mcts.py).
 * Ours used to backpropagate a bit, so every failing branch landed at
 * FAIL_FLOOR + FAIL_SPAN·judge and "almost right" was separated from "nothing
 * works" only by judge noise — the binary reward this repo already measured
 * degenerates a search toward best-of-n (test-utils/src/eval-outcome.ts).
 */
describe('partial credit: the fail band is positioned by MEASURED checks, not the judge', () => {
  const CHECKS = ['CHECK_A', 'CHECK_B', 'CHECK_C', 'CHECK_D'] as const;

  /** Emits a four-check suite for the harness prompt and a fixed score for the
   *  scoring prompt, so the judge contributes the SAME number to every branch
   *  below and cannot be the source of any ordering. */
  function suiteJudge(score: number): LLM {
    const suite = CHECKS.map((c) => `\`\`\`js\nif (!globalThis.${c}) throw new Error('${c}');\n\`\`\``).join('\n\n');
    const reply = (prompt: string) =>
      prompt.includes('verification harness') ? suite : JSON.stringify({ score });
    return {
      async *stream() { yield ''; },
      async complete(prompt: string) { return reply(prompt); },
    };
  }

  /** Executor that fails every check except the first `passing` of them. */
  function partialExecutor(passing: number): Executor {
    return {
      languages: ['javascript'],
      async execute(source: string) {
        const index = CHECKS.findIndex((c) => source.includes(`throw new Error('${c}')`));
        if (index === -1) return { result: undefined };           // the bare run
        return index < passing
          ? { result: undefined }
          : { result: undefined, error: `${CHECKS[index]} failed` };
      },
    };
  }

  const evaluate = (passing: number) => evaluateWithMultiModelJudging({
    task: 'implement the widget',
    trajectory: withCode('an approach', 'const widget = 1;'),
    executor: partialExecutor(passing),
    judge: suiteJudge(0.5),
    explorer: suiteJudge(0.5),
  });

  test('more checks held is a strictly higher score, with the judge held constant', async () => {
    const [none, half, most] = await Promise.all([evaluate(0), evaluate(2), evaluate(3)]);

    expect(none.execution?.totalChecks).toBe(4);
    expect(none.execution?.passedChecks).toBe(0);
    expect(half.execution?.passedChecks).toBe(2);
    expect(most.execution?.passedChecks).toBe(3);

    // The ordering the old binary verdict could not express.
    expect(none.score).toBeLessThan(half.score);
    expect(half.score).toBeLessThan(most.score);
    // All still inside the fail band: partial credit never reaches a pass.
    expect(most.score).toBeLessThanOrEqual(0.3);
    // FAIL_FLOOR + FAIL_SPAN * (passed/total), the judge contributing nothing.
    expect(none.score).toBeCloseTo(0.05, 10);
    expect(half.score).toBeCloseTo(0.05 + 0.25 * 0.5, 10);
    expect(most.score).toBeCloseTo(0.05 + 0.25 * 0.75, 10);
  });

  test('all four held is a pass, and the judge positions inside the pass band', async () => {
    const all = await evaluate(4);
    expect(all.execution?.passed).toBe(true);
    expect(all.execution?.passedChecks).toBe(4);
    expect(all.score).toBeCloseTo(0.6 + 0.4 * 0.5, 10);
  });

  test('the child inherits the tally, not just a verdict', async () => {
    const partial = await evaluate(2);
    const observation = executionObservation(partial.execution);
    expect(observation).toContain('passed 2 of 4');
    expect(observation).toContain('CHECK_C failed');
  });

  test('no suite means no fraction — the judge positions, and absent is not zero', async () => {
    const unverifiable: LLM = {
      async *stream() { yield ''; },
      async complete(prompt: string) {
        return prompt.includes('verification harness') ? 'UNVERIFIABLE' : JSON.stringify({ score: 0.8 });
      },
    };
    const result = await evaluateWithMultiModelJudging({
      task: 'implement the widget',
      trajectory: withCode('an approach', 'const widget = 1;'),
      executor: exec({ error: 'boom' }),
      judge: unverifiable,
      explorer: unverifiable,
    });
    expect(result.execution?.totalChecks).toBeUndefined();
    expect(result.execution?.assertionsGenerated).toBe(false);
    // Judge-positioned, exactly as before this change.
    expect(result.score).toBeCloseTo(0.05 + 0.25 * 0.8, 10);
  });
});
