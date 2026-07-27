/**
 * Configuration system — all tunable parameters with sensible defaults.
 * Zero hardcoded secrets. All credentials come from the caller.
 *
 * Architecture reference: final-architecture.md §3, §5, §6
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

export const DEFAULT_MAX_STEPS = 500;

/** Sensible defaults — all tunable, zero secrets */
export const DEFAULT_CONFIG: AgentConfig = {
  maxSteps: DEFAULT_MAX_STEPS,
  mcts: {
    budget: 5,
    branches: 3,
    maxDepth: 20,
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

/** Resolve maxSteps from env or default */
export function resolveMaxSteps(): number {
  const env = process.env.PROTEUS_MAX_STEPS;
  return env ? parseInt(env, 10) : DEFAULT_MAX_STEPS;
}
