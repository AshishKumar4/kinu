/**
 * Sampled per-turn shadow evaluation — the promotion half of the scaffold
 * loop, orchestrated once for both backends: read the operator's sampling +
 * auto-promote knobs from agent_config, wire the host bridges, run
 * runAutoShadowEval, and swallow failures (fire-and-forget — a shadow eval
 * must never fail a turn). The backends supply only their genuinely
 * platform-shaped pieces: the judge LLM, the host bridges, and the
 * default-inference replay.
 *
 * The evidence budget is NOT applied here — runAutoShadowEval owns it and
 * applies it once (prompts/evidence-window.ts).
 *
 * Returns the eval result for the caller's telemetry (event emit / changelog
 * invalidation), or null when sampling is off or the eval failed.
 */

import { runAutoShadowEval, DEFAULT_AUTO_JUDGE_CONFIG, type RunAutoShadowEvalOpts, type AutoShadowEvalResult } from '../scaffold/auto-judge.js';
import type { AgentRuntime } from '../types/agent-runtime.js';

/** The agent_config slice this orchestration reads — structural so tests and
 *  both backends' stores satisfy it. */
export interface ShadowEvalConfig {
  getShadowSampleRate(): number;
  getAutoPromoteScaffold(): boolean;
}

export async function runSampledShadowEval(opts: {
  rt: AgentRuntime;
  config: ShadowEvalConfig;
  task: string;
  currentOutput: string;
  judge: RunAutoShadowEvalOpts['judge'];
  llmStream: RunAutoShadowEvalOpts['llmStream'];
  callTool: NonNullable<RunAutoShadowEvalOpts['callTool']>;
  defaultInference: NonNullable<RunAutoShadowEvalOpts['defaultInference']>;
  history: NonNullable<RunAutoShadowEvalOpts['history']>;
}): Promise<AutoShadowEvalResult | null> {
  try {
    const sampleRate = opts.config.getShadowSampleRate();
    if (sampleRate <= 0) return null;
    return await runAutoShadowEval({
      rt: opts.rt,
      // Passed WHOLE. runAutoShadowEval owns the evidence budget and applies
      // it once, to the judge and the trial row together; a second clamp here
      // both duplicated the policy and lied about it — windowing an already
      // windowed string reports the second pass's omission count, not the
      // total. It also mattered beyond tidiness: `task` is what the PENDING
      // scaffold is run on, so the old 2000-char slice asked the pending to
      // answer a truncated version of the question the live turn answered in
      // full, and then judged the two against each other.
      task: opts.task,
      currentOutput: opts.currentOutput,
      judge: opts.judge,
      llmStream: opts.llmStream,
      callTool: opts.callTool,
      defaultInference: opts.defaultInference,
      history: opts.history,
      config: {
        ...DEFAULT_AUTO_JUDGE_CONFIG,
        sampleRate,
        autoApply: opts.config.getAutoPromoteScaffold(),
      },
    });
  } catch (err) {
    console.warn('[proteus] shadow eval failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
