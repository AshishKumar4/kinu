import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, runBenchmark } from './eval.ts';
import { parseCorpus } from '../packages/core/src/index.js';
import type { EvalCase, ExplorationStrategy, StrategyContext, StrategyResult, JudgeFn } from '../packages/core/src/index.js';

function stubStrategy(id: string, output: string): ExplorationStrategy {
  return {
    id,
    async explore(_ctx: StrategyContext): Promise<StrategyResult> {
      return {
        strategy: id,
        best: { text: output, score: 1, source: id },
        all: [{ text: output, score: 1, source: id }],
        cost: { durationMs: 1 },
      };
    },
  };
}

const CASES: EvalCase[] = [
  { id: 'q1', task: 'q1?', reference: 'r1' },
  { id: 'q2', task: 'q2?', reference: 'r2' },
];

describe('parseArgs', () => {
  test('defaults to the seed corpus + committed threshold', () => {
    const opts = parseArgs([]);
    expect(opts.corpus).toContain('tests/eval/corpus/seed.jsonl');
    expect(opts.threshold).toBeGreaterThan(0);
    expect(opts.help).toBe(false);
  });

  test('parses model / baseline / judge / min-score / out', () => {
    const opts = parseArgs(['--model', 'p/m', '--baseline-model', 'p/b', '--judge-model', 'p/j', '--min-score', '0.7', '--out', 'r.json']);
    expect(opts.model).toBe('p/m');
    expect(opts.baselineModel).toBe('p/b');
    expect(opts.judgeModel).toBe('p/j');
    expect(opts.threshold).toBe(0.7);
    expect(opts.out).toBe('r.json');
  });

  test('--help sets help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });

  test('rejects an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });

  test('rejects an out-of-range threshold', () => {
    expect(() => parseArgs(['--min-score', '2'])).toThrow(/\[0,1\]/);
  });

  test('rejects a flag missing its value', () => {
    expect(() => parseArgs(['--model'])).toThrow(/missing value/);
  });
});

describe('runBenchmark (stubbed model + judge — no real LLM)', () => {
  const buildContext = (c: EvalCase): StrategyContext => ({ task: c.task, rt: null as never, model: null as never });
  const judge: JudgeFn = async (c) => ({
    winner: c.id === 'q1' ? 'b' : 'tie',
    scoreA: 0.6,
    scoreB: c.id === 'q1' ? 0.9 : 0.6,
    rationale: 'stub',
  });

  test('produces a structured report + a passing gate', async () => {
    const { report, gate } = await runBenchmark({
      cases: CASES,
      strategyA: stubStrategy('baseline', 'a-out'),
      strategyB: stubStrategy('candidate', 'b-out'),
      buildContext,
      judge,
      threshold: 0.5,
      meta: { modelA: 'm', modelB: 'm', corpus: 'seed.jsonl' },
    });
    expect(report.summary.total).toBe(2);
    expect(report.aggregateScore).toBeCloseTo((0.9 + 0.6) / 2, 5);
    expect(report.cases.map((c) => c.caseId)).toEqual(['q1', 'q2']);
    expect(report.strategyB).toBe('candidate');
    expect(gate.pass).toBe(true);
  });

  test('gate fails when the aggregate is below the floor', async () => {
    const { gate } = await runBenchmark({
      cases: CASES,
      strategyA: stubStrategy('baseline', 'a'),
      strategyB: stubStrategy('candidate', 'b'),
      buildContext,
      judge,
      threshold: 0.95,
      meta: {},
    });
    expect(gate.pass).toBe(false);
    expect(gate.reason).toContain('regression');
  });
});

describe('seed corpus', () => {
  test('the committed seed corpus parses', () => {
    const path = join(import.meta.dir, '..', 'tests/eval/corpus/seed.jsonl');
    const cases = parseCorpus(readFileSync(path, 'utf8'));
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.id && c.task)).toBe(true);
  });
});
