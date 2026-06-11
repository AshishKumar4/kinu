/**
 * GEPA → scaffold bridge.
 *
 * Glues the GEPA optimiser to the existing scaffold pipeline so a GEPA run
 * produces a real pending version. Flow:
 *
 *   1. Read current scaffold (or use caller-supplied seed).
 *   2. Run GEPA with scaffold-aware constraints (REQUIRED_SIGNATURE +
 *      FORBIDDEN_PATTERNS, mirrored from scaffold/modify.ts).
 *   3. If `winner.source !== seed AND winner.aggregateScore > seed.aggregateScore`,
 *      hand off to `modifyScaffold` — the winner enters `scaffold_versions`
 *      with status='pending' and the existing shadow eval + promotion
 *      pipeline takes over.
 *
 * No behavioural promotion happens here — `applyPromotionDecision` is still
 * the only path that touches the live `scaffold/agent.js`. GEPA is a
 * proposal generator.
 */

import type { AgentRuntime } from '../../types/agent-runtime.js';
import { modifyScaffold } from '../../scaffold/modify.js';
import {
  SCAFFOLD_FORBIDDEN_PATTERNS, SCAFFOLD_REQUIRED_SIGNATURE,
} from '../../scaffold/safety-patterns.js';
import { runGepa } from './engine.js';
import type {
  EvalInstance, GepaConfig, GepaMetric, GepaResult, ReflectionLM,
} from './types.js';

/** Maximum scaffold source size — keeps candidate explosion bounded.
 *  Aligned with Hermes-Self-Evolution's ≤15KB skill size cap (skills and
 *  scaffolds serve similar "loaded every turn" cost profiles). */
const SCAFFOLD_MAX_BYTES = 15 * 1024;

export interface RunScaffoldGepaOpts<I = unknown, E = unknown> {
  rt: AgentRuntime;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  /** Reflection-minibatch source (the outcome-labeled negatives to fix).
   *  Defaults to evalSet — see GepaConfig.trainSet. */
  trainSet?: ReadonlyArray<EvalInstance<I, E>>;
  metric: GepaMetric<I, E>;
  reflectionLm: ReflectionLM;
  /** Defaults to the current scaffold's source. */
  seed?: string;
  budget?: GepaConfig<I, E>['budget'];
  parentSelection?: GepaConfig<I, E>['parentSelection'];
  random?: () => number;
  onIteration?: GepaConfig<I, E>['onIteration'];
  /**
   * If provided, override the rationale string passed to `modifyScaffold`.
   * Default: `"GEPA-optimised scaffold (aggregate ${score})"`.
   * Must be ≥ scaffold.minRationaleLength (50 chars) per modifyScaffold gate 1.
   */
  rationale?: string;
  /**
   * Skip the handoff to `modifyScaffold` and just return the GEPA result.
   * Useful when the caller wants to inspect the result before persisting.
   * Default false.
   */
  dryRun?: boolean;
}

export interface RunScaffoldGepaResult<I = unknown, E = unknown> {
  /** The raw GEPA output — winner + Pareto front + history. */
  gepa: GepaResult;
  /** Whether the winner was handed off to modifyScaffold. */
  proposed: boolean;
  /** If proposed, the new scaffold version number; null otherwise. */
  pendingVersion: number | null;
  /** Why we didn't propose (when applicable). */
  skipReason?:
    | 'dry_run'
    | 'winner_equals_seed'
    | 'modify_gate_rejected';
  /** If modifyScaffold rejected, the gate + error. */
  modifyError?: { stage: number; error: string };
}

export async function runScaffoldGepa<I = unknown, E = unknown>(
  opts: RunScaffoldGepaOpts<I, E>,
): Promise<RunScaffoldGepaResult<I, E>> {
  const seed = opts.seed ?? await opts.rt.identity.scaffold.read();

  const gepa = await runGepa({
    seed,
    evalSet: opts.evalSet,
    trainSet: opts.trainSet,
    metric: opts.metric,
    reflectionLm: opts.reflectionLm,
    budget: opts.budget,
    parentSelection: opts.parentSelection,
    random: opts.random,
    onIteration: opts.onIteration,
    constraints: {
      maxSizeBytes: SCAFFOLD_MAX_BYTES,
      requiredPattern: SCAFFOLD_REQUIRED_SIGNATURE,
      forbiddenPatterns: [...SCAFFOLD_FORBIDDEN_PATTERNS],
    },
  });

  if (opts.dryRun) {
    return { gepa, proposed: false, pendingVersion: null, skipReason: 'dry_run' };
  }

  const winner = gepa.winner;
  // `bestAggregate` breaks ties by `createdAt` (older wins) and the seed is
  // always the oldest, so any candidate strictly tied or below the seed's
  // aggregate yields `winner === seed`. We only ever reach modifyScaffold
  // when GEPA found a strictly-better candidate.
  if (winner.source === seed) {
    return { gepa, proposed: false, pendingVersion: null, skipReason: 'winner_equals_seed' };
  }
  const seedAggregate = gepa.history[0]?.aggregateScore ?? 0;

  // The default rationale is always well over modifyScaffold's 50-char gate-1
  // minimum, so no padding is needed.
  const rationale = opts.rationale ??
    `GEPA-optimised scaffold — aggregate ${winner.aggregateScore.toFixed(3)} ` +
    `over ${gepa.history.length - 1} mutations (seed: ${seedAggregate.toFixed(3)}).`;

  const modResult = await modifyScaffold(opts.rt, rationale, winner.source);
  if (!modResult.ok) {
    return {
      gepa, proposed: false, pendingVersion: null,
      skipReason: 'modify_gate_rejected',
      modifyError: { stage: modResult.stage ?? 0, error: modResult.error ?? 'unknown' },
    };
  }
  return {
    gepa, proposed: true, pendingVersion: modResult.version ?? null,
  };
}
