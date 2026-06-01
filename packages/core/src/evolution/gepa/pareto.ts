/**
 * Pareto frontier maintenance — the load-bearing data structure of GEPA.
 *
 * Two operations:
 *   1. `computeParetoFront(pool, instanceIds)` — for each instance, find
 *      candidates achieving the per-instance MAX; the union (with strictly-
 *      dominated candidates pruned) is the front.
 *   2. `parentSelectionWeights(pool, instanceIds)` — weight each candidate
 *      by the number of instances on which it's the per-instance best.
 *      `sampleParentByWeight` samples proportionally.
 *
 * Why this matters: greedy "pick the highest-mean candidate" silently kills
 * any specialist that's the ONLY thing that handles a rare hard instance.
 * Pareto-by-instance preserves those specialists — they stay in the pool
 * even when their mean is mediocre.
 */

import type { GepaCandidate } from './types.js';

/** Result of a Pareto computation. */
export interface ParetoComputation {
  /** Candidates on the frontier (not strictly dominated). */
  front: GepaCandidate[];
  /** Per-instance, the candidates achieving the instance's max score. */
  perInstanceBest: Map<string, GepaCandidate[]>;
}

/** Find the Pareto frontier of a candidate pool over a set of evaluation
 *  instances. A candidate is **strictly dominated** when another candidate
 *  matches or exceeds its score on every instance AND strictly exceeds it
 *  on at least one. Such candidates are excluded from the front. */
export function computeParetoFront(
  pool: ReadonlyArray<GepaCandidate>,
  instanceIds: ReadonlyArray<string>,
): ParetoComputation {
  if (pool.length === 0) {
    return { front: [], perInstanceBest: new Map() };
  }
  // For each instance, find the max score and the candidates achieving it.
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

  // Pareto front = candidates appearing in any per-instance best set,
  // pruning those strictly dominated by another front member.
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

/** True iff `a` scores ≥ `b` on every instance and strictly > on at least one. */
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

/** Per-candidate weights for parent selection. A candidate's weight is the
 *  number of instances on which it's tied-best (its presence count in
 *  `perInstanceBest`). Candidates not on the front get weight 0. */
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

/** Sample a candidate proportional to its Pareto weight. Falls back to the
 *  highest-aggregate candidate when all weights are zero (fresh pool with
 *  one seed). */
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
    // No Pareto signal yet — fall back to best-aggregate (greedy).
    return bestAggregate(pool);
  }
  let r = random() * total;
  for (const [cand, w] of weights) {
    r -= w;
    if (r <= 0) return cand;
  }
  return bestAggregate(pool);
}

/** Highest-aggregate-score candidate. Ties broken by createdAt (older wins). */
export function bestAggregate(pool: ReadonlyArray<GepaCandidate>): GepaCandidate {
  if (pool.length === 0) throw new Error('bestAggregate: empty pool');
  let best = pool[0];
  for (const c of pool) {
    if (c.aggregateScore > best.aggregateScore) best = c;
    else if (c.aggregateScore === best.aggregateScore && c.createdAt < best.createdAt) best = c;
  }
  return best;
}
