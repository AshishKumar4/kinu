/** Tunable defaults, no secrets; docs/EXPLORATION.md and docs/EVOLUTION.md describe each constant. */

export interface MCTSDefaults {
  maxDepth: number;
  explorationWeight: number;
  /** Sits inside the fail band [0.05,0.30] (mcts/evaluation.ts), so the band's top gets a reprieve. */
  pruneThreshold: number;
  minVisitsForPrune: number;
  judgeSamples: number;
  /** Per-branch eval LLM-call budget (assertion generation + judge samples). */
  maxEvalLLMCalls: number;
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
    // A cap, not a target; matches the `optimise` preset (literature: ToT <=3, LATS 7, Koh 5).
    maxDepth: 5,
    explorationWeight: Math.SQRT2,
    pruneThreshold: 0.25,
    minVisitsForPrune: 2,
    judgeSamples: 3,
    maxEvalLLMCalls: 4,
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

