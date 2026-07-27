/**
 * GEPA (Genetic-Pareto Prompt Evolution) — type contracts.
 *
 * Paper: Agrawal et al., ICLR 2026. https://arxiv.org/abs/2507.19457
 * Brief in repo: docs/COMPETITIVE-ANALYSIS-2026-05-29.md §3 (and the GEPA
 * brief subagent transcript).
 *
 * GEPA targets any string-addressable artifact: a scaffold source file, a
 * crafted-tool implementation, a system-prompt section, even a SKILL.md
 * body. Proteus's first integration target is the SCAFFOLD because that's
 * the highest-leverage thing the agent owns + the audit-confirmed weakest
 * link in the existing evolution stack.
 *
 * Design choices Proteus makes (deviating slightly from DSPy.GEPA):
 *   - The metric returns both `{score, feedback}` per instance — the
 *     feedback text is what drives the reflective mutation (DSPy calls
 *     this `μ_f`).
 *   - Candidates carry per-instance score *vectors*, not just averages,
 *     so Pareto dominance is computable.
 *   - Mutation is one-shot LLM rewrite (no string-level crossover). The
 *     paper's module-level Merge operator IS implemented (see merge.ts +
 *     `budget.useMerge` / `mergeEveryN` / `maxMergeInvocations`).
 *   - Cost gating is explicit via `budget.maxIterations` AND
 *     `budget.maxMetricCalls` — both stop conditions, whichever hits first.
 */

/** A single evaluation instance — what the metric is scored against. */
export interface EvalInstance<I = unknown, E = unknown> {
  /** Stable identifier — Pareto bookkeeping keys on this. */
  id: string;
  /** Task input the candidate is executed against. */
  input: I;
  /** Optional non-scoring context shown to the reflection LM. */
  evidence?: string;
  /** Optional ground-truth or expected-shape hint the metric may consult. */
  expected?: E;
}

/** Per-instance evaluation outcome — what the metric returns. */
export interface MetricOutcome {
  /** 0..1 numeric score; higher is better. */
  score: number;
  /** Free-text diagnostic the reflection LM reads. The single most important
   *  field — without it, GEPA degrades to random search. */
  feedback: string;
}

/** The metric callback. Runs `candidate` against `instance` and returns the
 *  numeric score + text feedback. Should be deterministic given the inputs
 *  so Pareto bookkeeping is stable. */
export type GepaMetric<I = unknown, E = unknown> =
  (candidate: string, instance: EvalInstance<I, E>) => Promise<MetricOutcome>;

/** The reflection LM callback. Receives the rendered reflection prompt;
 *  must return a new candidate source string. */
export type ReflectionLM = (prompt: string) => Promise<string>;

/** A single candidate in the GEPA population. */
export interface GepaCandidate {
  /** Stable id — nanoid; used as parent pointer. */
  id: string;
  /** Parent candidate id (null for the seed). */
  parentId: string | null;
  /** The candidate's source-string artifact. */
  source: string;
  /** Per-instance scores. Map keys are `EvalInstance.id`. */
  scores: Map<string, number>;
  /** Per-instance feedback collected at score time. */
  feedback: Map<string, string>;
  /** Aggregate score: mean of per-instance scores, for sorting / summary. */
  aggregateScore: number;
  /** Wall-clock the candidate was created. */
  createdAt: number;
}

/** Constraints that gate whether a freshly-mutated candidate enters the pool. */
export interface GepaConstraints {
  /** Reject candidates whose source exceeds this many bytes. */
  maxSizeBytes?: number;
  /** Reject candidates that do not match this regex (e.g., required signature). */
  requiredPattern?: RegExp;
  /** Reject candidates whose source matches ANY of these patterns. */
  forbiddenPatterns?: RegExp[];
  /** Custom synchronous check — return null on accept, error string on reject. */
  customCheck?: (source: string) => string | null;
  /**
   * Optional async test runner — last gate. Receives the candidate source;
   * returns true to accept, false to reject. Runs ONLY after the cheaper
   * checks pass. Use it to spawn the candidate in a sandbox and run a unit
   * test suite (Hermes pattern).
   */
  testRunner?: (source: string) => Promise<boolean>;
}

/** Budget and pacing knobs for runGepa. */
export interface GepaBudget {
  /** Hard cap on iterations. Default 20. */
  maxIterations: number;
  /** Hard cap on metric calls across the whole run (each candidate costs
   *  evalSet.length scoring calls + minibatchSize reflection rollouts).
   *  Stops whichever hits first. Default 200. */
  maxMetricCalls: number;
  /** Minibatch size for reflection — number of instances the reflection LM
   *  sees per mutation proposal. Paper uses 3. */
  minibatchSize: number;
  /** Enable the Merge operator (Appendix F). When true, every Nth iteration
   *  attempts a merge between two complementary candidates instead of a
   *  reflective mutation. Default true. */
  useMerge: boolean;
  /** How often to attempt Merge (in iterations between attempts). The paper
   *  caps at 5 invocations per run; we expose it as a cadence knob. Default 4. */
  mergeEveryN: number;
  /** Hard cap on Merge invocations across the whole run. Default 5
   *  (matches the paper). */
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

/** Configuration handed to `runGepa`. */
export interface GepaConfig<I = unknown, E = unknown> {
  /** Initial candidate to evolve from. Required. */
  seed: string;
  /** Held-out eval set. Required. Empty array is rejected. */
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  /** Upstream GEPA's trainset: the instances reflection minibatches are
   *  sampled from. Pass the outcome-labeled NEGATIVE set (corrected/
   *  frustrated turns) so mutation proposals focus on what must be fixed
   *  while `evalSet` scoring guards regressions — and pass one DISJOINT from
   *  `evalSet`, or the winner is selected on instances it was optimised
   *  against. Omitted (or empty) means exactly that in-sample selection: the
   *  eval set doubles as the train set. */
  trainSet?: ReadonlyArray<EvalInstance<I, E>>;
  /** Per-instance scorer. */
  metric: GepaMetric<I, E>;
  /** Reflection LM — receives a prompt, returns a new candidate string. */
  reflectionLm: ReflectionLM;
  budget?: Partial<GepaBudget>;
  constraints?: GepaConstraints;
  /**
   * Strategy for picking the parent candidate at each iteration:
   *   - 'pareto'        — sample weighted by per-instance dominance count
   *                       (the paper's recommended strategy)
   *   - 'best-aggregate' — always pick the highest-mean candidate (greedy)
   * Default 'pareto'.
   */
  parentSelection?: 'pareto' | 'best-aggregate';
  /** Deterministic RNG for tests. Default Math.random. */
  random?: () => number;
  /** Optional callback fired after each iteration. Used by the orchestrator
   *  to stream progress / persist intermediate state. */
  onIteration?: (state: GepaIterationState) => void | Promise<void>;
}

/** State snapshot fired to onIteration. */
export interface GepaIterationState {
  iteration: number;
  pool: ReadonlyArray<GepaCandidate>;
  paretoFront: ReadonlyArray<GepaCandidate>;
  bestSoFar: GepaCandidate;
  metricCallsUsed: number;
  /** Did the just-completed iteration produce an accepted candidate? */
  accepted: boolean;
  /** If rejected, why. */
  rejectionReason?: string;
}

/** Final result of `runGepa`. */
export interface GepaResult {
  /** The single candidate with the highest aggregate score. */
  winner: GepaCandidate;
  /** All candidates that lived on the Pareto front at termination. */
  paretoFront: GepaCandidate[];
  /** Every candidate ever produced, oldest first. Useful for audit + lineage. */
  history: GepaCandidate[];
  /** Total metric calls actually made. */
  metricCallsUsed: number;
  /** Iterations actually completed. */
  iterationsRun: number;
  /** Why the run stopped: budget exhausted, all constraints failed N times, etc. */
  stopReason: 'iterations_exhausted' | 'metric_budget_exhausted' | 'no_improvement_possible';
}
