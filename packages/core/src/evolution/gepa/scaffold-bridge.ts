/**
 * GEPA → scaffold bridge: runs GEPA under the same safety patterns `modifyScaffold`
 * gates on, and hands a strictly better winner to `modifyScaffold` as a pending
 * version. `applyPromotionDecision` remains the only path to the live scaffold.
 */

import type { AgentRuntime } from '../../types/agent-runtime';
import { modifyScaffold } from '../../scaffold/modify';
import {
  SCAFFOLD_FORBIDDEN_PATTERNS, SCAFFOLD_REQUIRED_SIGNATURE,
} from '../../scaffold/safety-patterns';
import { formatScoreInterval, scoreInterval, type ScoreInterval } from '../../utils/stats';
import { runGepa } from './engine';
import type {
  EvalInstance, GepaConfig, GepaMetric, GepaResult, ReflectionLM, GepaProgressHooks,
} from './types';

const SCAFFOLD_MAX_BYTES = 15 * 1024;

export interface RunScaffoldGepaOpts<I = unknown, E = unknown> extends GepaProgressHooks {
  rt: AgentRuntime;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  /** Reflection-minibatch source; defaults to evalSet. */
  trainSet?: ReadonlyArray<EvalInstance<I, E>>;
  metric: GepaMetric<I, E>;
  reflectionLm: ReflectionLM;
  seed?: string;
  budget?: GepaConfig<I, E>['budget'];
  parentSelection?: GepaConfig<I, E>['parentSelection'];
  random?: () => number;
  /** Must be ≥ scaffold.minRationaleLength (modifyScaffold gate 1). */
  rationale?: string;
}

export interface RunScaffoldGepaResult {
  gepa: GepaResult;
  /** Compare both intervals before believing the winner is better. */
  winnerScore: ScoreInterval;
  seedScore: ScoreInterval;
  proposed: boolean;
  pendingVersion: number | null;
  skipReason?:
    | 'winner_equals_seed'
    | 'modify_gate_rejected';
  modifyError?: { stage: number; error: string };
}

export async function runScaffoldGepa<I = unknown, E = unknown>(
  opts: RunScaffoldGepaOpts<I, E>,
): Promise<RunScaffoldGepaResult> {
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
    onCandidate: opts.onCandidate,
    constraints: {
      maxSizeBytes: SCAFFOLD_MAX_BYTES,
      requiredPattern: SCAFFOLD_REQUIRED_SIGNATURE,
      forbiddenPatterns: [...SCAFFOLD_FORBIDDEN_PATTERNS],
    },
  });

  const winner = gepa.winner;
  const winnerScore = scoreInterval([...winner.scores.values()]);
  const seedScore = scoreInterval([...(gepa.history[0]?.scores.values() ?? [])]);
  const scores = { winnerScore, seedScore };

  // Ties go to the older candidate and the seed is oldest, so reaching modifyScaffold means a strictly better aggregate.
  if (winner.source === seed) {
    return { gepa, ...scores, proposed: false, pendingVersion: null, skipReason: 'winner_equals_seed' };
  }

  // Carries the intervals so the promotion reader sees how thin the evidence was.
  const rationale = opts.rationale ??
    `GEPA-optimised scaffold — aggregate ${formatScoreInterval(winnerScore, 3)} ` +
    `over ${gepa.history.length - 1} mutations (seed: ${formatScoreInterval(seedScore, 3)}).`;

  const modResult = await modifyScaffold(opts.rt, rationale, winner.source);

  if (!modResult.ok) {
    return {
      gepa, ...scores, proposed: false, pendingVersion: null,
      skipReason: 'modify_gate_rejected',
      modifyError: { stage: modResult.stage ?? 0, error: modResult.error ?? 'unknown' },
    };
  }

  return {
    gepa, ...scores, proposed: true, pendingVersion: modResult.version ?? null,
  };
}
