/**
 * The ONE per-step message pipeline, shared verbatim by both backends'
 * step hooks (`runChat`'s prepareStep on the CLI, the cf orchestrator's
 * Think `beforeStep`):
 *
 *   0. mission budget guard        — the turn is about to issue another priced
 *      request, so an exhausted mission label stops it HERE, before the spend,
 *      rather than after N more steps of an unbounded run
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
import { MissionBudgetExhausted, type MissionGovernor } from '../mission-budget.js';
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
 *  `PrepareStepResult` shape), or `undefined` when nothing changed.
 *
 *  Throws {@link MissionBudgetExhausted} when the turn runs under a mission
 *  label whose cap is spent: the host declines the request instead of issuing
 *  it, the governor has already written the `budget_exhausted` run event, and
 *  the turn ends with the refusal as its error. A turn with no mission scope
 *  (the default) can never reach that branch. */
export function composePrepareStep(
  extensions: ExtensionHost | undefined,
  ctx: { stepNumber: number; messages: ModelMessage[] },
  plan: StepCachePlan | null,
  prune?: StepPruneBudget | null,
  budget?: MissionGovernor,
): { system?: string | SystemModelMessage; messages: ModelMessage[] } | undefined {
  const refusal = budget?.guard('model_call');
  if (refusal) throw new MissionBudgetExhausted(refusal);
  const steered = extensions?.runPrepareStep(ctx);
  const base = steered ?? ctx.messages;
  const pruned = prune ? pruneStepToolOutputs(base, prune) : undefined;
  const working = pruned ?? base;
  if (!plan) return steered || pruned ? { messages: working } : undefined;
  const messages = markCacheTail(working, plan.strategy);
  return plan.system !== undefined ? { system: plan.system, messages } : { messages };
}
