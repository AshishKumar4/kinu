/**
 * GEPA — behaviour tests through the public surface.
 *
 * Asserts the algorithm's contract using deterministic mock metrics + a
 * deterministic mock reflection LM, so the optimisation runs are
 * reproducible byte-for-byte.
 *
 * No real LLM calls; no real scaffold execution. The point of these tests
 * is the algorithm's correctness, not the quality of the artefact produced
 * by any specific LM.
 */

import { describe, test, expect } from 'bun:test';
import {
  runGepa, computeParetoFront, sampleParentByWeight, bestAggregate,
  parentSelectionWeights, rolloutMinibatch, renderReflectionPrompt,
  stripMarkdownFences,
  type EvalInstance, type GepaCandidate, type MetricOutcome,
} from './index.js';

// ── deterministic RNG ────────────────────────────────────────────

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 0xffffffff;
    return s / 0xffffffff;
  };
}

// ── helpers to build candidates / instances ──────────────────────

function mkInstance(id: string, input: string): EvalInstance<string> {
  return { id, input };
}

function mkCandidate(
  source: string,
  scores: Record<string, number>,
  createdAt = 0,
): GepaCandidate {
  const m = new Map(Object.entries(scores));
  const total = Array.from(m.values()).reduce((a, b) => a + b, 0);
  return {
    id: source,
    parentId: null,
    source,
    scores: m,
    feedback: new Map(),
    aggregateScore: m.size > 0 ? total / m.size : 0,
    createdAt,
  };
}

// ── Pareto ───────────────────────────────────────────────────────

describe('computeParetoFront', () => {
  test('empty pool returns empty', () => {
    const r = computeParetoFront([], ['a', 'b']);
    expect(r.front).toEqual([]);
  });

  test('single candidate is its own front', () => {
    const a = mkCandidate('a', { i1: 0.5, i2: 0.5 });
    const r = computeParetoFront([a], ['i1', 'i2']);
    expect(r.front).toEqual([a]);
  });

  test('strictly-dominated candidate is excluded', () => {
    const winner = mkCandidate('winner', { i1: 0.9, i2: 0.9 });
    const loser = mkCandidate('loser', { i1: 0.5, i2: 0.5 });
    const r = computeParetoFront([winner, loser], ['i1', 'i2']);
    expect(r.front).toEqual([winner]);
    expect(r.front).not.toContain(loser);
  });

  test('preserves specialists (different per-instance maxima)', () => {
    // a wins on i1, b wins on i2, neither dominates the other.
    const a = mkCandidate('a', { i1: 0.9, i2: 0.3 });
    const b = mkCandidate('b', { i1: 0.3, i2: 0.9 });
    const generalist = mkCandidate('g', { i1: 0.5, i2: 0.5 });
    const r = computeParetoFront([a, b, generalist], ['i1', 'i2']);
    expect(r.front).toContain(a);
    expect(r.front).toContain(b);
    expect(r.front).not.toContain(generalist);
  });

  test('ties on an instance both appear in perInstanceBest', () => {
    const a = mkCandidate('a', { i1: 0.7 });
    const b = mkCandidate('b', { i1: 0.7 });
    const r = computeParetoFront([a, b], ['i1']);
    expect(r.perInstanceBest.get('i1')).toEqual([a, b]);
  });
});

describe('parentSelectionWeights + sampleParentByWeight', () => {
  test('weight equals the number of instances a candidate dominates', () => {
    const a = mkCandidate('a', { i1: 0.9, i2: 0.3, i3: 0.3 });
    const b = mkCandidate('b', { i1: 0.3, i2: 0.9, i3: 0.3 });
    const c = mkCandidate('c', { i1: 0.3, i2: 0.3, i3: 0.9 });
    const w = parentSelectionWeights([a, b, c], ['i1', 'i2', 'i3']);
    expect(w.get(a)).toBe(1);
    expect(w.get(b)).toBe(1);
    expect(w.get(c)).toBe(1);
  });

  test('candidates with no per-instance wins get weight 0', () => {
    const winner = mkCandidate('w', { i1: 0.9, i2: 0.9 });
    const loser = mkCandidate('l', { i1: 0.5, i2: 0.5 });
    const w = parentSelectionWeights([winner, loser], ['i1', 'i2']);
    expect(w.get(winner)).toBe(2);
    expect(w.get(loser)).toBe(0);
  });

  test('falls back to bestAggregate when no Pareto signal yet', () => {
    // Two identical-everywhere candidates — neither dominates → both weight 0.
    const a = mkCandidate('a', { i1: 0.5, i2: 0.5 }, 100);
    const b = mkCandidate('b', { i1: 0.5, i2: 0.5 }, 200);
    const sampled = sampleParentByWeight([a, b], ['i1', 'i2'], seededRng(1));
    // bestAggregate returns the older one on ties.
    expect(sampled.id).toBe('a');
  });

  test('single-candidate pool always returns that candidate', () => {
    const a = mkCandidate('a', { i1: 0.1 });
    const sampled = sampleParentByWeight([a], ['i1'], seededRng(1));
    expect(sampled).toBe(a);
  });
});

describe('bestAggregate', () => {
  test('picks highest mean', () => {
    const lo = mkCandidate('lo', { i1: 0.1, i2: 0.1 });
    const hi = mkCandidate('hi', { i1: 0.9, i2: 0.9 });
    expect(bestAggregate([lo, hi])).toBe(hi);
  });

  test('older candidate wins ties', () => {
    const older = mkCandidate('older', { i1: 0.5 }, 100);
    const newer = mkCandidate('newer', { i1: 0.5 }, 200);
    expect(bestAggregate([older, newer])).toBe(older);
    expect(bestAggregate([newer, older])).toBe(older);
  });
});

// ── reflection helpers ───────────────────────────────────────────

describe('stripMarkdownFences', () => {
  test('strips ``` fences when present', () => {
    expect(stripMarkdownFences('```ts\nconst x = 1\n```')).toBe('const x = 1');
    expect(stripMarkdownFences('```\nfoo\n```')).toBe('foo');
  });

  test('leaves un-fenced content alone', () => {
    expect(stripMarkdownFences('plain text')).toBe('plain text');
  });
});

describe('rolloutMinibatch', () => {
  test('scores every instance and totals metric calls', async () => {
    const minibatch = [mkInstance('i1', 'a'), mkInstance('i2', 'b')];
    let calls = 0;
    const metric = async (_c: string, inst: EvalInstance<string>): Promise<MetricOutcome> => {
      calls++;
      return { score: inst.id === 'i1' ? 0.8 : 0.4, feedback: `f-${inst.id}` };
    };
    const r = await rolloutMinibatch('candidate-source', minibatch, metric);
    expect(calls).toBe(2);
    expect(r.metricCalls).toBe(2);
    expect(r.outcomes[0]).toEqual({ instanceId: 'i1', outcome: { score: 0.8, feedback: 'f-i1' } });
    expect(r.outcomes[1]).toEqual({ instanceId: 'i2', outcome: { score: 0.4, feedback: 'f-i2' } });
  });
});

describe('renderReflectionPrompt', () => {
  test('includes parent source, aggregate score, and per-instance feedback', () => {
    const parent = mkCandidate('SEED-SOURCE', { i1: 0.4 });
    const prompt = renderReflectionPrompt({
      parent,
      minibatch: [mkInstance('i1', 'task input')],
      rollout: {
        outcomes: [{ instanceId: 'i1', outcome: { score: 0.4, feedback: 'too verbose' } }],
        metricCalls: 1,
      },
      artifactDescription: 'scaffold source',
    });
    expect(prompt).toContain('scaffold source');
    expect(prompt).toContain('SEED-SOURCE');
    expect(prompt).toContain('task input');
    expect(prompt).toContain('too verbose');
    expect(prompt).toContain('Return ONLY the revised');
  });
});

// ── runGepa end-to-end ───────────────────────────────────────────

describe('runGepa', () => {
  test('returns seed when reflection LM declines to mutate', async () => {
    const evalSet = [mkInstance('i1', 'a'), mkInstance('i2', 'b')];
    const metric = async (c: string): Promise<MetricOutcome> => ({
      score: c.length / 10, feedback: `len=${c.length}`,
    });
    const reflectionLm = async () => 'seed'; // no change
    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 3, maxMetricCalls: 100, minibatchSize: 1 },
      random: seededRng(1),
    });
    expect(result.winner.source).toBe('seed');
    expect(result.history.length).toBe(1); // only the seed
  });

  test('finds the higher-scoring candidate proposed by the LM', async () => {
    const evalSet = [mkInstance('i1', 'a'), mkInstance('i2', 'b'), mkInstance('i3', 'c')];
    let proposeCount = 0;
    const reflectionLm = async (): Promise<string> => {
      proposeCount++;
      return proposeCount === 1 ? 'better-source' : 'better-source';
    };
    // Metric: 'seed' scores 0.5 everywhere, 'better-source' scores 0.9.
    const metric = async (c: string): Promise<MetricOutcome> =>
      c === 'better-source' ? { score: 0.9, feedback: '' } : { score: 0.5, feedback: 'mediocre' };

    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 2, maxMetricCalls: 100, minibatchSize: 2 },
      random: seededRng(42),
    });
    expect(result.winner.source).toBe('better-source');
    expect(result.winner.aggregateScore).toBeCloseTo(0.9, 5);
  });

  test('rejects candidates exceeding maxSizeBytes — does not consume scoring budget', async () => {
    const evalSet = [mkInstance('i1', 'a')];
    let scoringCalls = 0;
    const metric = async (): Promise<MetricOutcome> => {
      scoringCalls++;
      return { score: 0.5, feedback: '' };
    };
    const reflectionLm = async () => 'x'.repeat(100); // way too big
    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 3, maxMetricCalls: 100, minibatchSize: 1 },
      constraints: { maxSizeBytes: 50 },
      random: seededRng(1),
    });
    // Seed (1 call) + rollouts on each iteration (3 × 1 = 3); no full-eval scoring
    // for rejected candidates.
    expect(result.history.length).toBe(1);
    // Stop reason should be `no_improvement_possible` because we hit
    // REJECTION_GIVE_UP (5) but only had 3 iterations — actually iterations
    // exhausted comes first.
    expect(result.stopReason).toBe('iterations_exhausted');
    // Scoring calls = seed-eval (1) + mutation rollouts (3 × 1).
    expect(scoringCalls).toBe(1 + 3 * 1);
  });

  test('rejects candidates failing testRunner', async () => {
    const evalSet = [mkInstance('i1', 'a')];
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.5, feedback: '' });
    const reflectionLm = async () => 'bad-source';
    const testRunner = async (): Promise<boolean> => false;
    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 2, maxMetricCalls: 100, minibatchSize: 1 },
      constraints: { testRunner },
      random: seededRng(1),
    });
    expect(result.history.length).toBe(1);
    expect(result.winner.source).toBe('seed');
  });

  test('stops on metric_budget_exhausted', async () => {
    const evalSet = [mkInstance('i1', 'a'), mkInstance('i2', 'b')];
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.5, feedback: '' });
    const reflectionLm = async () => 'unique-' + Math.random();
    // Tight budget: only enough for the seed (2 calls) + 1 full iter (minibatch 1 + eval 2 = 3).
    // Second iteration would need 3 more calls but only 0 left — should stop.
    const result = await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 10, maxMetricCalls: 5, minibatchSize: 1 },
      random: seededRng(1),
    });
    expect(result.stopReason).toBe('metric_budget_exhausted');
    expect(result.metricCallsUsed).toBeLessThanOrEqual(5);
  });

  test('onIteration receives accepted and rejected states', async () => {
    const evalSet = [mkInstance('i1', 'a')];
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.5, feedback: '' });
    let count = 0;
    let rejected = 0;
    const reflectionLm = async () => {
      count++;
      return count === 1 ? 'novel' : 'novel'; // novel once, then duplicate of novel
    };
    await runGepa({
      seed: 'seed',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 3, maxMetricCalls: 100, minibatchSize: 1 },
      onIteration: (s) => { if (!s.accepted) rejected++; },
      random: seededRng(1),
    });
    expect(rejected).toBeGreaterThan(0);
  });

  test('rejects empty eval set up-front', async () => {
    await expect(runGepa({
      seed: 'x',
      evalSet: [],
      metric: async () => ({ score: 0, feedback: '' }),
      reflectionLm: async () => 'x',
    })).rejects.toThrow(/non-empty/);
  });

  test('rejects out-of-range minibatchSize', async () => {
    await expect(runGepa({
      seed: 'x',
      evalSet: [mkInstance('i1', 'a')],
      metric: async () => ({ score: 0, feedback: '' }),
      reflectionLm: async () => 'x',
      budget: { maxIterations: 1, maxMetricCalls: 10, minibatchSize: 5 },
    })).rejects.toThrow(/minibatchSize/);
  });
});
