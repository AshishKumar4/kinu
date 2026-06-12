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
  pruneThreshold: number;
  minAcceptableScore: number;
  maxCostUSD: number;
  /** Minimum visits before a node can be pruned */
  minVisitsForPrune: number;
  /** Score threshold below which reflections are generated */
  reflectionThreshold: number;
  /** Score threshold above which crafted tools are extracted */
  craftExtractionThreshold: number;
  /** Judge ensemble size per branch evaluation (median-aggregated). */
  judgeSamples: number;
  /** Per-branch evaluation LLM-call budget (assertion generation + judge
   *  samples) — the operator's spend dial for grounded scoring. */
  maxEvalLLMCalls: number;
  /** Score gap within which a rival branch counts as a near-tied Alternate
   *  Take at convergence (see mcts/takes.ts). */
  takesEpsilon: number;
  /** Step-level Process Reward gate. Off by default — at single-step rollout
   *  depth it duplicates the grounded evaluator at extra cost (mcts/step-prm.ts). */
  stepPrm: boolean;
  /** Step-PRM prune threshold: proposals scoring below this skip the grounded
   *  evaluator. Only consulted when stepPrm is on. */
  stepPrmPruneThreshold: number;
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
  /** Maximum tools injected per codemode execution */
  maxToolsPerExecution: number;
  /** Word overlap threshold for semantic conflict detection */
  conflictSimilarityThreshold: number;
}

/** Scaffold management parameters */
export interface ScaffoldDefaults {
  /** Minimum rationale length for scaffold modifications */
  minRationaleLength: number;
  /** Score gap threshold: canary must be within this of baseline */
  canaryScoreGap: number;
  /** Error rate threshold for auto-rollback (absolute) */
  autoRollbackErrorRate: number;
  /** Error rate relative increase threshold for auto-rollback */
  autoRollbackRelativeIncrease: number;
  /** Minimum task history entries before error-rate monitoring kicks in */
  minTasksForMonitoring: number;
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
    stepPrm: false,
    stepPrmPruneThreshold: 0.3,
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
    maxToolsPerExecution: 10,
    conflictSimilarityThreshold: 0.85,
  },
  scaffold: {
    minRationaleLength: 50,
    canaryScoreGap: 0.10,
    autoRollbackErrorRate: 0.1,
    autoRollbackRelativeIncrease: 1.2,
    minTasksForMonitoring: 5,
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
