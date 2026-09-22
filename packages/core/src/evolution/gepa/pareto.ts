/** Per-instance Pareto front and parent weighting: preserves specialists that alone solve rare hard instances. */

import type { GepaCandidate } from './types';

export interface ParetoComputation {
  /** Not strictly dominated. */
  front: GepaCandidate[];
  perInstanceBest: Map<string, GepaCandidate[]>;
}

/** Strictly dominated = another candidate is ≥ on every instance and > on at least one. */
export function computeParetoFront(
  pool: ReadonlyArray<GepaCandidate>,
  instanceIds: ReadonlyArray<string>,
): ParetoComputation {
  if (pool.length === 0) {
    return { front: [], perInstanceBest: new Map() };
  }

  const perInstanceBest = new Map<string, GepaCandidate[]>();

  for (const id of instanceIds) {
    let maxScore = -Infinity;
    let bests: GepaCandidate[] = [];

    for (const cand of pool) {
      const s = cand.scores.get(id) ?? 0;

      if (s > maxScore) { maxScore = s; bests = [cand]; }
      else if (s === maxScore) bests.push(cand);
    }

    perInstanceBest.set(id, bests);
  }

  const candidatesOnFront = new Set<GepaCandidate>();

  for (const bests of perInstanceBest.values()) {
    for (const c of bests) candidatesOnFront.add(c);
  }

  const arr = Array.from(candidatesOnFront);
  const dominated = new Set<GepaCandidate>();

  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];

    if (dominated.has(a)) continue;

    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const b = arr[j];

      if (dominated.has(b)) continue;

      if (strictlyDominates(b, a, instanceIds)) { dominated.add(a); break; }
    }
  }

  const front = arr.filter((c) => !dominated.has(c));

  return { front, perInstanceBest };
}

function strictlyDominates(
  a: GepaCandidate,
  b: GepaCandidate,
  instanceIds: ReadonlyArray<string>,
): boolean {
  let strictlyGreaterSomewhere = false;

  for (const id of instanceIds) {
    const av = a.scores.get(id) ?? 0;
    const bv = b.scores.get(id) ?? 0;

    if (av < bv) return false;

    if (av > bv) strictlyGreaterSomewhere = true;
  }

  return strictlyGreaterSomewhere;
}

/** Weight = number of instances on which the candidate is tied-best; off-front candidates get 0. */
export function parentSelectionWeights(
  pool: ReadonlyArray<GepaCandidate>,
  instanceIds: ReadonlyArray<string>,
): Map<GepaCandidate, number> {
  const { perInstanceBest } = computeParetoFront(pool, instanceIds);
  const weights = new Map<GepaCandidate, number>();

  for (const cand of pool) weights.set(cand, 0);

  for (const bests of perInstanceBest.values()) {
    for (const c of bests) {
      weights.set(c, (weights.get(c) ?? 0) + 1);
    }
  }

  return weights;
}

/** Falls back to best-aggregate when all weights are zero. */
export function sampleParentByWeight(
  pool: ReadonlyArray<GepaCandidate>,
  instanceIds: ReadonlyArray<string>,
  random: () => number,
): GepaCandidate {
  if (pool.length === 0) throw new Error('sampleParentByWeight: empty pool');

  if (pool.length === 1) return pool[0];
  const weights = parentSelectionWeights(pool, instanceIds);
  let total = 0;

  for (const w of weights.values()) total += w;

  if (total === 0) {
    return bestAggregate(pool);
  }

  let r = random() * total;

  for (const [cand, w] of weights) {
    r -= w;

    if (r <= 0) return cand;
  }

  return bestAggregate(pool);
}

/** Ties broken by createdAt (older wins). */
export function bestAggregate(pool: ReadonlyArray<GepaCandidate>): GepaCandidate {
  if (pool.length === 0) throw new Error('bestAggregate: empty pool');
  let best = pool[0];

  for (const c of pool) {
    if (c.aggregateScore > best.aggregateScore) best = c;
    else if (c.aggregateScore === best.aggregateScore && c.createdAt < best.createdAt) best = c;
  }

  return best;
}
