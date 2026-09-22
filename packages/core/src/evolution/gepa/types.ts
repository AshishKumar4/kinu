/**
 * GEPA type contracts (Agrawal et al., ICLR 2026, arXiv:2507.19457).
 * Candidates carry per-instance score vectors so Pareto dominance is computable;
 * the metric's feedback text drives reflective mutation.
 */

import * as v from 'valibot';

export const MetricScoreSchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));

export const MetricOutcomeSchema = v.object({ score: MetricScoreSchema, feedback: v.string() });

export interface EvalInstance<I = unknown, E = unknown> {
  /** Pareto bookkeeping keys on this. */
  id: string;
  input: I;
  /** Non-scoring context shown to the reflection LM. */
  evidence?: string;
  expected?: E;
}

/** A failed measurement rejects the metric promise; never a neutral numeric score. */
export interface MetricOutcome {
  /** 0..1; higher is better. */
  score: number;
  /** Without it GEPA degrades to random search. */
  feedback: string;
}

/** Should be deterministic so Pareto bookkeeping is stable. */
export type GepaMetric<I = unknown, E = unknown> =
  (candidate: string, instance: EvalInstance<I, E>) => Promise<MetricOutcome>;

/** Receives the rendered reflection prompt; returns a new candidate source string. */
export type ReflectionLM = (prompt: string) => Promise<string>;

export interface GepaCandidate {
  id: string;
  parentId: string | null;
  source: string;
  /** Keyed by `EvalInstance.id`. */
  scores: Map<string, number>;
  feedback: Map<string, string>;
  /** Mean of per-instance scores. */
  aggregateScore: number;
  createdAt: number;
}

export interface GepaConstraints {
  maxSizeBytes?: number;
  requiredPattern?: RegExp;
  forbiddenPatterns?: RegExp[];
  /** Null accepts; a string is the rejection reason. */
  customCheck?: (source: string) => string | null;
}

export interface GepaBudget {
  /** Default 20. */
  maxIterations: number;
  /** Cap on metric calls across the run; stops with `maxIterations`, whichever hits first. Default 200. */
  maxMetricCalls: number;
  /** Instances the reflection LM sees per proposal. */
  minibatchSize: number;
  /** Every `mergeEveryN`th iteration attempts a Merge instead of a reflective mutation. Default true. */
  useMerge: boolean;
  /** Default 4. */
  mergeEveryN: number;
  /** Default 5. */
  maxMergeInvocations: number;
}

export const DEFAULT_GEPA_BUDGET: GepaBudget = {
  maxIterations: 20,
  maxMetricCalls: 200,
  minibatchSize: 3,
  useMerge: true,
  mergeEveryN: 4,
  maxMergeInvocations: 5,
};

export interface GepaProgressHooks {
  /** Fires once a candidate (including the seed, iteration 0) has a full validated score vector.
     *  Awaited; a retention failure propagates to the run owner. */
  onCandidate?: (state: { candidate: GepaCandidate; iteration: number }) => void | Promise<void>;
  /** Fires after every iteration, including a rejected proposal. */
  onIteration?: (state: GepaIterationState) => void | Promise<void>;
}

export interface GepaConfig<I = unknown, E = unknown> extends GepaProgressHooks {
  seed: string;
  /** Empty array is rejected. */
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  /** Reflection minibatches are sampled from here; pass one disjoint from `evalSet`.
     *  Omitted or empty = the eval set doubles as train set (in-sample selection). */
  trainSet?: ReadonlyArray<EvalInstance<I, E>>;
  metric: GepaMetric<I, E>;
  reflectionLm: ReflectionLM;
  budget?: Partial<GepaBudget>;
  constraints?: GepaConstraints;
  /** 'pareto' samples weighted by per-instance dominance count; 'best-aggregate' is greedy. Default 'pareto'. */
  parentSelection?: 'pareto' | 'best-aggregate';
  random?: () => number;
}

export interface GepaIterationState {
  iteration: number;
  pool: ReadonlyArray<GepaCandidate>;
  paretoFront: ReadonlyArray<GepaCandidate>;
  bestSoFar: GepaCandidate;
  metricCallsUsed: number;
  accepted: boolean;
  rejectionReason?: string;
}

export interface GepaResult {
  /** Highest aggregate score. */
  winner: GepaCandidate;
  paretoFront: GepaCandidate[];
  /** Oldest first. */
  history: GepaCandidate[];
  metricCallsUsed: number;
  iterationsRun: number;
  stopReason: 'iterations_exhausted' | 'metric_budget_exhausted' | 'no_improvement_possible';
}
