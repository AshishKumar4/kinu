/**
 * Auto-judge shadow evaluation — ONE trial, executed.
 *
 * Runs the pending scaffold against a recorded task, asks a judge LLM to
 * compare its output to what the live turn answered, and records the result.
 * When the accumulated trials make the promotion gate conclusive, optionally
 * auto-promotes or auto-rolls-back.
 *
 * Judging is order-swapped and double-called — see judgeTrialOrderSwapped for
 * the bias it removes and what it costs.
 *
 * This is the expensive half of the loop — a whole candidate turn plus two
 * judge calls — and it never runs on the turn that produced the task. Which
 * turns become trials is decided (and sampled) where the turn ends
 * (evolution/control.ts `queueTurnShadowTrial`); this runs what that queued,
 * from the cadence lane.
 *
 * Cost discipline: only fires when a pending scaffold exists. Aborts
 * gracefully on judge LLM failure (logged, not recorded).
 */

import type { AgentRuntime } from '../types/agent-runtime';
import type { LLM } from '../types/primitives';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import * as v from 'valibot';
import {
  type PendingScaffold, type ShadowConfig, type ShadowTrialVerdict,
  DEFAULT_SHADOW_CONFIG, getPendingScaffold, getCurrentScaffoldVersion,
  recordShadowEvaluation, scoredShadowTrial, decidePromotion, applyPromotionDecision, readScaffoldVersion,
} from './shadow';
import { runScaffold, scaffoldEventText, type ScaffoldRunResult } from './executor';
import { diagnostics, KinuError, toKinuError } from '../obs/index';

/**
 * Structured output of ONE judge call. Deliberately neutral: the judge sees
 * two unlabelled responses in a randomized order and is never told which one
 * the live scaffold produced, so it cannot express a status-quo preference.
 * Valibot schema; AI SDK's generateObject accepts it via the StandardSchema spec.
 */
export const JudgeOutputSchema = v.object({
  winner: v.picklist(['a', 'b', 'tie']),
  rationale: v.pipe(v.string(), v.minLength(1)),
  scoreA: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  scoreB: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

export type JudgeOutput = v.InferOutput<typeof JudgeOutputSchema>;

/**
 * The host supplies one of these — typically a wrapper over generateObject
 * with the JudgeOutputSchema. Lets core stay framework-agnostic. Called TWICE
 * per trial (see judgeTrialOrderSwapped).
 */
export type StructuredJudgeFn = (prompt: string, schema: typeof JudgeOutputSchema) => Promise<JudgeOutput>;

/**
 * The default judge: core's own provider-agnostic structured-output idiom
 * (ask for a JSON object, extract, validate) over any `LLM`. A backend that
 * needs provider-specific request options builds its own; a backend that just
 * needs a working judge uses this instead of writing a fourth copy.
 */
export function createStructuredJudge(llm: LLM): StructuredJudgeFn {
  return async (prompt, schema) =>
    v.parse(schema, extractJsonObject(await llm.complete(`${prompt}\n\n${jsonObjectOnlyInstruction()}`)));
}

export interface AutoJudgeConfig {
  /** Auto-apply promotion/rollback when decision is conclusive. The engine
   *  default is false (a bare runAutoShadowEval never mutates state); both
   *  backends pass the agent-level switch, which defaults ON
   *  (agent_config auto_promote_scaffold, config/store.ts). */
  autoApply: boolean;
  /** Forwarded to decidePromotion. Default DEFAULT_SHADOW_CONFIG. */
  shadowConfig: ShadowConfig;
}

export const DEFAULT_AUTO_JUDGE_CONFIG: AutoJudgeConfig = {
  autoApply: false,
  shadowConfig: DEFAULT_SHADOW_CONFIG,
  // Cost is bounded by sampling — how many turns become trials at all — and
  // that bound is applied when a trial is QUEUED, not when it runs. The trial
  // itself carries no elapsed deadline (owner ruling: none on scaffold loops);
  // the candidate runs to completion exactly as the live turn did.
};

export interface RunAutoShadowEvalOpts {
  rt: AgentRuntime;
  /** The queued trial being scored, when this eval drains one. It keys the
   * evaluation row, which is what makes a re-run after an interruption write the
   * same score instead of a second one. */
  trialId?: string;
  /** The user's task for this turn. */
  task: string;
  /** What the LIVE scaffold (or streamText fallback) actually returned to the user. */
  currentOutput: string;
  /** Wrapping the LLM call that judges. */
  judge: StructuredJudgeFn;
  /** Optional: an llmStream for the pending scaffold's host.llmStream bridge. */
  llmStream: Parameters<typeof runScaffold>[0]['llmStream'];
  /**
   * Tool-call dispatcher for the pending scaffold. When provided, the
   * pending runs with the same tool surface the live scaffold would —
   * which is the fair comparison the judge needs. When omitted, the
   * pending's tool calls return the "disabled" error, which
   * unfairly penalises tool-using scaffolds.
   *
   * Side-effect note: enabling this lets the pending mutate VFS / SQL
   * the same way the live did this turn (e.g., both append to memory).
   * The pending's writes will appear in the agent's state. This is the
   * accepted cost of accurate evaluation; every applied decision is
   * visible and revertable in the Evolution Changelog.
   */
  callTool?: Parameters<typeof runScaffold>[0]['callTool'];
  /** Default-inference bridge for the pending scaffold (host.defaultInference).
   *  When the pending delegates to the default loop, this runs it for the
   *  shadow task. Omitted → host.defaultInference returns an error. */
  defaultInference?: Parameters<typeof runScaffold>[0]['defaultInference'];
  /** Read-only history bridge for the pending scaffold (host.history). Passed
   *  through for the same reason callTool is: a pending judged without a
   *  capability the live turn had is judged on a handicap, and a scaffold whose
   *  whole point is context discipline would lose every trial. */
  history?: Parameters<typeof runScaffold>[0]['history'];
  config?: Partial<AutoJudgeConfig>;
  /** Deterministic randomness override (used by tests). Drives the judge's
   *  presentation order. Default Math.random. */
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

/**
 * Execute one shadow trial.
 *
 * Sequence:
 *   1. Get pending scaffold (skip if none)
 *   2. Read pending code (skip if file missing — shouldn't happen)
 *   3. Run pending via runScaffold against the same task
 *   4. Judge the two outputs with the order-swapped double-win rule
 *   5. Record via recordShadowEvaluation
 *   6. If the gate is now conclusive and config.autoApply, applyPromotionDecision
 */
export async function runAutoShadowEval(opts: RunAutoShadowEvalOpts): Promise<AutoShadowEvalResult> {
  const config: AutoJudgeConfig = { ...DEFAULT_AUTO_JUDGE_CONFIG, ...opts.config };
  const rng = opts.random ?? Math.random;

  const pending = getPendingScaffold(opts.rt.storage.sql);
  if (!pending) return { skipped: true, reason: 'no_pending' };

  // ALREADY SCORED. The rollout below drives the pending scaffold through the
  // LIVE tool surface, so a re-drive after an interruption between the evaluation
  // insert and the queue delete would repeat whatever those tool calls did. Only
  // that half is skipped: the promotion decision behind it is still owed, and
  // returning here left an auto-promotable candidate pending forever, blocking
  // every later proposal.
  const scored = opts.trialId === undefined
    ? null
    : scoredShadowTrial(opts.rt.storage.sql, opts.trialId);
  if (scored) {
    const settled = await settlePromotion(opts, config, pending);
    return { skipped: false, evaluation: { ...scored }, ...settled };
  }

  const pendingCode = await readScaffoldVersion(opts.rt, pending.version);
  if (!pendingCode) return { skipped: true, reason: 'pending_unreadable' };

  // Run the pending scaffold against the same task. Capture all events; the
  // FINAL text we'll compare concatenates text_delta payloads AND the
  // text-deltas inside ui_chunks, so a pending that delegates to
  // host.defaultInference is judged on its real output, not an empty string.
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
      // Pass the caller's dispatcher straight through so the pending scaffold
      // runs against the same tool surface the live turn did. When omitted,
      // runScaffold's own capability guard returns an unavailable-runtime
      // error; no second stub is needed here. Side-effect note: the pending's
      // tool calls hit the live env; promotion stays gated by decidePromotion
      // and every applied decision is revertable from the changelog.
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

  // Windowed ONCE, then judged and recorded from the same strings — so the
  // trial row is exactly the evidence the verdict was formed on, rather than a
  // differently-truncated view of it.
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
    // Derived from status — after rollback cycles the live version is NOT
    // pending - 1 (the numbering is non-contiguous).
    currentVersion: getCurrentScaffoldVersion(opts.rt.storage.sql) ?? pending.version - 1,
    pendingVersion: pending.version,
    ...evidence,
    judgeResult,
  };
  recordShadowEvaluation(
    opts.rt.storage.sql,
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

/**
 * The half of an evaluation that runs AFTER the score is durable: read the gate,
 * and apply what it decided.
 *
 * Its own function because a re-drive of an already-scored trial owes exactly
 * this and nothing before it. The counts are re-read rather than carried — the
 * insert above changed them, and so did any trial that landed in between.
 */
async function settlePromotion(
  opts: RunAutoShadowEvalOpts,
  config: AutoJudgeConfig,
  pending: { version: number },
): Promise<{ decision: 'promote' | 'rollback' | 'continue'; applied: 'promote' | 'rollback' | null }> {
  const fresh = getPendingScaffold(opts.rt.storage.sql);
  // A candidate that moved on is one this trial can no longer decide about.
  if (!fresh || fresh.version !== pending.version) return { decision: 'continue', applied: null };
  const decision = decidePromotion(fresh, config.shadowConfig).decision;
  if (!config.autoApply || decision === 'continue') return { decision, applied: null };
  try {
    // Report the action ACTUALLY applied — the promotion-time misevolution
    // recheck can convert a 'promote' into a 'rollback'.
    const outcome = await applyPromotionDecision(opts.rt, fresh, decision);
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
  /** Which candidate is presented as "Response A" in the FIRST call. The
   *  second call always presents the opposite order. */
  pendingFirst: boolean;
}

/**
 * Judge one trial with the order-swapped double-win rule.
 *
 * The bias this removes: the incumbent used to be pinned to "Response A" and
 * labelled CURRENT, the candidate to "Response B" labelled PENDING. That is
 * two systematic, DIRECTIONAL handicaps stacked on the pending — position
 * bias, which peaks exactly when two candidates are close in quality (the
 * shadow regime by construction), plus a status-quo/novelty bias carried by
 * the labels themselves. The Monte Carlo that settled DEFAULT_SHADOW_CONFIG
 * models judge error as SYMMETRIC noise, so a directional bias was never
 * inside its guarantees.
 *
 * The rule: neutral labels, a randomized presentation order, and two calls
 * with the orders swapped. A candidate takes the trial only by winning BOTH
 * orders. A flip — each order picking a different candidate — is the exact
 * signature of an order-driven verdict, and is recorded as a TIE rather than
 * as a coin-flip win. Scores are averaged across the two orders.
 *
 * Cost: 2× judge tokens per sampled trial. Statistical cost: a materially
 * higher tie rate, which the promotion rule is recalibrated against
 * (scripts/shadow-veto-monte-carlo.ts, protocol dimension).
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

/** Map one neutral a/b verdict back onto current/pending using the order that
 *  call was presented in. */
function attributeCall(out: JudgeOutput, pendingIsA: boolean): ShadowTrialVerdict {
  const pendingSlot = pendingIsA ? 'a' : 'b';
  const currentSlot = pendingIsA ? 'b' : 'a';
  return {
    winner: out.winner === pendingSlot ? 'pending' : out.winner === currentSlot ? 'current' : 'tie',
    rationale: out.rationale,
    currentScore: pendingIsA ? out.scoreB : out.scoreA,
    pendingScore: pendingIsA ? out.scoreA : out.scoreB,
  };
}

/** The judge prompt for one ordering. Carries NO provenance: neither response
 *  is identified as the incumbent, and the instructions say so explicitly.
 *  Its inputs arrive already bounded (see `evidence` in runAutoShadowEval), so
 *  there is exactly one place that decides how much of a turn is judged. */
function buildJudgePrompt(opts: JudgeTrialOpts, pendingIsA: boolean): string {
  const responseA = pendingIsA ? opts.pendingOutput : opts.currentOutput;
  const responseB = pendingIsA ? opts.currentOutput : opts.pendingOutput;
  return [
    'You are judging two candidate responses to the SAME task.',
    'They are shown in a random order and are deliberately unlabelled — their',
    'position tells you nothing about where they came from or how good they are.',
    // One number per response, said twice: asking for three criteria and a
    // single `scoreA` field led models to answer with a per-criterion object,
    // which fails schema validation and throws the whole trial away.
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

// Re-export for convenience.
export type { PendingScaffold, ShadowConfig, ShadowTrialVerdict };
