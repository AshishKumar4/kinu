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

  test('draws each pair in proportion to its complementary surface', () => {
    // Three pairwise surfaces over this pool: A/B is 2 (one win each), while
    // A/C and B/C are 3 (C wins two instances against either). The previous
    // version of this test asserted `pair.a.id === 'a' || ... || pair.b.id === 'c'`,
    // which every pair drawable from {a,b,c} satisfies, under a comment that put
    // A/C's surface at 1. It could not tell weighted selection from uniform, from
    // first-pair-always, or from returning a dominated pair.
    const a = mkCandidate('a', { i1: 0.9, i2: 0.3, i3: 0.5 });
    const b = mkCandidate('b', { i1: 0.3, i2: 0.9, i3: 0.5 });
    const c = mkCandidate('c', { i1: 0.5, i2: 0.5, i3: 0.7 });
    const ids = ['i1', 'i2', 'i3'];

    // A stratified sweep of the unit interval rather than a seeded stream: it
    // reads the whole distribution the weighting defines, and it is exact. The
    // wins each draw reported are kept per pair rather than asserted per draw —
    // there are three distinct pairs, so 4000 in-loop assertions would say the
    // same three things 4000 times.
    const draws = 4000;
    const share = new Map<string, number>();
    const wins = new Map<string, string>();
    for (let step = 0; step < draws; step++) {
      const pair = findComplementaryPair([a, b, c], ids, () => (step + 0.5) / draws);
      if (!pair) throw new Error('a complementary pair exists in this pool');
      const key = [pair.a.id, pair.b.id].sort().join('');
      share.set(key, (share.get(key) ?? 0) + 1 / draws);
      wins.set(key, `${pair.aDominates.join(',')}|${pair.bDominates.join(',')}`);
    }

    // Surface / total-surface, with total 2 + 3 + 3 = 8. Uniform selection would
    // put all three at 1/3, and any single-pair bias at 1 and 0.
    expect(share.get('ab')).toBeCloseTo(2 / 8, 2);
    expect(share.get('ac')).toBeCloseTo(3 / 8, 2);
    expect(share.get('bc')).toBeCloseTo(3 / 8, 2);

    // Every pair the sweep drew is genuinely complementary on the recorded
    // scores: each side wins somewhere, which is what makes it a merge candidate
    // rather than a dominated pair.
    expect([...wins.entries()].sort()).toEqual([
      ['ab', 'i1|i2'],
      ['ac', 'i1|i2,i3'],
      ['bc', 'i2|i1,i3'],
    ]);
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
    // "Do not naively concatenate" was the only anti-pattern the merge operator
    // named, and naming the likeliest failure mode of a merge-two-files task
    // without showing it is the weakest form of a prohibition. Shown now, with
    // the structural contract the downstream constraint gate would otherwise
    // refuse only after a whole eval-set scoring pass had been paid for.
    expect(prompt).toContain('Do not naively concatenate');
    expect(prompt).toContain('Naive concatenation, and what to do instead:');
    expect(prompt).toContain('the entry point defined twice');
    expect(prompt).toContain('ONE artifact carrying the specific mechanism behind each parent\'s wins');
    expect(prompt).toContain('must survive intact: the entry point they export');
    expect(prompt).toContain('refused by the constraint gate downstream');
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

  // `useMerge: false` is asserted in gepa.test.ts, by 'useMerge off means the
  // operator never runs', which counts the merge prompts and requires zero. The
  // test that stood here ran the same configuration and asserted
  // `iterationsRun >= 0` — true for every possible outcome, since the engine sets
  // it to `history.length - 1` and history always holds the seed.
});
