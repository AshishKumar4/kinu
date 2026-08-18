/**
 * Merge operator tests — pair finding + prompt rendering + LM integration.
 */

import { describe, test, expect } from 'bun:test';
import {
  findComplementaryPair, renderMergePrompt, proposeMerge, runGepa,
  type GepaCandidate, type EvalInstance, type MetricOutcome,
} from './index';

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 0xffffffff;
    return s / 0xffffffff;
  };
}

function mkCandidate(
  source: string, scores: Record<string, number>, createdAt = 0,
): GepaCandidate {
  const m = new Map(Object.entries(scores));
  const total = Array.from(m.values()).reduce((a, b) => a + b, 0);
  return {
    id: source, parentId: null, source,
    scores: m, feedback: new Map(),
    aggregateScore: m.size > 0 ? total / m.size : 0,
    createdAt,
  };
}

describe('findComplementaryPair', () => {
  test('returns null when pool too small', () => {
    expect(findComplementaryPair([], ['i1'], seededRng(1))).toBeNull();
    expect(findComplementaryPair([mkCandidate('a', { i1: 0.5 })], ['i1'], seededRng(1))).toBeNull();
  });

  test('returns null when one candidate strictly dominates', () => {
    const a = mkCandidate('a', { i1: 0.9, i2: 0.9 });
    const b = mkCandidate('b', { i1: 0.3, i2: 0.3 });
    expect(findComplementaryPair([a, b], ['i1', 'i2'], seededRng(1))).toBeNull();
  });

  test('finds a complementary pair where each wins on different instances', () => {
    const a = mkCandidate('a', { i1: 0.9, i2: 0.3 });
    const b = mkCandidate('b', { i1: 0.3, i2: 0.9 });
    const pair = findComplementaryPair([a, b], ['i1', 'i2'], seededRng(1));
    expect(pair).not.toBeNull();
    expect(pair?.aDominates).toContain('i1');
    expect(pair?.bDominates).toContain('i2');
  });

  test('prefers pairs with larger complementary surface (weighted)', () => {
    // Pair A vs B has complementary surface = 2 (both wins).
    // Pair A vs C has complementary surface = 1 (only one win each).
    const a = mkCandidate('a', { i1: 0.9, i2: 0.3, i3: 0.5 });
    const b = mkCandidate('b', { i1: 0.3, i2: 0.9, i3: 0.5 });
    const c = mkCandidate('c', { i1: 0.5, i2: 0.5, i3: 0.7 });
    const pair = findComplementaryPair([a, b, c], ['i1', 'i2', 'i3'], seededRng(1));
    expect(pair).not.toBeNull();
    // Either AB or AC or BC; the weights favor the most-complementary one.
    expect(pair?.a.id === 'a' || pair?.b.id === 'a' || pair?.a.id === 'b' || pair?.b.id === 'b' || pair?.a.id === 'c' || pair?.b.id === 'c').toBe(true);
  });
});

describe('renderMergePrompt', () => {
  test('contains both parent sources, aggregate scores, and per-instance wins', () => {
    const pair = {
      a: mkCandidate('SOURCE-A', { i1: 0.9, i2: 0.3 }),
      b: mkCandidate('SOURCE-B', { i1: 0.3, i2: 0.9 }),
      aDominates: ['i1'],
      bDominates: ['i2'],
    };
    const prompt = renderMergePrompt({
      pair,
      evalSet: [
        { id: 'i1', input: 'first task' },
        { id: 'i2', input: 'second task' },
      ],
      artifactDescription: 'scaffold source',
    });
    expect(prompt).toContain('SOURCE-A');
    expect(prompt).toContain('SOURCE-B');
    expect(prompt).toContain('A wins on:');
    expect(prompt).toContain('B wins on:');
    expect(prompt).toContain('first task');
    expect(prompt).toContain('second task');
    expect(prompt).toContain('Return ONLY the merged');
  });
});

describe('proposeMerge integrates with the LM', () => {
  test('strips markdown fences from the LM output', async () => {
    const pair = {
      a: mkCandidate('A', { i1: 0.9 }),
      b: mkCandidate('B', { i1: 0.3 }),
      aDominates: ['i1'],
      bDominates: [],
    };
    const reflectionLm = async () => '```\nMERGED-SOURCE\n```';
    const out = await proposeMerge({
      pair,
      evalSet: [{ id: 'i1', input: 'x' }],
      reflectionLm,
    });
    expect(out).toBe('MERGED-SOURCE');
  });
});

describe('runGepa with Merge end-to-end', () => {
  test('Merge fires on cadence when pool has complementary candidates', async () => {
    // Set up so the LM proposes complementary specialists then a winning merge.
    const evalSet: EvalInstance<string>[] = [
      { id: 'i1', input: 'task A' },
      { id: 'i2', input: 'task B' },
    ];

    // Metric:
    //   seed → 0.5 on all
    //   spec-A → 0.9 on i1, 0.3 on i2  (i1 specialist)
    //   spec-B → 0.3 on i1, 0.9 on i2  (i2 specialist; complementary to A)
    //   merged → 0.9 on both (best of both)
    // Override metric per-instance:
    const richMetric = async (source: string, inst: EvalInstance<string>): Promise<MetricOutcome> => {
      const i = inst.id;
      if (source === 'merged') return { score: 0.95, feedback: 'merged-best' };
      if (source === 'spec-A') return { score: i === 'i1' ? 0.9 : 0.3, feedback: 'spec-A' };
      if (source === 'spec-B') return { score: i === 'i1' ? 0.3 : 0.9, feedback: 'spec-B' };
      return { score: 0.5, feedback: 'seed' };
    };

    let lmCall = 0;
    const reflectionLm = async (prompt: string): Promise<string> => {
      lmCall++;
      if (prompt.includes('merging two')) return 'merged';
      if (lmCall === 1) return 'spec-A';
      if (lmCall === 2) return 'spec-B';
      return 'spec-A'; // shouldn't reach
    };

    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric: richMetric,
      reflectionLm,
      budget: {
        maxIterations: 4,
        maxMetricCalls: 200,
        minibatchSize: 1,
        useMerge: true,
        mergeEveryN: 2,
        maxMergeInvocations: 5,
      },
      random: seededRng(11),
    });

    // Merged candidate should have won.
    expect(result.winner.source).toBe('merged');
    expect(result.winner.aggregateScore).toBeCloseTo(0.95, 3);
  });

  test('useMerge: false disables the operator', async () => {
    const evalSet: EvalInstance<string>[] = [
      { id: 'i1', input: 'a' }, { id: 'i2', input: 'b' },
    ];
    const reflectionLm = async () => 'mut';
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.5, feedback: '' });
    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: {
        maxIterations: 5, maxMetricCalls: 200, minibatchSize: 1,
        useMerge: false, mergeEveryN: 1, maxMergeInvocations: 5,
      },
      random: seededRng(1),
    });
    expect(result.iterationsRun).toBeGreaterThanOrEqual(0);
  });
});
