/**
 * Sampled per-turn shadow evaluation — the promotion half of the scaffold
 * loop, orchestrated once for both backends: read the operator's sampling +
 * auto-promote knobs from agent_config, bound the judge inputs, run
 * runAutoShadowEval, and swallow failures (fire-and-forget — a shadow eval
 * must never fail a turn). The backends supply only their genuinely
 * platform-shaped pieces: the judge LLM, the host bridges, and the
 * default-inference replay.
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
}): Promise<AutoShadowEvalResult | null> {
  try {
    const sampleRate = opts.config.getShadowSampleRate();
    if (sampleRate <= 0) return null;
    return await runAutoShadowEval({
      rt: opts.rt,
      task: opts.task.slice(0, 2000),
      currentOutput: opts.currentOutput.slice(0, 4000),
      judge: opts.judge,
      llmStream: opts.llmStream,
      callTool: opts.callTool,
      defaultInference: opts.defaultInference,
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
