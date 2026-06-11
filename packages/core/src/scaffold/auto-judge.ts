/**
 * Auto-judge shadow evaluation — closes the shadow-rollout loop.
 *
 * Per chat turn (sampled to keep cost bounded), runs the pending scaffold
 * against the same task the user just sent, asks a judge LLM to compare
 * its output to the live response, and records the result. When trial
 * count reaches minTrials and the decision is conclusive, optionally
 * auto-promotes or auto-rolls-back.
 *
 * Sampling: configurable via `sampleRate` (0.0..1.0). Default 0.25 — every
 * fourth turn. Use 1.0 for full coverage at 2× LLM cost; use 0 to disable
 * automatic evaluation (RPC-driven only).
 *
 * Cost discipline: only fires when a pending scaffold exists. Aborts
 * gracefully on judge LLM failure (logged, not recorded).
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import * as v from 'valibot';
import {
  type PendingScaffold, type ShadowConfig, type JudgeFn,
  DEFAULT_SHADOW_CONFIG, getPendingScaffold, getCurrentScaffoldVersion,
  recordShadowEvaluation, decidePromotion, applyPromotionDecision, readScaffoldVersion,
} from './shadow.js';
import { runScaffold, type ScaffoldRunResult } from './executor.js';

/** Structured judge output — compares current vs pending scaffold on the
 *  same task. Valibot schema; AI SDK's generateObject accepts it via the
 *  StandardSchema spec. */
export const JudgeOutputSchema = v.object({
  winner: v.picklist(['current', 'pending', 'tie']),
  rationale: v.pipe(v.string(), v.minLength(1)),
  currentScore: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  pendingScore: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

export type JudgeOutput = v.InferOutput<typeof JudgeOutputSchema>;

/**
 * The host supplies one of these — typically a wrapper over generateObject
 * with the JudgeOutputSchema. Lets core stay framework-agnostic.
 */
export type StructuredJudgeFn = (prompt: string, schema: typeof JudgeOutputSchema) => Promise<JudgeOutput>;

export interface AutoJudgeConfig {
  /** Fraction of turns to evaluate (0..1). Default 0.25. */
  sampleRate: number;
  /** Auto-apply promotion/rollback when decision is conclusive. Default false. */
  autoApply: boolean;
  /** Forwarded to decidePromotion. Default DEFAULT_SHADOW_CONFIG. */
  shadowConfig: ShadowConfig;
  /** Wall-clock cap per scaffold run, in ms. Default 60s. */
  scaffoldTimeoutMs: number;
}

export const DEFAULT_AUTO_JUDGE_CONFIG: AutoJudgeConfig = {
  sampleRate: 0.25,
  autoApply: false,
  shadowConfig: DEFAULT_SHADOW_CONFIG,
  scaffoldTimeoutMs: 60_000,
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
   * accepted cost of accurate evaluation; autoApply stays off by default
   * so the operator still gates promotion.
   */
  callTool?: Parameters<typeof runScaffold>[0]['callTool'];
  /** Default-inference bridge for the pending scaffold (host.defaultInference).
   *  When the pending delegates to the default loop, this runs it for the
   *  shadow task. Omitted → host.defaultInference returns an error. */
  defaultInference?: Parameters<typeof runScaffold>[0]['defaultInference'];
  config?: Partial<AutoJudgeConfig>;
  /** Deterministic sampling override (used by tests). Default Math.random. */
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
 *   5. Ask judge LLM to compare current vs pending text
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

  // Run the pending scaffold against the same task. Capture all events;
  // the FINAL text we'll compare is the concatenation of text_delta payloads.
  const pendingEvents: string[] = [];
  let pendingResult: ScaffoldRunResult;
  try {
    pendingResult = await runScaffold({
      rt: opts.rt,
      task: opts.task,
      emit: (event) => {
        if (event.type === 'text_delta') pendingEvents.push(event.text);
      },
      llmStream: opts.llmStream,
      // Pass the caller's dispatcher straight through so the pending scaffold
      // runs against the same tool surface the live turn did. When omitted,
      // runScaffold's own capability guard returns an unavailable-runtime
      // error; no second stub is needed here. Side-effect note: the pending's
      // tool calls hit the live env; autoApply stays off by default so
      // promotion is still gated.
      callTool: opts.callTool,
      defaultInference: opts.defaultInference,
      scaffoldCodeOverride: pendingCode,
      timeoutMs: config.scaffoldTimeoutMs,
    });
  } catch (err) {
    console.warn('[auto-judge] pending scaffold run failed:', err instanceof Error ? err.message : err);
    return { skipped: true, reason: 'pending_unreadable' };
  }

  const pendingOutput = pendingEvents.join('') || (pendingResult.error ?? '');

  // Build the judge prompt.
  const prompt = buildJudgePrompt({
    task: opts.task,
    currentOutput: opts.currentOutput,
    pendingOutput,
  });

  let judgeResult: JudgeOutput;
  try {
    judgeResult = await opts.judge(prompt, JudgeOutputSchema);
  } catch (err) {
    console.warn('[auto-judge] judge LLM failed:', err instanceof Error ? err.message : err);
    return { skipped: true };
  }

  recordShadowEvaluation(opts.rt.storage.sql, {
    // Derived from status — after rollback cycles the live version is NOT
    // pending - 1 (the numbering is non-contiguous).
    currentVersion: getCurrentScaffoldVersion(opts.rt.storage.sql) ?? pending.version - 1,
    pendingVersion: pending.version,
    task: opts.task.slice(0, 1000),
    currentOutput: opts.currentOutput.slice(0, 4000),
    pendingOutput: pendingOutput.slice(0, 4000),
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

function buildJudgePrompt(opts: { task: string; currentOutput: string; pendingOutput: string }): string {
  return [
    'You are judging two candidate responses to the SAME task.',
    'Score each from 0.0 to 1.0 on (a) correctness, (b) helpfulness, (c) clarity.',
    'Pick a winner ("current" / "pending" / "tie") and give a one-sentence rationale.',
    '',
    `Task:\n${opts.task.slice(0, 1500)}`,
    '',
    `Response A (CURRENT scaffold's output):\n${opts.currentOutput.slice(0, 2500)}`,
    '',
    `Response B (PENDING scaffold's output):\n${opts.pendingOutput.slice(0, 2500)}`,
    '',
    'Respond with the structured JSON {winner, rationale, currentScore, pendingScore}.',
  ].join('\n');
}

// Re-export for convenience.
export type { PendingScaffold, ShadowConfig, JudgeFn };
