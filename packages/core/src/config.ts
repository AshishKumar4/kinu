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

/** Sensible defaults — all tunable, zero secrets.
 *
 *  Four constant tables, read field by field (`DEFAULT_CONFIG.mcts.judgeSamples`
 *  and its like). There is no whole-config value to merge and no caller that
 *  overrides one: per-knob overrides live in the `agent_config` table and are
 *  applied at each call site by `??`, which is why `mergeConfig` and the
 *  `AgentConfig` aggregate it took have been deleted rather than kept as the
 *  shape nothing constructs. */
export const DEFAULT_CONFIG = {
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
} satisfies {
  mcts: MCTSDefaults;
  heads: HeadsDefaults;
  craftStore: CraftStoreDefaults;
  scaffold: ScaffoldDefaults;
};

