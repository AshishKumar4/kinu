import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, partitionRunnable, runBenchmark } from './eval';
import { parseSpend, renderSpend, totalSpend, type SpendLine } from './eval-spend';
import { parseCorpus } from '../packages/core/src/index';
import type { EvalCase, ExplorationStrategy, StrategyContext, StrategyResult, JudgeFn } from '../packages/core/src/index';
import { createTestRuntime } from '@proteus/test-utils';
import { MockLanguageModelV3 } from 'ai/test';

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
  const runtime = createTestRuntime().rt;
  const model = new MockLanguageModelV3({
    doGenerate: async () => { throw new Error('stub strategy must not call the model'); },
  });
  const buildContext = (c: EvalCase): StrategyContext => ({
    task: c.task,
    mode: 'build',
    rt: runtime,
    model,
  });
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
  const path = join(import.meta.dir, '..', 'tests/eval/corpus/seed.jsonl');

  test('the committed seed corpus parses', () => {
    const cases = parseCorpus(readFileSync(path, 'utf8'));
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.id && c.task)).toBe(true);
  });

  // This strategy is one generateText call. Scoring it on "create a file" or
  // "run it" measures how politely the model declines, which the judge then
  // turns into a number — the corpus shipped four such cases and they were
  // being scored.
  test('cases needing tools or a second turn are excluded from a single-shot run', () => {
    const { runnable, excluded } = partitionRunnable(parseCorpus(readFileSync(path, 'utf8')));
    expect(excluded.map((c) => c.id).sort()).toEqual(['multi-001', 'multi-002', 'tool-001', 'tool-002']);
    expect(runnable.length).toBeGreaterThan(0);
    for (const c of runnable) {
      expect(c.tags ?? []).not.toContain('tool-use');
      expect(c.tags ?? []).not.toContain('multi-step');
    }
  });

  test('an untagged case is runnable — exclusion is opt-in, not a default', () => {
    const { runnable, excluded } = partitionRunnable([{ id: 'x', task: 't' }]);
    expect(runnable.map((c) => c.id)).toEqual(['x']);
    expect(excluded).toEqual([]);
  });
});

/**
 * The tier's COST REPORT, which is the surface the owner actually reads.
 *
 * The behavioural tier reported `0 model call(s), unreported in / unreported out
 * tokens` for runs that spent hundreds of thousands of neurons, and the number was
 * quoted because nothing in the sentence said it was unmeasured. So the report has
 * to be unable to render a clean zero over work it could not account for: these
 * assert the three lines a reader has to be able to tell apart — a tier that ran
 * nothing, a tier whose provider went partly silent, and a tier with a hole in it.
 */
describe('eval-tier cost report — a zero says which kind of zero it is', () => {
  const measured: SpendLine = {
    suite: 'Behaviour Evals', calls: 42, callsWithoutUsage: 0,
    usage: { input: 13_415_180, output: 401_195 }, episodesUnmeasured: 0,
  };
  /** The regression, as a line: a suite that drove episodes and accounted for
   *  nothing. Before the meter had `episodesUnmeasured` this line was
   *  indistinguishable from a suite that legitimately never ran. */
  const hole: SpendLine = {
    suite: 'Behaviour Evals', calls: 0, callsWithoutUsage: 0, usage: {}, episodesUnmeasured: 20,
  };

  test('a measured tier reports its real totals and claims nothing more', () => {
    const out = renderSpend([measured]);
    expect(out).toContain('42 model call(s), 13415180 input + 401195 output tokens');
    // No caveat is attached to a total that has none. A report that always hedges
    // is a report nobody reads the hedge in.
    expect(out).not.toContain('NOT A TOTAL');
    expect(out).not.toContain('UNACCOUNTED');
  });

  test('a tier with unaccounted episodes is refused a clean zero', () => {
    const out = renderSpend([hole]);
    // The per-suite line names it...
    expect(out).toContain('20 EPISODE(S) UNACCOUNTED');
    // ...and the total refuses to be read as one, which is the sentence that was
    // missing when 584,751 neurons were reported as nothing.
    expect(out).toContain('NOT A TOTAL');
    expect(out).toContain('floor of unknown distance from the bill');
  });

  test('unaccounted episodes survive the sum, so one holed suite marks the run', () => {
    const total = totalSpend([measured, hole]);
    expect(total.calls).toBe(42);
    expect(total.episodesUnmeasured).toBe(20);
    // The measured suite's real tokens are still reported — a hole elsewhere
    // degrades confidence in the total, it does not erase what WAS measured.
    expect(total.usage.input).toBe(13_415_180);
    expect(renderSpend([measured, hole])).toContain('NOT A TOTAL');
  });

  test('a tier that genuinely ran nothing is a different sentence from a hole', () => {
    const out = renderSpend([{
      suite: 'Delegation Evals', calls: 0, callsWithoutUsage: 0, usage: {}, episodesUnmeasured: 0,
    }]);
    expect(out).toContain('0 model call(s)');
    // Nothing ran, nothing is missing, and the report must not cry hole.
    expect(out).not.toContain('NOT A TOTAL');
  });

  test('a silent provider still under-counts, and that is its own caveat', () => {
    const out = renderSpend([{
      suite: 'E2E Lifecycle', calls: 5, callsWithoutUsage: 2,
      usage: { input: 100, output: 10 }, episodesUnmeasured: 0,
    }]);
    expect(out).toContain('2 call(s) the provider reported no usage for');
    // A known under-count is not a hole: the calls were seen and counted, only
    // their tokens were not. Conflating the two would make the loud label routine.
    expect(out).not.toContain('NOT A TOTAL');
  });

  test('the parsed line carries the field, so the aggregate cannot drop the label', () => {
    const [line] = parseSpend(`${JSON.stringify(hole)}\n`);
    expect(line?.episodesUnmeasured).toBe(20);
  });
});
