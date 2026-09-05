import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  parseCorpus, summarizeEval, createLLMJudge, runEvalPair,
} from '../src/index';
import type { EvalCase, EvalResult, ExplorationStrategy, StrategyContext } from '../src/index';
import { createTestRuntime } from './helpers';

const SEED_CORPUS = `# Comment line — ignored
{"id":"a","task":"What is 2+2?","reference":"4","tags":["math","trivial"]}
{"id":"b","task":"Reverse 'abc'.","reference":"cba","tags":["string"]}
{"id":"c","task":"Sum 1..10.","reference":"55","tags":["math"]}
`;

function strategyContext(task: string): StrategyContext {
  const { rt } = createTestRuntime();
  return { task, mode: 'build', rt, model: new MockLanguageModelV3() };
}

describe('eval corpus parsing', () => {
  test('parses well-formed JSONL', () => {
    const cases = parseCorpus(SEED_CORPUS);
    expect(cases.length).toBe(3);
    expect(cases[0]).toEqual({ id: 'a', task: 'What is 2+2?', reference: '4', tags: ['math', 'trivial'] });
  });

  test('skips empty lines and # comments', () => {
    const cases = parseCorpus('\n# header\n\n{"id":"x","task":"t"}\n\n');
    expect(cases.length).toBe(1);
    expect(cases[0].id).toBe('x');
  });

  test('throws on invalid JSON with line number', () => {
    expect(() => parseCorpus('{"id":"a","task":"q"}\n{not json\n'))
      .toThrow(/line 2/);
  });

  test('throws on schema-invalid case', () => {
    expect(() => parseCorpus('{"task":"missing id"}\n'))
      .toThrow('Eval corpus line 1: Invalid key: Expected "id" but received undefined');
  });
});

describe('eval runner', () => {
  function strat(id: string, output: string): ExplorationStrategy {
    return {
      id,
      async explore(_ctx: StrategyContext) {
        return {
          strategy: id,
          best: { text: output, score: 1, source: id },
          all: [{ text: output, score: 1, source: id }],
          cost: { durationMs: 1 },
        };
      },
    };
  }

  test('runEvalPair runs both strategies on each case + collects verdicts', async () => {
    const cases: EvalCase[] = [
      { id: 'q1', task: 'q1?', reference: 'r1' },
      { id: 'q2', task: 'q2?', reference: 'r2' },
    ];
    const a = strat('alpha', 'alpha-answer');
    const b = strat('beta', 'beta-answer');

    const results = await runEvalPair({
      cases,
      strategyA: a,
      strategyB: b,
      buildContext: (evalCase) => strategyContext(evalCase.task),
      judge: async (c, _runA, _runB) => ({
        winner: c.id === 'q1' ? 'a' : 'b',
        scoreA: c.id === 'q1' ? 0.9 : 0.4,
        scoreB: c.id === 'q1' ? 0.4 : 0.9,
        rationale: 'fake judge',
      }),
    });

    expect(results.length).toBe(2);
    expect(results[0].verdict.winner).toBe('a');
    expect(results[1].verdict.winner).toBe('b');
    expect(results[0].runA.output).toBe('alpha-answer');
    expect(results[0].runB.output).toBe('beta-answer');
  });

  test('summarizeEval computes wins/ties/avgs', () => {
    const fakeResult = (winner: 'a' | 'b' | 'tie', sA: number, sB: number): EvalResult => ({
      caseId: 'c', strategyA: 'a', strategyB: 'b',
      runA: { caseId: 'c', strategyId: 'a', output: '', durationMs: 0 },
      runB: { caseId: 'c', strategyId: 'b', output: '', durationMs: 0 },
      verdict: { winner, scoreA: sA, scoreB: sB, rationale: '' },
    });
    const results: EvalResult[] = [
      fakeResult('a', 0.9, 0.5),
      fakeResult('a', 0.8, 0.6),
      fakeResult('b', 0.3, 0.7),
      fakeResult('tie', 0.5, 0.5),
    ];
    const s = summarizeEval(results);
    expect(s.total).toBe(4);
    expect(s.aWins).toBe(2);
    expect(s.bWins).toBe(1);
    expect(s.ties).toBe(1);
    expect(s.avgScoreA).toBeCloseTo(0.625, 2);
    expect(s.avgScoreB).toBeCloseTo(0.575, 2);
  });

  test('handles strategy errors via run.error', async () => {
    const broken: ExplorationStrategy = {
      id: 'broken',
      async explore() { throw new Error('boom'); },
    };
    const ok = strat('ok', 'fine');
    const results = await runEvalPair({
      cases: [{ id: 'x', task: 't' }],
      strategyA: broken,
      strategyB: ok,
      buildContext: (evalCase) => strategyContext(evalCase.task),
      judge: async (_c, runA, _runB) => ({
        winner: 'b', scoreA: 0, scoreB: 1,
        rationale: runA.error ? `A errored: ${runA.error}` : '',
      }),
    });
    expect(results[0].runA.error).toContain('boom');
    expect(results[0].verdict.winner).toBe('b');
  });

  test('a judge failure rejects instead of scoring a tie', async () => {
    const a = strat('alpha', 'alpha-answer');
    const b = strat('beta', 'beta-answer');
    await expect(runEvalPair({
      cases: [{ id: 'x', task: 't' }],
      strategyA: a,
      strategyB: b,
      buildContext: (evalCase) => strategyContext(evalCase.task),
      judge: async () => { throw new Error('judge-provider-down'); },
    })).rejects.toThrow('judge-provider-down');
  });
});

describe('LLM judge adapter', () => {
  test('wraps an LLM call as a JudgeFn', async () => {
    const judge = createLLMJudge(async (_prompt, _schema) => ({
      winner: 'a', scoreA: 0.8, scoreB: 0.4, rationale: 'a was clearer',
    }));
    const verdict = await judge(
      { id: 'c', task: 't' },
      { caseId: 'c', strategyId: 'a', output: 'A out', durationMs: 1 },
      { caseId: 'c', strategyId: 'b', output: 'B out', durationMs: 1 },
    );
    expect(verdict.winner).toBe('a');
    expect(verdict.scoreA).toBe(0.8);
  });
});

describe('eval corpus validation', () => {
  test('rejects empty id', () => {
    expect(() => parseCorpus('{"id":"","task":"q"}\n')).toThrow(/line 1/);
  });

  test('rejects empty task', () => {
    expect(() => parseCorpus('{"id":"a","task":""}\n')).toThrow(/line 1/);
  });

  test('rejects duplicate id naming the line', () => {
    expect(() => parseCorpus('{"id":"dup","task":"one"}\n{"id":"dup","task":"two"}\n'))
      .toThrow(/line 2.*dup/);
  });

  test('rejects unknown keys instead of dropping them', () => {
    expect(() => parseCorpus('{"id":"a","task":"q","typo_field":"oops"}\n'))
      .toThrow(/line 1/);
  });
});
