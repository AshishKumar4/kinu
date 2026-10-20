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

/** Per-head scoring reuses the `mcts` judge knobs; only the merge ensemble size is heads-specific. */
export interface HeadsDefaults {
  /** Merge-synthesis samples; the median-scored one is kept. */
  mergeSamples: number;
}

export interface CraftStoreDefaults {
  /** The most crafted tools a turn is offered, best preference first (craft/preference.ts). */
  offeredCap: number;
  /** A tool offered this many turns that no turn chose for {@link unchosenDays} is retired. */
  offersBeforeRetirement: number;
  unchosenDays: number;
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
    offeredCap: 20,
    offersBeforeRetirement: 50,
    unchosenDays: 30,
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

