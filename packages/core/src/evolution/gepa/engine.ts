/**
 * GEPA main loop — `runGepa(config)`.
 *
 * Algorithm (matches Agrawal et al., now including the Appendix-F Merge
 * operator):
 *
 *   1. Score the seed candidate on the full eval set. Add to pool.
 *   2. Loop until budget exhausted:
 *      a. If `useMerge` AND iteration is on the merge cadence AND we have a
 *         complementary pair → propose via Merge.
 *         Else → propose via reflective Mutate (parent + minibatch rollout).
 *      b. Run constraints (size cap, regex, custom check, optional test runner).
 *         If rejected, log and skip — DO NOT consume eval-set scoring budget.
 *      c. Score the candidate on the full eval set; aggregate.
 *      d. Add to pool.
 *      e. Emit iteration state via onIteration.
 *   3. Return winner (highest aggregate) + Pareto front + history + stop reason.
 *
 * Cost accounting: every metric call (whether rollout, scoring, or eval-set
 * scoring) is counted against `budget.maxMetricCalls`. The loop terminates
 * when either iterations OR metric calls are exhausted, whichever first.
 */

import { nanoid } from '../../utils/nanoid';
import { nowMs } from '../../utils/date';
import {
  computeParetoFront, sampleParentByWeight, bestAggregate,
} from './pareto';
import { proposeMutation } from './mutate';
import { findComplementaryPair, proposeMerge } from './merge';
import {
  DEFAULT_GEPA_BUDGET,
  type EvalInstance, type GepaCandidate, type GepaConfig, type GepaConstraints,
  type GepaResult, type GepaIterationState, type GepaMetric,
} from './types';
import { diagnostics, renderThrownChain, toKinuError } from '../../obs/index';

type ProposalOutcome =
  | { ok: true; source: string; operator: 'mutate' | 'merge'; metricCallsCharged: number; parentSource?: string }
  | { ok: false; reason: string };


export async function runGepa<I = unknown, E = unknown>(
  config: GepaConfig<I, E>,
): Promise<GepaResult> {
  if (config.evalSet.length === 0) {
    throw new Error('runGepa: evalSet must be non-empty');
  }
  const budget = { ...DEFAULT_GEPA_BUDGET, ...config.budget };
  // Reflection minibatches come from the train set (upstream GEPA's trainset
  // discipline); scoring/Pareto always runs on the full evalSet. The two are
  // disjoint when the caller supplies a real train set, so the minibatch is
  // bounded by the set it actually samples from — not by the eval set.
  const trainSet = config.trainSet && config.trainSet.length > 0 ? config.trainSet : config.evalSet;
  if (budget.minibatchSize <= 0) {
    throw new Error(`runGepa: minibatchSize must be positive; got ${budget.minibatchSize}`);
  }
  // Over-asking is benign and normal — the train set is however many labeled
  // failures the ledger happens to hold — so it caps rather than throws.
  const minibatchSize = Math.min(budget.minibatchSize, trainSet.length);
  const random = config.random ?? Math.random;
  const instanceIds = config.evalSet.map(i => i.id);

  let metricCallsUsed = 0;
  const charge = (n: number) => { metricCallsUsed += n; };
  const budgetLeft = () => budget.maxMetricCalls - metricCallsUsed;

  // 1. Score the seed.
  const seed = await scoreCandidate({
    source: config.seed, parentId: null, evalSet: config.evalSet, metric: config.metric,
  });
  charge(config.evalSet.length);
  const pool: GepaCandidate[] = [seed];
  const history: GepaCandidate[] = [seed];

  let stopReason: GepaResult['stopReason'] = 'iterations_exhausted';
  let mergeInvocations = 0;
  const REJECTION_GIVE_UP = 5;

  // ── helpers (closed over loop state) ──

  /** Propose a candidate via the reflective Mutate operator. */
  async function proposeViaMutate(): Promise<ProposalOutcome> {
    const parent =
      config.parentSelection === 'best-aggregate'
        ? bestAggregate(pool)
        : sampleParentByWeight(pool, instanceIds, random);
    const minibatch = sampleWithoutReplacement(trainSet, minibatchSize, random);
    try {
      const m = await proposeMutation(
        { parent, minibatch, metric: config.metric, reflectionLm: config.reflectionLm },
        'scaffold source',
      );
      return {
        ok: true, source: m.source, operator: 'mutate',
        metricCallsCharged: minibatch.length,
        parentSource: parent.source,
      };
    } catch (err) {
      return { ok: false, reason: `mutate_failed: ${renderThrownChain({ cause: err })}` };
    }
  }

  /** Propose a candidate via Merge. Returns mutate fallback when no pair. */
  async function proposeViaMerge(): Promise<ProposalOutcome> {
    const pair = findComplementaryPair(pool, instanceIds, random);
    if (!pair) return proposeViaMutate(); // no complementary pair → fallback
    try {
      const merged = await proposeMerge({
        pair, evalSet: config.evalSet, reflectionLm: config.reflectionLm,
        artifactDescription: 'scaffold source',
      });
      mergeInvocations++;
      // Merge has no rollout cost; only the eval-set scoring will charge.
      return {
        ok: true, source: merged, operator: 'merge',
        metricCallsCharged: 0,
      };
    } catch (err) {
      return { ok: false, reason: `merge_failed: ${renderThrownChain({ cause: err })}` };
    }
  }

  // Emit a rejection, bump the consecutive-rejection counter, and report
  // whether GEPA should give up (K consecutive rejections). Every rejection
  // path goes through this so the give-up logic is uniform — previously the
  // testRunner paths silently skipped the give-up check.
  let consecutiveRejections = 0;
  async function recordRejection(iter: number, reason: string): Promise<boolean> {
    await emitIteration(config.onIteration, {
      iteration: iter, pool, paretoFront: computeParetoFront(pool, instanceIds).front,
      bestSoFar: bestAggregate(pool), metricCallsUsed, accepted: false,
      rejectionReason: reason,
    });
    return ++consecutiveRejections >= REJECTION_GIVE_UP;
  }

  // ── main loop ──

  for (let iter = 0; iter < budget.maxIterations; iter++) {
    // Worst-case cost of this iteration: minibatchSize (rollout) + evalSet (score).
    // Merge costs 0 for rollout, so worst-case still applies for Mutate.
    if (budgetLeft() < minibatchSize + config.evalSet.length) {
      stopReason = 'metric_budget_exhausted';
      break;
    }

    // Pick operator.
    const tryMerge =
      budget.useMerge &&
      mergeInvocations < budget.maxMergeInvocations &&
      iter > 0 &&
      iter % budget.mergeEveryN === 0;
    const proposal = tryMerge ? await proposeViaMerge() : await proposeViaMutate();

    if (!proposal.ok) {
      if (await recordRejection(iter, proposal.reason)) { stopReason = 'no_improvement_possible'; break; }
      continue;
    }
    charge(proposal.metricCallsCharged);

    // No-change check: a proposal identical to its parent wastes eval-set scoring.
    if (proposal.operator === 'mutate' && proposal.source === proposal.parentSource) {
      if (await recordRejection(iter, 'no_change')) { stopReason = 'no_improvement_possible'; break; }
      continue;
    }
    if (pool.some(p => p.source === proposal.source)) {
      if (await recordRejection(iter, 'duplicate_in_pool')) { stopReason = 'no_improvement_possible'; break; }
      continue;
    }

    // Constraints.
    const constraintError = checkConstraints(proposal.source, config.constraints);
    if (constraintError) {
      if (await recordRejection(iter, `constraint: ${constraintError}`)) { stopReason = 'no_improvement_possible'; break; }
      continue;
    }
    if (config.constraints?.testRunner) {
      let testPassed: boolean;
      try {
        testPassed = await config.constraints.testRunner(proposal.source);
      } catch (err) {
        if (await recordRejection(iter, `test_runner_threw: ${renderThrownChain({ cause: err })}`)) { stopReason = 'no_improvement_possible'; break; }
        continue;
      }
      if (!testPassed) {
        if (await recordRejection(iter, 'test_runner_rejected')) { stopReason = 'no_improvement_possible'; break; }
        continue;
      }
    }

    // Score on the full eval set.
    const cand = await scoreCandidate({
      source: proposal.source,
      // Parent id is meaningful only for mutate; merge inherits both parents
      // but the type carries one id so leave null.
      parentId: proposal.operator === 'mutate' ? findCandidateBySource(pool, proposal.parentSource ?? '')?.id ?? null : null,
      evalSet: config.evalSet, metric: config.metric,
    });
    charge(config.evalSet.length);

    // Add to pool + history.
    pool.push(cand);
    history.push(cand);
    consecutiveRejections = 0;

    // Emit.
    await emitIteration(config.onIteration, {
      iteration: iter,
      pool,
      paretoFront: computeParetoFront(pool, instanceIds).front,
      bestSoFar: bestAggregate(pool),
      metricCallsUsed,
      accepted: true,
    });
  }

  const front = computeParetoFront(pool, instanceIds).front;
  return {
    winner: bestAggregate(pool),
    paretoFront: front,
    history,
    metricCallsUsed,
    iterationsRun: history.length - 1, // history includes seed
    stopReason,
  };
}

// ── helpers ──────────────────────────────────────────────────────

async function scoreCandidate<I, E>(args: {
  source: string;
  parentId: string | null;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  metric: GepaMetric<I, E>;
}): Promise<GepaCandidate> {
  const scores = new Map<string, number>();
  const feedback = new Map<string, string>();
  let total = 0;
  for (const inst of args.evalSet) {
    const o = await args.metric(args.source, inst);
    scores.set(inst.id, o.score);
    feedback.set(inst.id, o.feedback);
    total += o.score;
  }
  const aggregateScore = args.evalSet.length === 0 ? 0 : total / args.evalSet.length;
  return {
    id: nanoid(),
    parentId: args.parentId,
    source: args.source,
    scores,
    feedback,
    aggregateScore,
    createdAt: nowMs(),
  };
}

function checkConstraints(source: string, c?: GepaConstraints): string | null {
  if (!c) return null;
  if (c.maxSizeBytes && source.length > c.maxSizeBytes) {
    return `source exceeds ${c.maxSizeBytes} bytes (${source.length})`;
  }
  if (c.requiredPattern && !c.requiredPattern.test(source)) {
    return `source does not match required pattern ${c.requiredPattern.source}`;
  }
  if (c.forbiddenPatterns) {
    for (const p of c.forbiddenPatterns) {
      if (p.test(source)) return `source matches forbidden pattern ${p.source}`;
    }
  }
  if (c.customCheck) {
    const err = c.customCheck(source);
    if (err) return err;
  }
  return null;
}

function sampleWithoutReplacement<T>(
  arr: ReadonlyArray<T>, k: number, random: () => number,
): T[] {
  if (k >= arr.length) return [...arr];
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).map(i => arr[i]);
}

function findCandidateBySource(
  pool: ReadonlyArray<GepaCandidate>, source: string,
): GepaCandidate | undefined {
  return pool.find(c => c.source === source);
}

async function emitIteration(
  hook: GepaConfig['onIteration'],
  state: GepaIterationState,
): Promise<void> {
  if (!hook) return;
  try { await hook(state); } catch (err) {
    diagnostics.failure(
      'gepa.iteration_hook_failed',
      toKinuError({ doing: 'run the GEPA onIteration hook', cause: err, otherwise: 'io' }),
      { iteration: state.iteration },
    );
  }
}
