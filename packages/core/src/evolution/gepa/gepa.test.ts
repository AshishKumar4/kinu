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
  type EvalInstance, type GepaBudget, type GepaCandidate, type MetricOutcome,
} from './index';
import { DELEGATION_RUBRIC } from '../delegation-features';

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
      minibatch: [{
        ...mkInstance('i1', 'task input'),
        evidence: 'Outcome: corrected\nTurn process: 41 sequential steps, 0 team, 0 think, 0 peers, 0 execute_tools, 6.2min wall clock',
      }],
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
    expect(prompt).toContain('Turn process: 41 sequential steps, 0 team, 0 think');
    // The rubric is one shared string now (evolution/delegation-features.ts), in
    // the vocabulary the evidence line above it actually prints — the two inline
    // copies had drifted into "team/think/heads" here and "hire/search" in the
    // turn reflection, for one ladder.
    expect(prompt).toContain(DELEGATION_RUBRIC);
    expect(prompt).toContain(
      'ground through inline with no hiring\n  and no exploration, is a lesson to decompose the work and delegate it',
    );
    expect(prompt).toContain('An accepted turn that hired or explored effectively earns credit');
    expect(prompt).toContain('Spawns that contributed nothing are delegation overhead');
    // The prohibition is shown, not only named, and the unseen half of the eval
    // set is stated rather than left for the reflector to infer.
    expect(prompt).toContain('Specific and tightly scoped, by contrast:');
    expect(prompt).toContain('One defect, one edit, named instances.');
    expect(prompt).toContain('do not remove or weaken anything the failures above do not implicate');
    expect(prompt).toContain('Return ONLY the revised');
  });

  test('keeps the delegation rubric scoped to scaffold reflection', () => {
    const parent = mkCandidate('tool-source', { i1: 0.4 });
    const prompt = renderReflectionPrompt({
      parent,
      minibatch: [mkInstance('i1', 'task input')],
      rollout: {
        outcomes: [{ instanceId: 'i1', outcome: { score: 0.4, feedback: 'too slow' } }],
        metricCalls: 1,
      },
      artifactDescription: 'crafted tool source',
    });
    expect(prompt).not.toContain('Delegation rubric');
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

  test('rejects a non-positive minibatchSize', async () => {
    await expect(runGepa({
      seed: 'x',
      evalSet: [mkInstance('i1', 'a')],
      metric: async () => ({ score: 0, feedback: '' }),
      reflectionLm: async () => 'x',
      budget: { maxIterations: 1, maxMetricCalls: 10, minibatchSize: 0 },
    })).rejects.toThrow(/minibatchSize/);
  });
});

// ── train/val split discipline ───────────────────────────────────

describe('runGepa — trainSet (upstream train/val discipline)', () => {
  test('reflection minibatches sample ONLY from trainSet; scoring runs on the full evalSet', async () => {
    const train = [mkInstance('neg1', 'failed task A'), mkInstance('neg2', 'failed task B')];
    const evalSet = [...train, mkInstance('pos1', 'accepted task C'), mkInstance('pos2', 'accepted task D')];

    // Track which instances each phase touches. Rollouts happen on candidates
    // already in the pool (the parent); eval-set scoring covers every id.
    const rolledOut = new Set<string>();
    let scored = 0;
    const metric = async (candidate: string, instance: EvalInstance<string>): Promise<MetricOutcome> => {
      if (candidate === 'seed' && scored >= evalSet.length) rolledOut.add(instance.id);
      scored++;
      return { score: candidate === 'improved' ? 0.9 : 0.4, feedback: 'fb' };
    };

    const result = await runGepa({
      seed: 'seed',
      evalSet,
      trainSet: train,
      metric,
      reflectionLm: async () => 'improved',
      budget: { maxIterations: 2, maxMetricCalls: 100, minibatchSize: 2 },
      random: seededRng(7),
    });

    expect(result.winner.source).toBe('improved');
    expect(rolledOut.size).toBeGreaterThan(0);
    for (const id of rolledOut) expect(['neg1', 'neg2']).toContain(id);
    // The winner was still scored on every val instance (regression guard).
    expect([...result.winner.scores.keys()].sort()).toEqual(['neg1', 'neg2', 'pos1', 'pos2']);
  });

  test('minibatch size larger than the trainSet clamps instead of throwing', async () => {
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('a', 'x'), mkInstance('b', 'y'), mkInstance('c', 'z')],
      trainSet: [mkInstance('a', 'x')],
      metric: async (c) => ({ score: c === 'better' ? 1 : 0.2, feedback: 'fb' }),
      reflectionLm: async () => 'better',
      budget: { maxIterations: 1, maxMetricCalls: 100, minibatchSize: 3 },
      random: seededRng(3),
    });
    expect(result.winner.source).toBe('better');
  });
});

// ── metric-call accounting ───────────────────────────────────────
//
// `metricCallsUsed` is what the caller pays for and what the persistence layer
// reports. The existing tests all run under a budget of 100, so the ledger
// could drift from the calls actually made and nothing would notice.

/** Counts real metric invocations so the reported total can be checked against
 *  the truth rather than against itself. */
function countingMetric(score: (source: string, instanceId: string) => number) {
  const state = { calls: 0 };
  const metric = async (source: string, inst: EvalInstance<string>): Promise<MetricOutcome> => {
    state.calls++;
    return { score: score(source, inst.id), feedback: 'fb' };
  };
  return { metric, state };
}

describe('runGepa — metric-call accounting', () => {
  test('the reported total equals the calls actually made, seed scoring included', async () => {
    const { metric, state } = countingMetric((c) => (c === 'better' ? 0.9 : 0.4));
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a'), mkInstance('i2', 'b'), mkInstance('i3', 'c')],
      metric,
      reflectionLm: async () => 'better',
      budget: { maxIterations: 1, maxMetricCalls: 100, minibatchSize: 1 },
      random: seededRng(1),
    });
    // seed scoring (3) + one rollout (1) + one full-eval scoring (3).
    expect(state.calls).toBe(7);
    expect(result.metricCallsUsed).toBe(7);
  });

  test('never spends past maxMetricCalls, at any budget', async () => {
    for (let maxMetricCalls = 4; maxMetricCalls <= 14; maxMetricCalls++) {
      let call = 0;
      const { metric, state } = countingMetric(() => 0.5);
      const result = await runGepa({
        seed: 'seed',
        evalSet: [mkInstance('i1', 'a'), mkInstance('i2', 'b')],
        metric,
        reflectionLm: async () => `MUT_${++call}`,
        budget: { maxIterations: 10, maxMetricCalls, minibatchSize: 1 },
        random: seededRng(1),
      });
      expect(result.metricCallsUsed).toBe(state.calls);
      expect(result.metricCallsUsed).toBeLessThanOrEqual(maxMetricCalls);
    }
  });

  test('the budget guard reserves a whole worst-case iteration, and no more', async () => {
    // evalSet 2 + minibatch 1 = 3 per iteration; seed scoring takes 2 of 5.
    // Exactly 3 remain, which is exactly enough — the guard must not round it
    // away, and must stop before the iteration that cannot be paid for.
    let call = 0;
    const { metric, state } = countingMetric(() => 0.5);
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a'), mkInstance('i2', 'b')],
      metric,
      reflectionLm: async () => `MUT_${++call}`,
      budget: { maxIterations: 10, maxMetricCalls: 5, minibatchSize: 1 },
      random: seededRng(1),
    });
    expect(result.history.length).toBe(2);
    expect(state.calls).toBe(5);
    expect(result.stopReason).toBe('metric_budget_exhausted');
  });

  test('the reservation is sized by the train set, not by the requested minibatch', async () => {
    // minibatchSize 3 over a 1-instance train set really costs 1. Reserving 3
    // would abandon a run that is comfortably affordable.
    const { metric, state } = countingMetric((c) => (c === 'better' ? 1 : 0.2));
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('a', 'x'), mkInstance('b', 'y'), mkInstance('c', 'z')],
      trainSet: [mkInstance('a', 'x')],
      metric,
      reflectionLm: async () => 'better',
      budget: { maxIterations: 10, maxMetricCalls: 8, minibatchSize: 3 },
      random: seededRng(3),
    });
    // seed (3) + rollout (1) + scoring (3) = 7; a second iteration needs 4 more.
    expect(state.calls).toBe(7);
    expect(result.history.length).toBe(2);
    expect(result.winner.source).toBe('better');
  });

  test('an EMPTY trainSet falls back to the eval set rather than emptying the minibatch', async () => {
    const { metric, state } = countingMetric((c) => (c === 'better' ? 0.9 : 0.4));
    await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a'), mkInstance('i2', 'b'), mkInstance('i3', 'c')],
      trainSet: [],
      metric,
      reflectionLm: async () => 'better',
      budget: { maxIterations: 1, maxMetricCalls: 100, minibatchSize: 2 },
      random: seededRng(1),
    });
    // seed (3) + a real 2-instance rollout + scoring (3). A `?? ` fallback that
    // accepted the empty array would silently reflect on no evidence at all.
    expect(state.calls).toBe(8);
  });

  test('iterationsRun counts accepted candidates, not loop turns', async () => {
    let call = 0;
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a')],
      metric: async (c) => ({ score: c === 'seed' ? 0.9 : 0.3, feedback: 'fb' }),
      // Two accepted, then a no-change rejection.
      reflectionLm: async () => { call++; return call <= 2 ? `MUT_${call}` : 'seed'; },
      budget: { maxIterations: 3, maxMetricCalls: 100, minibatchSize: 1 },
      parentSelection: 'best-aggregate',
      random: seededRng(1),
    });
    expect(result.history.length).toBe(3);   // seed + 2 accepted
    expect(result.iterationsRun).toBe(2);
  });
});

// ── the rejection state machine ──────────────────────────────────

/** Collect every rejection reason the loop reports. */
interface RejectionLog {
  reasons: string[];
  onIteration: (state: { accepted: boolean; rejectionReason?: string }) => void;
}

function rejectionLog(): RejectionLog {
  const reasons: string[] = [];
  return {
    reasons,
    onIteration: (s) => { if (!s.accepted) reasons.push(s.rejectionReason ?? '(none)'); },
  };
}

describe('runGepa — rejection reasons and the give-up counter', () => {
  test('a proposal identical to its parent is rejected as no_change, not as a duplicate', async () => {
    // Both guards would stop the candidate, so only the REASON distinguishes
    // them — and the reason is what the operator sees in the run log.
    const log = rejectionLog();
    await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a')],
      metric: async () => ({ score: 0.5, feedback: 'fb' }),
      reflectionLm: async () => 'seed',
      budget: { maxIterations: 3, maxMetricCalls: 100, minibatchSize: 1 },
      parentSelection: 'best-aggregate',
      onIteration: log.onIteration,
      random: seededRng(1),
    });
    expect(log.reasons).toEqual(['no_change', 'no_change', 'no_change']);
  });

  test('a proposal already in the pool but different from the parent is a duplicate', async () => {
    // seed outscores everything, so best-aggregate keeps the parent at 'seed'
    // and the re-proposed 'ALT' can only trip the pool-duplicate guard.
    const log = rejectionLog();
    await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a')],
      metric: async (c) => ({ score: c === 'seed' ? 0.9 : 0.3, feedback: 'fb' }),
      reflectionLm: async () => 'ALT',
      budget: { maxIterations: 3, maxMetricCalls: 100, minibatchSize: 1 },
      parentSelection: 'best-aggregate',
      onIteration: log.onIteration,
      random: seededRng(1),
    });
    expect(log.reasons).toEqual(['duplicate_in_pool', 'duplicate_in_pool']);
  });

  test('gives up after exactly 5 consecutive rejections', async () => {
    const log = rejectionLog();
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a')],
      metric: async () => ({ score: 0.5, feedback: 'fb' }),
      reflectionLm: async () => 'seed',
      budget: { maxIterations: 50, maxMetricCalls: 1000, minibatchSize: 1 },
      parentSelection: 'best-aggregate',
      onIteration: log.onIteration,
      random: seededRng(1),
    });
    expect(log.reasons).toHaveLength(5);
    expect(result.stopReason).toBe('no_improvement_possible');
  });

  test('an accepted candidate resets the counter — scattered rejections never give up', async () => {
    // Alternating reject/accept: six rejections in twelve iterations, never
    // five in a row. A counter that only ever climbs would abandon the run
    // halfway through and report no_improvement_possible.
    let call = 0;
    const log = rejectionLog();
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a')],
      metric: async (c) => ({ score: c === 'seed' ? 0.9 : 0.3, feedback: 'fb' }),
      reflectionLm: async () => { call++; return call % 2 === 1 ? 'seed' : `MUT_${call}`; },
      budget: { maxIterations: 12, maxMetricCalls: 1000, minibatchSize: 1 },
      parentSelection: 'best-aggregate',
      onIteration: log.onIteration,
      random: seededRng(1),
    });
    expect(log.reasons).toHaveLength(6);
    expect(result.history.length).toBe(7);   // seed + 6 accepted
    expect(result.stopReason).toBe('iterations_exhausted');
  });

  test('a throwing onIteration hook does not abort the run', async () => {
    // The hook is the caller's persistence/telemetry seam; a failure there
    // must not cost the optimisation run that has already been paid for.
    const result = await runGepa({
      seed: 'seed',
      evalSet: [mkInstance('i1', 'a')],
      metric: async (c) => ({ score: c === 'better' ? 0.9 : 0.4, feedback: 'fb' }),
      reflectionLm: async () => 'better',
      budget: { maxIterations: 1, maxMetricCalls: 100, minibatchSize: 1 },
      onIteration: () => { throw new Error('sink exploded'); },
      random: seededRng(1),
    });
    expect(result.winner.source).toBe('better');
  });
});

// ── constraints ──────────────────────────────────────────────────

describe('runGepa — constraint checks', () => {
  const evalSet = [mkInstance('i1', 'a')];
  const metric = async (c: string): Promise<MetricOutcome> => ({
    score: c === 'seed' ? 0.2 : 0.9, feedback: 'fb',
  });

  async function runWith(constraints: Parameters<typeof runGepa>[0]['constraints'], source: string) {
    const log = rejectionLog();
    const result = await runGepa({
      seed: 'seed', evalSet, metric,
      reflectionLm: async () => source,
      budget: { maxIterations: 1, maxMetricCalls: 100, minibatchSize: 1 },
      constraints,
      onIteration: log.onIteration,
      random: seededRng(1),
    });
    return { accepted: result.history.length === 2, reasons: log.reasons };
  }

  test('a source of exactly maxSizeBytes is within the cap', async () => {
    expect((await runWith({ maxSizeBytes: 10 }, 'x'.repeat(10))).accepted).toBe(true);
    expect((await runWith({ maxSizeBytes: 10 }, 'x'.repeat(11))).accepted).toBe(false);
  });

  test('forbiddenPatterns reject the candidate and name the pattern', async () => {
    const { accepted, reasons } = await runWith({ forbiddenPatterns: [/eval\(/] }, 'eval(danger)');
    expect(accepted).toBe(false);
    expect(reasons[0]).toContain('forbidden pattern');
    expect((await runWith({ forbiddenPatterns: [/eval\(/] }, 'safe source')).accepted).toBe(true);
  });

  test('customCheck rejects with its own message', async () => {
    const { accepted, reasons } = await runWith(
      { customCheck: (s) => (s.includes('TODO') ? 'contains a TODO' : null) },
      'still TODO',
    );
    expect(accepted).toBe(false);
    expect(reasons[0]).toContain('contains a TODO');
    expect((await runWith({ customCheck: () => null }, 'finished source')).accepted).toBe(true);
  });
});

// ── specialists vs the generalist, and the Merge operator ────────

interface SpecialistScores {
  [candidate: string]: Record<string, number>;
}

const SPECIALIST_SCORES: SpecialistScores = {
  seed:         { i1: 0.1, i2: 0.1 },
  SPEC_A:       { i1: 1.0, i2: 0.0 },
  SPEC_B:       { i1: 0.0, i2: 1.0 },
  GENERALIST:   { i1: 0.6, i2: 0.6 },
  FINAL:        { i1: 0.2, i2: 0.2 },
  MERGED:       { i1: 0.5, i2: 0.5 },
};
const specialistMetric = async (source: string, inst: EvalInstance<string>): Promise<MetricOutcome> => ({
  score: SPECIALIST_SCORES[source]?.[inst.id] ?? 0,
  feedback: 'fb',
});
const twoInstances = [mkInstance('i1', 'input-one'), mkInstance('i2', 'input-two')];
const isMergePrompt = (p: string) => p.startsWith('You are merging two');

describe('runGepa — winner selection over the whole pool', () => {
  test('the winner is the best mean in the POOL, even when it is not on the Pareto front', async () => {
    // The front is the union of per-instance bests, so a generalist that wins
    // no single instance is absent from it while still being the best overall
    // artifact. Reading the winner off the front would ship a specialist that
    // is worse on average — the exact failure the front exists to avoid on the
    // other side (it preserves specialists, it does not select them).
    const prompts: string[] = [];
    const script = ['SPEC_A', 'SPEC_B', 'GENERALIST', 'FINAL'];
    let call = 0;
    const result = await runGepa({
      seed: 'seed',
      evalSet: twoInstances,
      metric: specialistMetric,
      reflectionLm: async (p) => { prompts.push(p); return script[call++]!; },
      budget: { maxIterations: 4, maxMetricCalls: 100, minibatchSize: 1 },
      parentSelection: 'best-aggregate',
      random: seededRng(11),
    });

    expect(result.history.map((c) => c.source))
      .toEqual(['seed', 'SPEC_A', 'SPEC_B', 'GENERALIST', 'FINAL']);
    expect(result.winner.source).toBe('GENERALIST');
    expect(result.paretoFront.map((c) => c.source).sort()).toEqual(['SPEC_A', 'SPEC_B']);
  });

  test("parentSelection 'best-aggregate' reflects on the best mean, not on a sampled specialist", async () => {
    // GENERALIST wins no instance, so its parent-selection weight is 0 and the
    // weighted sampler can never return it. Only the best-aggregate path can.
    const prompts: string[] = [];
    const script = ['SPEC_A', 'SPEC_B', 'GENERALIST', 'FINAL'];
    let call = 0;
    await runGepa({
      seed: 'seed',
      evalSet: twoInstances,
      metric: specialistMetric,
      reflectionLm: async (p) => { prompts.push(p); return script[call++]!; },
      budget: { maxIterations: 4, maxMetricCalls: 100, minibatchSize: 1 },
      parentSelection: 'best-aggregate',
      random: seededRng(11),
    });
    // The 4th proposal's parent is chosen from {seed, SPEC_A, SPEC_B, GENERALIST}.
    expect(prompts[3]).toContain('GENERALIST');
    expect(prompts[3]).not.toContain('SPEC_A');
    expect(prompts[3]).not.toContain('SPEC_B');
  });
});

describe('runGepa — the Merge operator', () => {
  function mergeRun(budgetPatch: Partial<GepaBudget>) {
    const prompts: string[] = [];
    const script = ['SPEC_A', 'SPEC_B', 'FINAL', 'FINAL_2', 'FINAL_3'];
    let call = 0;
    return runGepa({
      seed: 'seed',
      evalSet: twoInstances,
      metric: specialistMetric,
      reflectionLm: async (p) => {
        prompts.push(p);
        return isMergePrompt(p) ? 'MERGED' : script[call++] ?? `MUT_${call}`;
      },
      budget: { maxIterations: 6, maxMetricCalls: 1000, minibatchSize: 1, ...budgetPatch },
      parentSelection: 'best-aggregate',
      random: seededRng(5),
    }).then((result) => ({ result, prompts, merges: prompts.filter(isMergePrompt) }));
  }

  test('merge fires on the cadence and stops at maxMergeInvocations', async () => {
    // Cadence 2 over 6 iterations offers iterations 2 and 4; the cap allows one.
    const { merges, prompts } = await mergeRun({ useMerge: true, mergeEveryN: 2, maxMergeInvocations: 1 });
    expect(merges).toHaveLength(1);
    expect(prompts.findIndex(isMergePrompt)).toBe(2);
  });

  test('a higher cap lets the later cadence slot merge too', async () => {
    const { merges } = await mergeRun({ useMerge: true, mergeEveryN: 2, maxMergeInvocations: 5 });
    expect(merges).toHaveLength(2);
  });

  test('useMerge off means the operator never runs', async () => {
    const { merges } = await mergeRun({ useMerge: false, mergeEveryN: 2, maxMergeInvocations: 5 });
    expect(merges).toHaveLength(0);
  });

  test('a merged candidate carries no single parent id', async () => {
    const { result } = await mergeRun({ useMerge: true, mergeEveryN: 2, maxMergeInvocations: 1 });
    const merged = result.history.find((c) => c.source === 'MERGED');
    expect(merged).toBeDefined();
    // Merge inherits two parents; the candidate type carries one id, so it
    // must stay null rather than pointing at whichever was sampled last.
    expect(merged!.parentId).toBeNull();
  });

  test('merge charges no rollout cost — only its eval-set scoring', async () => {
    const withMerge = await mergeRun({ useMerge: true, mergeEveryN: 2, maxMergeInvocations: 1 });
    const withoutMerge = await mergeRun({ useMerge: false, mergeEveryN: 2, maxMergeInvocations: 1 });
    // Same iteration count; the merge iteration skips the minibatch rollout.
    expect(withMerge.result.metricCallsUsed)
      .toBe(withoutMerge.result.metricCallsUsed - 1);
  });

  test('no complementary pair falls back to mutate instead of failing the iteration', async () => {
    // Every candidate scores identically, so no pair is ever complementary.
    // Turning that into a rejection would give up after 5 iterations and
    // return the seed, wasting the whole budget whenever merge is enabled.
    let call = 0;
    const log = rejectionLog();
    const result = await runGepa({
      seed: 'seed',
      evalSet: twoInstances,
      metric: async () => ({ score: 0.5, feedback: 'fb' }),
      reflectionLm: async () => `MUT_${++call}`,
      budget: {
        maxIterations: 4, maxMetricCalls: 1000, minibatchSize: 1,
        useMerge: true, mergeEveryN: 1, maxMergeInvocations: 10,
      },
      onIteration: log.onIteration,
      random: seededRng(5),
    });
    expect(log.reasons).toEqual([]);
    expect(result.history.length).toBe(5);
    expect(result.stopReason).toBe('iterations_exhausted');
  });
});
