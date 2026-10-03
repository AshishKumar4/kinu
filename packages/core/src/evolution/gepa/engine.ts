/**
 * GEPA main loop (Agrawal et al., including the Appendix-F Merge operator).
 * Constraints run before scoring so a rejected candidate costs no eval-set calls.
 * Every metric call counts against `budget.maxMetricCalls`.
 */

import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { nanoid } from '../../utils/nanoid';
import { nowMs } from '../../utils/date';
import {
  computeParetoFront, sampleParentByWeight, bestAggregate,
} from './pareto';
import { proposeMutation, rolloutMinibatch } from './mutate';
import { findComplementaryPair, proposeMerge } from './merge';
import {
  DEFAULT_GEPA_BUDGET, MetricOutcomeSchema,
  type EvalInstance, type GepaCandidate, type GepaConfig, type GepaConstraints,
  type GepaResult, type GepaIterationState, type GepaMetric,
} from './types';
import { diagnostics, renderThrownChain, settle, toKinuError } from '../../obs/index';

interface Proposed { source: string; operator: 'mutate' | 'merge'; parentSource?: string }

type ProposalOutcome = Result.Result<Proposed, string>;


export function runGepa<I = unknown, E = unknown>(
  config: GepaConfig<I, E>,
): Promise<GepaResult> {
  return settle(Effect.gen(function* () {
    if (config.evalSet.length === 0) {
      return yield* Effect.die(new Error('runGepa: evalSet must be non-empty'));
    }

    const budget = { ...DEFAULT_GEPA_BUDGET, ...config.budget };
    // Minibatches come from the train set; scoring and Pareto always run on the full evalSet.
    const trainSet = config.trainSet && config.trainSet.length > 0 ? config.trainSet : config.evalSet;

    if (budget.minibatchSize <= 0) {
      return yield* Effect.die(new Error(`runGepa: minibatchSize must be positive; got ${budget.minibatchSize}`));
    }

    // The train set is however many failures the ledger holds, so over-asking caps rather than throws.
    const minibatchSize = Math.min(budget.minibatchSize, trainSet.length);
    const random = config.random ?? Math.random;
    const instanceIds = config.evalSet.map(i => i.id);

    let metricCallsUsed = 0;
    const charge = (n: number) => { metricCallsUsed += n; };

    const budgetLeft = () => budget.maxMetricCalls - metricCallsUsed;

    const seed = yield* Effect.promise(() => scoreCandidate({
      source: config.seed, parentId: null, evalSet: config.evalSet, metric: config.metric,
    }));

    charge(config.evalSet.length);
    yield* Effect.promise(() => Promise.resolve(config.onCandidate?.({ candidate: seed, iteration: 0 })));
    const pool: GepaCandidate[] = [seed];
    const history: GepaCandidate[] = [seed];

    let stopReason: GepaResult['stopReason'] = 'iterations_exhausted';
    let mergeInvocations = 0;
    const REJECTION_GIVE_UP = 5;

    const proposeViaMutate = (): Effect.Effect<ProposalOutcome> => Effect.gen(function* () {
      const parent =
        config.parentSelection === 'best-aggregate'
          ? bestAggregate(pool)
          : sampleParentByWeight(pool, instanceIds, random);

      const minibatch = sampleWithoutReplacement(trainSet, minibatchSize, random);
      // Measurement failures invalidate the run; only proposal-generation failures are recoverable rejections.
      const rollout = yield* Effect.promise(() => rolloutMinibatch(parent.source, minibatch, config.metric));
      charge(rollout.metricCalls);

      return yield* proposal(() => proposeMutation(
        { parent, minibatch, rollout, reflectionLm: config.reflectionLm },
        config.artifactDescription ?? 'scaffold source',
      ), (m): Proposed => ({ source: m.source, operator: 'mutate', parentSource: parent.source }), 'mutate_failed');
    });

    /** Falls back to mutate when there is no complementary pair. */
    const proposeViaMerge = (): Effect.Effect<ProposalOutcome> => {
      const pair = findComplementaryPair(pool, instanceIds, random);

      if (!pair) return proposeViaMutate();

      return proposal(() => proposeMerge({
        pair, evalSet: config.evalSet, reflectionLm: config.reflectionLm,
        artifactDescription: config.artifactDescription ?? 'scaffold source',
      }), (merged): Proposed => {
        mergeInvocations++;

        // Merge has no rollout cost.
        return { source: merged, operator: 'merge' };
      }, 'merge_failed');
    };

    // Every rejection path goes through this so the give-up logic is uniform.
    let consecutiveRejections = 0;

    const recordRejection = (iter: number, reason: string): Effect.Effect<boolean> => Effect.map(emitIteration(config.onIteration, {
      iteration: iter, pool, paretoFront: computeParetoFront(pool, instanceIds).front,
      bestSoFar: bestAggregate(pool), metricCallsUsed, accepted: false,
      rejectionReason: reason,
    }), () => ++consecutiveRejections >= REJECTION_GIVE_UP);

    let iterationsRun = 0;

    for (let iter = 0; iter < budget.maxIterations; iter++) {
      // Worst case: minibatchSize (rollout) + evalSet (score).
      if (budgetLeft() < minibatchSize + config.evalSet.length) {
        stopReason = 'metric_budget_exhausted';
        break;
      }

      iterationsRun++;

      const tryMerge =
        budget.useMerge &&
        mergeInvocations < budget.maxMergeInvocations &&
        iter > 0 &&
        iter % budget.mergeEveryN === 0;

      const outcome = yield* (tryMerge ? proposeViaMerge() : proposeViaMutate());

      if (Result.isFailure(outcome)) {
        if (yield* recordRejection(iter, outcome.failure)) { stopReason = 'no_improvement_possible'; break; }

        continue;
      }

      const proposed = outcome.success;

      if (proposed.operator === 'mutate' && proposed.source === proposed.parentSource) {
        if (yield* recordRejection(iter, 'no_change')) { stopReason = 'no_improvement_possible'; break; }

        continue;
      }

      if (pool.some(p => p.source === proposed.source)) {
        if (yield* recordRejection(iter, 'duplicate_in_pool')) { stopReason = 'no_improvement_possible'; break; }

        continue;
      }

      const constraintError = checkConstraints(proposed.source, config.constraints);

      if (constraintError) {
        if (yield* recordRejection(iter, `constraint: ${constraintError}`)) { stopReason = 'no_improvement_possible'; break; }

        continue;
      }

      const cand = yield* Effect.promise(() => scoreCandidate({
        source: proposed.source,
        // Merge has two parents but the type carries one id.
        parentId: proposed.operator === 'mutate' ? findCandidateBySource(pool, proposed.parentSource ?? '')?.id ?? null : null,
        evalSet: config.evalSet, metric: config.metric,
      }));

      charge(config.evalSet.length);
      yield* Effect.promise(() => Promise.resolve(config.onCandidate?.({ candidate: cand, iteration: iter + 1 })));

      pool.push(cand);
      history.push(cand);
      consecutiveRejections = 0;

      yield* emitIteration(config.onIteration, {
        iteration: iter,
        pool,
        paretoFront: computeParetoFront(pool, instanceIds).front,
        bestSoFar: bestAggregate(pool),
        metricCallsUsed,
        accepted: true,
      });
    }

    const front = computeParetoFront(pool, instanceIds).front;

    const result: GepaResult = {
      winner: bestAggregate(pool),
      paretoFront: front,
      history,
      metricCallsUsed,
      iterationsRun,
      stopReason,
    };

    return result;
  }));
}

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
    const o = v.parse(MetricOutcomeSchema, await args.metric(args.source, inst));
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

function emitIteration(
  hook: GepaConfig['onIteration'],
  state: GepaIterationState,
): Effect.Effect<void> {
  if (!hook) return Effect.void;

  return Effect.tryPromise({
    try: () => Promise.resolve(hook(state)),
    catch: (cause) => toKinuError({ doing: 'run the GEPA onIteration hook', cause, otherwise: 'io' }),
  }).pipe(Effect.catch((failure) => Effect.sync(() => {
    diagnostics.failure('gepa.iteration_hook_failed', failure, { iteration: state.iteration });
  })));
}

function proposal<A>(run: () => Promise<A>, accepted: (value: A) => Proposed, label: string): Effect.Effect<ProposalOutcome> {
  return Effect.tryPromise({ try: run, catch: (cause) => ({ cause }) }).pipe(Effect.match({
    onSuccess: (value): ProposalOutcome => Result.succeed(accepted(value)),
    onFailure: (failed): ProposalOutcome => Result.fail(`${label}: ${renderThrownChain(failed)}`),
  }));
}
