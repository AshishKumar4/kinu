/**
 * Auto-judge shadow evaluation — closes the shadow-rollout loop.
 *
 * Per chat turn (sampled to keep cost bounded), runs the pending scaffold
 * against the same task the user just sent, asks a judge LLM to compare
 * its output to the live response, and records the result. When trial
 * count reaches minTrials and the decision is conclusive, optionally
 * auto-promotes or auto-rolls-back.
 *
 * Judging is order-swapped and double-called — see judgeTrialOrderSwapped for
 * the bias it removes and what it costs.
 *
 * Sampling: configurable via `sampleRate` (0.0..1.0). Default 0.25 — every
 * fourth turn. Use 1.0 for full coverage (one extra scaffold run plus two
 * judge calls per turn); use 0 to disable automatic evaluation (RPC-driven only).
 *
 * Cost discipline: only fires when a pending scaffold exists. Aborts
 * gracefully on judge LLM failure (logged, not recorded).
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LLM } from '../types/primitives.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';
import * as v from 'valibot';
import {
  type PendingScaffold, type ShadowConfig, type JudgeFn, type ShadowTrialVerdict,
  DEFAULT_SHADOW_CONFIG, getPendingScaffold, getCurrentScaffoldVersion,
  recordShadowEvaluation, decidePromotion, applyPromotionDecision, readScaffoldVersion,
} from './shadow.js';
import { runScaffold, scaffoldEventText, SCAFFOLD_TURN_TIMEOUT_MS, type ScaffoldRunResult } from './executor.js';

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
  /** Fraction of turns to evaluate (0..1). Default 0.25. */
  sampleRate: number;
  /** Auto-apply promotion/rollback when decision is conclusive. The engine
   *  default is false (a bare runAutoShadowEval never mutates state); both
   *  backends pass the agent-level switch, which defaults ON
   *  (agent_config auto_promote_scaffold, config/store.ts). */
  autoApply: boolean;
  /** Forwarded to decidePromotion. Default DEFAULT_SHADOW_CONFIG. */
  shadowConfig: ShadowConfig;
  /** Wall-clock cap per scaffold run, in ms. Defaults to the LIVE turn budget
   *  ({@link SCAFFOLD_TURN_TIMEOUT_MS}) — see below for why it cannot be less. */
  scaffoldTimeoutMs: number;
}

export const DEFAULT_AUTO_JUDGE_CONFIG: AutoJudgeConfig = {
  sampleRate: 0.25,
  autoApply: false,
  shadowConfig: DEFAULT_SHADOW_CONFIG,
  // The candidate runs under the SAME wall clock the live loop got. This was
  // 60s against a live 5 minutes, which does not measure scaffold quality: any
  // candidate that attempted substantial work timed out, scored 0, and was
  // rolled back for reasons unrelated to how good it was, so the gate could
  // only ever promote scaffolds that finish fast and do little. Sampling
  // (`sampleRate`) is where the cost is bounded — evaluate fewer candidates,
  // not each one under a handicap.
  scaffoldTimeoutMs: SCAFFOLD_TURN_TIMEOUT_MS,
};

export interface RunAutoShadowEvalOpts {
  rt: AgentRuntime;
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
  /** Deterministic randomness override (used by tests). Drives both the
   *  sampling roll and the judge's presentation order. Default Math.random. */
  random?: () => number;
}

export interface AutoShadowEvalResult {
  readonly skipped: boolean;
  readonly reason?: 'no_pending' | 'not_sampled' | 'pending_unreadable';
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
 * Run one round of auto-judge shadow evaluation.
 *
 * Idempotent w.r.t. sampling — the caller is expected to invoke fire-and-
 * forget; whether work happens depends on sampleRate + presence of a pending
 * scaffold.
 *
 * Sequence:
 *   1. Get pending scaffold (skip if none)
 *   2. Decide to sample (skip if not in the sample)
 *   3. Read pending code (skip if file missing — shouldn't happen)
 *   4. Run pending via runScaffold against the same task
 *   5. Judge the two outputs with the order-swapped double-win rule
 *   6. Record via recordShadowEvaluation
 *   7. If trial count >= minTrials and config.autoApply, applyPromotionDecision
 */
export async function runAutoShadowEval(opts: RunAutoShadowEvalOpts): Promise<AutoShadowEvalResult> {
  const config: AutoJudgeConfig = { ...DEFAULT_AUTO_JUDGE_CONFIG, ...opts.config };
  const rng = opts.random ?? Math.random;

  const pending = getPendingScaffold(opts.rt.storage.sql);
  if (!pending) return { skipped: true, reason: 'no_pending' };

  if (rng() >= config.sampleRate) {
    return { skipped: true, reason: 'not_sampled' };
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
      timeoutMs: config.scaffoldTimeoutMs,
    });
  } catch (err) {
    console.warn('[auto-judge] pending scaffold run failed:', err instanceof Error ? err.message : err);
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
    console.warn('[auto-judge] judge LLM failed:', err instanceof Error ? err.message : err);
    return { skipped: true };
  }

  recordShadowEvaluation(opts.rt.storage.sql, {
    // Derived from status — after rollback cycles the live version is NOT
    // pending - 1 (the numbering is non-contiguous).
    currentVersion: getCurrentScaffoldVersion(opts.rt.storage.sql) ?? pending.version - 1,
    pendingVersion: pending.version,
    ...evidence,
    judgeResult,
  });

  // Reread pending to get updated counts; decide whether to apply.
  const fresh = getPendingScaffold(opts.rt.storage.sql);
  const decision = fresh
    ? decidePromotion(fresh, config.shadowConfig).decision
    : 'continue' as const;

  let applied: 'promote' | 'rollback' | null = null;
  if (config.autoApply && decision !== 'continue' && fresh) {
    try {
      // Report the action ACTUALLY applied — the promotion-time misevolution
      // recheck can convert a 'promote' into a 'rollback'.
      const outcome = await applyPromotionDecision(opts.rt, fresh, decision);
      applied = outcome.action;
      if (outcome.vetoReason) {
        console.warn('[auto-judge] promotion vetoed:', outcome.vetoReason);
      }
    } catch (err) {
      console.warn('[auto-judge] applyPromotionDecision failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    skipped: false,
    evaluation: {
      currentScore: judgeResult.currentScore,
      pendingScore: judgeResult.pendingScore,
      winner: judgeResult.winner,
      rationale: judgeResult.rationale,
    },
    decision,
    applied,
  };
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
export type { PendingScaffold, ShadowConfig, JudgeFn, ShadowTrialVerdict };
