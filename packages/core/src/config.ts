/** Tunable defaults, no secrets; docs/MCTS.md and docs/EVOLUTION.md describe each constant. */

export interface MCTSDefaults {
  budget: number;
  branches: number;
  maxDepth: number;
  explorationWeight: number;
  /** Sits inside the fail band [0.05,0.30] (mcts/evaluation.ts), so the band's top gets a reprieve. */
  pruneThreshold: number;
  /** The fail ceiling (0.30): a converged answer must clear the whole fail band. */
  minAcceptableScore: number;
  maxCostUSD: number;
  minVisitsForPrune: number;
  /** Fail ceiling plus a thin margin, so every fail-band node earns a reflection. */
  reflectionThreshold: number;
  /** Pass-band midpoint (0.60 + 0.40/2); unreachable by any prose branch (cap 0.75). */
  craftExtractionThreshold: number;
  judgeSamples: number;
  /** Per-branch eval LLM-call budget (assertion generation + judge samples). */
  maxEvalLLMCalls: number;
  /** Score gap for a near-tied Alternate Take at convergence (mcts/takes.ts). */
  takesEpsilon: number;
}

/** Per-head scoring reuses the MCTS judge knobs; only the merge ensemble size is heads-specific. */
export interface HeadsDefaults {
  /** Merge-synthesis samples; the median-scored one is kept. */
  mergeSamples: number;
}

export interface CraftStoreDefaults {
  /** Higher weights recent observations more. */
  emaAlpha: number;
  /** Days unused after which the score halves. */
  halfLifeDays: number;
  retirementThreshold: number;
  minUsesBeforeRetirement: number;
  minEffectiveScoreForInjection: number;
  /** Word-overlap threshold for conflict detection (craft/conflict.ts). */
  conflictSimilarityThreshold: number;
}

export interface ScaffoldDefaults {
  minRationaleLength: number;
}

/** Read field by field; per-knob overrides live in the `actor_config` table and apply at each call site via `??`. */
export const DEFAULT_CONFIG = {
  mcts: {
    budget: 5,
    branches: 3,
    // A cap, not a target; matches the `optimise` preset (literature: ToT <=3, LATS 7, Koh 5).
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

