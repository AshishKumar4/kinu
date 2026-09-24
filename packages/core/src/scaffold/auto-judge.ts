/**
 * Auto-judge shadow evaluation: one trial. Runs the pending scaffold on a
 * recorded task, judges it against the live answer, records the result, and
 * optionally applies a conclusive promotion decision.
 *
 * Trials are sampled and queued at turn end (evolution/control.ts
 * `queueTurnShadowTrial`) and run from the cadence lane, never on the source turn.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import * as v from 'valibot';
import {
  type PendingScaffold, type ShadowConfig, type ShadowTrialVerdict, type ScaffoldDecisionEvents,
  DEFAULT_SHADOW_CONFIG, getPendingScaffold, getCurrentScaffoldVersion,
  recordShadowEvaluation, scoredShadowTrial, decidePromotion, applyPromotionDecision, readScaffoldVersion,
} from './shadow';
import { runScaffold, scaffoldEventText, type ScaffoldRunResult } from './executor';
import { diagnostics, KinuError, toKinuError } from '../obs/index';

/** One judge call's output. The judge sees two unlabelled responses in random order. */
const JudgeOutputSchema = v.object({
  winner: v.picklist(['a', 'b', 'tie']),
  rationale: v.pipe(v.string(), v.minLength(1)),
  scoreA: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  scoreB: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

export type JudgeOutput = v.InferOutput<typeof JudgeOutputSchema>;

/** Host-supplied judge, called twice per trial (see judgeTrialOrderSwapped). */
export type StructuredJudgeFn = (prompt: string, schema: typeof JudgeOutputSchema) => Promise<JudgeOutput>;

export interface AutoJudgeConfig {
  /** Apply conclusive decisions. Engine default false; backends pass actor_config auto_promote_scaffold. */
  autoApply: boolean;
  shadowConfig: ShadowConfig;
}

export const DEFAULT_AUTO_JUDGE_CONFIG: AutoJudgeConfig = {
  autoApply: false,
  shadowConfig: DEFAULT_SHADOW_CONFIG,
  // Cost is bounded by sampling at queue time; the trial itself has no deadline.
};

export interface RunAutoShadowEvalOpts {
  rt: AgentRuntime;
  events: ScaffoldDecisionEvents;
  /** Keys the evaluation row so a re-run after interruption rewrites the same score. */
  trialId?: string;
  task: string;
  /** What the live scaffold (or streamText fallback) returned to the user. */
  currentOutput: string;
  judge: StructuredJudgeFn;
  llmStream: Parameters<typeof runScaffold>[0]['llmStream'];
  /**
   * Gives the pending the live tool surface for a fair comparison. The pending's
   * writes land in agent state; applied decisions stay revertable in the changelog.
   */
  callTool?: Parameters<typeof runScaffold>[0]['callTool'];
  /** Runs host.defaultInference for the pending; omitted means it returns an error. */
  defaultInference?: Parameters<typeof runScaffold>[0]['defaultInference'];
  /** Passed for the same reason as callTool: a missing capability handicaps the pending. */
  history?: Parameters<typeof runScaffold>[0]['history'];
  config?: Partial<AutoJudgeConfig>;
  /** Drives the judge's presentation order. Default Math.random. */
  random?: () => number;
}

export interface AutoShadowEvalResult {
  readonly skipped: boolean;
  readonly reason?: 'no_pending' | 'pending_unreadable';
  readonly evaluation?: {
    currentScore: number;
    pendingScore: number;
    winner: 'current' | 'pending' | 'tie';
    rationale: string;
  };
  readonly decision?: 'promote' | 'rollback' | 'continue';
  readonly applied?: 'promote' | 'rollback' | null;
}

/** Execute one shadow trial and, if conclusive and `autoApply`, apply the decision. */
export async function runAutoShadowEval(opts: RunAutoShadowEvalOpts): Promise<AutoShadowEvalResult> {
  const config: AutoJudgeConfig = { ...DEFAULT_AUTO_JUDGE_CONFIG, ...opts.config };
  const rng = opts.random ?? Math.random;

  const pending = getPendingScaffold(opts.rt.storage.sql, opts.rt.actor);

  if (!pending) return { skipped: true, reason: 'no_pending' };

  // Already scored: skip the re-drive (it would repeat live tool calls), but the promotion decision is still owed.
  const scored = opts.trialId === undefined
    ? null
    : scoredShadowTrial(opts.rt.storage.sql, opts.rt.actor, opts.trialId);

  if (scored) {
    const settled = await settlePromotion(opts, config, pending);

    return { skipped: false, evaluation: { ...scored }, ...settled };
  }

  const pendingCode = await readScaffoldVersion(opts.rt, pending.version);

  if (!pendingCode) return { skipped: true, reason: 'pending_unreadable' };

  // Final text includes ui_chunk text-deltas so a delegating pending is judged on its real output.
  const pendingEvents: string[] = [];
  let pendingResult: ScaffoldRunResult;

  try {
    pendingResult = await runScaffold({
      rt: opts.rt,
      task: opts.task,
      emit: (event) => {
        const text = scaffoldEventText(event);

        if (text !== null) pendingEvents.push(text);
      },
      llmStream: opts.llmStream,
      // Without callTool, runScaffold's capability guard returns an unavailable-runtime error.
      callTool: opts.callTool,
      defaultInference: opts.defaultInference,
      history: opts.history,
      scaffoldCodeOverride: pendingCode,
    });
  } catch (err) {
    diagnostics.failure(
      'scaffold.pending_run_failed',
      toKinuError({ doing: 'run the pending scaffold for a shadow trial', cause: err, otherwise: 'unavailable' }),
    );

    return { skipped: true, reason: 'pending_unreadable' };
  }

  const pendingOutput = pendingEvents.join('') || (pendingResult.error ?? '');

  // Windowed once so the recorded trial is exactly the evidence judged.
  const evidence = {
    task: evidenceWindow(opts.task, EVIDENCE_BUDGETS.shadowTask),
    currentOutput: evidenceWindow(opts.currentOutput, EVIDENCE_BUDGETS.shadowOutput),
    pendingOutput: evidenceWindow(pendingOutput, EVIDENCE_BUDGETS.shadowOutput),
  };

  let judgeResult: ShadowTrialVerdict;

  try {
    judgeResult = await judgeTrialOrderSwapped({ ...evidence, judge: opts.judge, pendingFirst: rng() < 0.5 });
  } catch (err) {
    diagnostics.failure(
      'scaffold.judge_failed',
      toKinuError({ doing: 'judge a shadow trial', cause: err, otherwise: 'unavailable' }),
    );

    return { skipped: true };
  }

  const evaluation = {
    // Live version comes from status; numbering is non-contiguous after rollbacks.
    currentVersion: getCurrentScaffoldVersion(opts.rt.storage.sql, opts.rt.actor) ?? pending.version - 1,
    pendingVersion: pending.version,
    ...evidence,
    judgeResult,
  };

  recordShadowEvaluation(
    opts.rt.storage.sql,
    opts.rt.actor,
    opts.trialId === undefined ? evaluation : { ...evaluation, trialId: opts.trialId },
  );

  const settled = await settlePromotion(opts, config, pending);

  return {
    skipped: false,
    evaluation: {
      currentScore: judgeResult.currentScore,
      pendingScore: judgeResult.pendingScore,
      winner: judgeResult.winner,
      rationale: judgeResult.rationale,
    },
    ...settled,
  };
}

/** Read the gate and apply its decision; counts are re-read because other trials may have landed. */
async function settlePromotion(
  opts: RunAutoShadowEvalOpts,
  config: AutoJudgeConfig,
  pending: { version: number },
): Promise<{ decision: 'promote' | 'rollback' | 'continue'; applied: 'promote' | 'rollback' | null }> {
  const fresh = getPendingScaffold(opts.rt.storage.sql, opts.rt.actor);

  if (!fresh || fresh.version !== pending.version) return { decision: 'continue', applied: null };
  const decision = decidePromotion(fresh, config.shadowConfig).decision;

  if (!config.autoApply || decision === 'continue') return { decision, applied: null };

  try {
    // The promotion-time misevolution recheck can turn 'promote' into 'rollback'.
    const outcome = await applyPromotionDecision(opts.rt, fresh, decision, opts.events);

    if (outcome.vetoReason) {
      diagnostics.failure(
        'scaffold.promotion_vetoed',
        new KinuError('denied', outcome.vetoReason),
        { scaffoldVersion: fresh.version, action: outcome.action },
      );
    }

    return { decision, applied: outcome.action };
  } catch (err) {
    diagnostics.failure(
      'scaffold.promotion_apply_failed',
      toKinuError({ doing: 'apply a scaffold promotion decision', cause: err, otherwise: 'io' }),
      { scaffoldVersion: fresh.version, decision },
    );

    return { decision, applied: null };
  }
}

interface JudgeTrialOpts {
  judge: StructuredJudgeFn;
  task: string;
  currentOutput: string;
  pendingOutput: string;
  /** Candidate shown as "Response A" in the first call; the second call swaps. */
  pendingFirst: boolean;
}

/**
 * Judge one trial with neutral labels, randomized order, and two order-swapped
 * calls, removing position and status-quo bias. A candidate wins only by winning
 * both orders; a flip is a tie. Scores are averaged. Tie-rate cost is calibrated
 * in scripts/shadow-veto-monte-carlo.ts.
 */
async function judgeTrialOrderSwapped(opts: JudgeTrialOpts): Promise<ShadowTrialVerdict> {
  const [first, second] = await Promise.all([
    opts.judge(buildJudgePrompt(opts, opts.pendingFirst), JudgeOutputSchema),
    opts.judge(buildJudgePrompt(opts, !opts.pendingFirst), JudgeOutputSchema),
  ]);

  const one = attributeCall(first, opts.pendingFirst);
  const two = attributeCall(second, !opts.pendingFirst);

  const agreed = one.winner === two.winner && one.winner !== 'tie';
  const flipped = one.winner !== 'tie' && two.winner !== 'tie' && one.winner !== two.winner;

  return {
    winner: agreed ? one.winner : 'tie',
    rationale: flipped
      ? `Order-swap flip (${one.winner}, then ${two.winner}) — recorded as a tie. ${one.rationale} | ${two.rationale}`
      : `${one.rationale} | ${two.rationale}`,
    currentScore: (one.currentScore + two.currentScore) / 2,
    pendingScore: (one.pendingScore + two.pendingScore) / 2,
  };
}

function attributeCall(out: JudgeOutput, pendingIsA: boolean): ShadowTrialVerdict {
  const pendingSlot = pendingIsA ? 'a' : 'b';
  const currentSlot = pendingIsA ? 'b' : 'a';

  const winner = ((): ShadowTrialVerdict['winner'] => {
    if (out.winner === pendingSlot) return 'pending';

    return out.winner === currentSlot ? 'current' : 'tie';
  })();

  return {
    winner,
    rationale: out.rationale,
    currentScore: pendingIsA ? out.scoreB : out.scoreA,
    pendingScore: pendingIsA ? out.scoreA : out.scoreB,
  };
}

/** Judge prompt for one ordering; carries no provenance. Inputs arrive already bounded. */
function buildJudgePrompt(opts: JudgeTrialOpts, pendingIsA: boolean): string {
  const responseA = pendingIsA ? opts.pendingOutput : opts.currentOutput;
  const responseB = pendingIsA ? opts.currentOutput : opts.pendingOutput;

  return [
    'You are judging two candidate responses to the SAME task.',
    'They are shown in a random order and are deliberately unlabelled — their',
    'position tells you nothing about where they came from or how good they are.',
    // One score per response: asking per criterion led models to emit objects that fail validation.
    'Give each response ONE overall score from 0.0 to 1.0, weighing correctness,',
    'helpfulness and clarity together.',
    'Pick a winner ("a" / "b" / "tie") and give a one-sentence rationale.',
    '',
    `Task:\n${opts.task}`,
    '',
    `Response A:\n${responseA}`,
    '',
    `Response B:\n${responseB}`,
    '',
    'Respond with the structured JSON {winner, rationale, scoreA, scoreB},',
    'where scoreA and scoreB are plain numbers, not objects.',
  ].join('\n');
}

export type { PendingScaffold, ShadowConfig, ShadowTrialVerdict };
