/**
 * The ONE per-step message pipeline, shared verbatim by both backends'
 * step hooks (`runChat`'s prepareStep on the CLI, the cf orchestrator's
 * Think `beforeStep`):
 *
 *   1. extension prepareStep chain — mid-turn steering / plugin rewrites
 *   2. step-boundary tool-output pruning — an over-budget step context
 *      shrinks OLD tool outputs (step-prune.ts), so a long tool-heavy turn
 *      stops re-paying its own tool traffic on every request
 *   3. prompt-cache tail markers    — LAST, onto the final message array,
 *      so every request of the agentic loop reads the prefix the previous
 *      step wrote regardless of what extensions injected or pruning shrank.
 *
 * Centralizing the ordering here is the point: cache markers landing before
 * an extension rewrite (or before pruning) would silently bust the rolling
 * prefix on one backend and not the other.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { ExtensionHost } from '../extension.js';
import { markCacheTail, type PromptCacheStrategy } from './cache-breakpoints.js';
import { pruneStepToolOutputs, type StepPruneBudget } from './step-prune.js';

/** The in-flight turn's cache plan for marker strategies. `system` is the
 *  cache-eligible system override for backends whose turn-level system
 *  channel is string-only (Think's TurnConfig) and must therefore re-ride
 *  every step; the CLI passes the cacheable system at the streamText level
 *  and omits it here. */
export interface StepCachePlan {
  readonly strategy: PromptCacheStrategy;
  readonly system?: string | SystemModelMessage;
}

/** Run the step pipeline. Returns the step overrides (AI SDK
 *  `PrepareStepResult` shape), or `undefined` when nothing changed. */
export function composePrepareStep(
  extensions: ExtensionHost | undefined,
  ctx: { stepNumber: number; messages: ModelMessage[] },
  plan: StepCachePlan | null,
  prune?: StepPruneBudget | null,
): { system?: string | SystemModelMessage; messages: ModelMessage[] } | undefined {
  const steered = extensions?.runPrepareStep(ctx);
  const base = steered ?? ctx.messages;
  const pruned = prune ? pruneStepToolOutputs(base, prune) : undefined;
  const working = pruned ?? base;
  if (!plan) return steered || pruned ? { messages: working } : undefined;
  const messages = markCacheTail(working, plan.strategy);
  return plan.system !== undefined ? { system: plan.system, messages } : { messages };
}
