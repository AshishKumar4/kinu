/**
 * Configuration system — all tunable parameters with sensible defaults.
 * Zero hardcoded secrets. All credentials come from the caller.
 *
 * Tuning constants: docs/MCTS.md and docs/EVOLUTION.md document what each one does.
 */

/** MCTS search parameters */
export interface MCTSDefaults {
  /** Default search iterations when the caller doesn't supply a budget. */
  budget: number;
  /** Default number of parallel branches expanded per node. */
  branches: number;
  maxDepth: number;
  explorationWeight: number;
  /** Prune settled branches scoring below this. Sits INSIDE the fail band
   *  [0.05,0.30] (mcts/evaluation.ts BAND TABLE) — below the fail ceiling, so a
   *  branch at the very top of the fail band gets a reprieve. */
  pruneThreshold: number;
  /** Convergence acceptance floor = the FAIL ceiling (0.30). A converged answer
   *  must clear the whole failed-execution / prose-dodge band. */
  minAcceptableScore: number;
  maxCostUSD: number;
  /** Minimum visits before a node can be pruned */
  minVisitsForPrune: number;
  /** Score below which a failure lesson is generated = FAIL ceiling + thin
   *  margin (0.35), so every fail-band node earns a reflection. */
  reflectionThreshold: number;
  /** Score above which crafted tools are extracted = pass-band MIDPOINT (0.80 =
   *  PASS_FLOOR 0.60 + ½·PASS_SPAN 0.40): executed code with an at-or-above-
   *  median judge only. Unreachable by any prose branch (cap 0.75). */
  craftExtractionThreshold: number;
  /** Judge ensemble size per branch evaluation (median-aggregated). */
  judgeSamples: number;
  /** Per-branch evaluation LLM-call budget (assertion generation + judge
   *  samples) — the operator's spend dial for grounded scoring. */
  maxEvalLLMCalls: number;
  /** Score gap within which a rival branch counts as a near-tied Alternate
   *  Take at convergence (see mcts/takes.ts). */
  takesEpsilon: number;
}

/** Branching-heads parameters. The per-head grounded score reuses the MCTS
 *  judge knobs (judgeSamples / maxEvalLLMCalls); only the merge ensemble size
 *  is heads-specific. */
export interface HeadsDefaults {
  /** Independent merge-synthesis samples; the median-scored one is kept.
   *  1 ⇒ the legacy n=1 merge. */
  mergeSamples: number;
}

/** CraftStore quality management parameters */
export interface CraftStoreDefaults {
  /** EMA smoothing factor (0-1). Higher = recent observations weighted more. */
  emaAlpha: number;
  /** Half-life for time decay in days. After this many days unused, score halves. */
  halfLifeDays: number;
  /** Tools below this effective score are candidates for retirement */
  retirementThreshold: number;
  /** Minimum uses before a tool can be retired */
  minUsesBeforeRetirement: number;
  /** Minimum effective score to be included in codemode preamble */
  minEffectiveScoreForInjection: number;
  /** Word overlap threshold for semantic conflict detection (craft/conflict.ts) */
  conflictSimilarityThreshold: number;
}

/** Scaffold management parameters */
export interface ScaffoldDefaults {
  /** Minimum rationale length for scaffold modifications */
  minRationaleLength: number;
}

/** Full agent configuration */
export interface AgentConfig {
  /** Maximum agentic steps per LLM call (tool-call loops). Default 500. */
  maxSteps: number;
  mcts: MCTSDefaults;
  heads: HeadsDefaults;
  craftStore: CraftStoreDefaults;
  scaffold: ScaffoldDefaults;
}

/**
 * How long ONE agent turn's worth of model work is measured to take, and the
 * single bound every turn-scoped and model-call-scoped timeout in this
 * repository derives from.
 *
 * Measured against `@cf/deepseek-ai/deepseek-v4-pro-0813` in one eval-tier run
 * (`20984b4e`): single turns of 151 s and 294 s, a five-turn conversation of
 * 509 s, eight algorithmic challenges averaging 92 s each, and one converged
 * MCTS terminal node of 437 s over five model calls. 509 s is the longest turn
 * on record here, so it is the FLOOR any such bound has to clear.
 *
 * The CEILING is `PLATFORM_CATALOG['do.alarm.wall_ms']` — a turn resumed from a
 * Durable Object alarm gets 15 minutes and no more — which is also the ceiling
 * the live suites give one search. A bound sitting AT the ceiling is killed by
 * the platform (or by the test runner) before it can report itself, so the
 * envelope sits inside the window rather than on its edge.
 *
 * Six separate timeouts were 120_000 with no measurement behind any of them,
 * which is under every turn measured above. On the CLI backend that made MCTS
 * silently non-functional: every rollout hit its ceiling, the engine scored each
 * failed branch 0, and `converge` then correctly refused to crown a winner over
 * a zero-signal tree — so a search returned no winner and said only that nothing
 * scored. Nothing was broken except the number.
 *
 * Re-measure rather than re-reason. A faster default model lowers the floor and
 * a slower one raises it, and neither is visible from this file.
 * `unit-turn-envelope.test.ts` holds the window — the 509 s floor and the 900 s
 * ceiling — and holds every bound that claims to derive from this to the same
 * value. Re-measuring means moving the figures above AND that test's floor; the
 * floor is not exported, because an exported measurement with no production reader
 * is a constant only its own test can reach.
 */
export const TURN_WALL_CLOCK_ENVELOPE_MS = 600_000;

export const DEFAULT_MAX_STEPS = 500;

/** Sensible defaults — all tunable, zero secrets */
export const DEFAULT_CONFIG: AgentConfig = {
  maxSteps: DEFAULT_MAX_STEPS,
  mcts: {
    budget: 5,
    branches: 3,
    // FIVE, and it is a cap rather than a target: a search reaches it only if
    // every level before it kept selecting. It was 20 — above every system in
    // the literature this repository cites (ToT <=3, LATS 7, Koh 5) and above
    // the deepest preset the swarm table declares (`prove`, 7). The owner's
    // ruling on depth caps was "like 5 or 10, but not 1", and 5 is where the
    // `optimise` preset already sits, so the two engines now agree.
    maxDepth: 5,
    explorationWeight: Math.SQRT2,
    pruneThreshold: 0.25,
    minAcceptableScore: 0.3,
    maxCostUSD: 10,
    minVisitsForPrune: 2,
    reflectionThreshold: 0.35,
    craftExtractionThreshold: 0.8,
    judgeSamples: 3,
    maxEvalLLMCalls: 4,
    takesEpsilon: 0.1,
  },
  heads: {
    mergeSamples: 3,
  },
  craftStore: {
    emaAlpha: 0.3,
    halfLifeDays: 30,
    retirementThreshold: 0.1,
    minUsesBeforeRetirement: 2,
    minEffectiveScoreForInjection: 0.2,
    conflictSimilarityThreshold: 0.85,
  },
  scaffold: {
    minRationaleLength: 50,
  },
};

/** Deep-merge user config over defaults */
export function mergeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  if (!overrides) return DEFAULT_CONFIG;
  return {
    maxSteps: overrides.maxSteps ?? DEFAULT_CONFIG.maxSteps,
    mcts: { ...DEFAULT_CONFIG.mcts, ...overrides.mcts },
    heads: { ...DEFAULT_CONFIG.heads, ...overrides.heads },
    craftStore: { ...DEFAULT_CONFIG.craftStore, ...overrides.craftStore },
    scaffold: { ...DEFAULT_CONFIG.scaffold, ...overrides.scaffold },
  };
}

/**
 * Resolve the step budget from a backend-supplied setting.
 *
 * The setting itself lives on the host — a shell variable on the CLI, a Worker
 * var on Cloudflare — so the backend reads it and passes it in. Core owns only
 * the interpretation, which is why there is one parser and not one per backend.
 */
export function resolveMaxSteps(configured?: string | null): number {
  return configured ? parseInt(configured, 10) : DEFAULT_MAX_STEPS;
}
