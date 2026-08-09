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
 *   3. dynamic-context weave        — the live state of the system, re-read at
 *      THIS step and appended as a new `<dynamic_context>` block only when it
 *      changed (volatile-context.ts). Runs after the rewrites above so the
 *      ledger's frozen positions are coordinates in the array the model
 *      actually receives
 *   4. prompt-cache tail markers    — LAST, onto the final message array,
 *      so every request of the agentic loop reads the prefix the previous
 *      step wrote regardless of what extensions injected, pruning shrank, or
 *      the ledger appended.
 *
 * Centralizing the ordering here is the point: cache markers landing before
 * an extension rewrite (or before pruning, or before the weave) would silently
 * bust the rolling prefix on one backend and not the other.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { ExtensionHost } from '../extension.js';
import { MissionBudgetExhausted, type MissionGovernor } from '../mission-budget.js';
import { markCacheTail, type PromptCacheStrategy } from './cache-breakpoints.js';
import { pruneStepToolOutputs, type StepPruneBudget } from './step-prune.js';
import type { DynamicContext, DynamicContextLedger } from './volatile-context.js';

/** The in-flight turn's cache plan for marker strategies. `system` is the
 *  cache-eligible system override for backends whose turn-level system
 *  channel is string-only (Think's TurnConfig) and must therefore re-ride
 *  every step; the CLI passes the cacheable system at the streamText level
 *  and omits it here. */
export interface StepCachePlan {
  readonly strategy: PromptCacheStrategy;
  readonly system?: string | SystemModelMessage;
}

/** The activation's dynamic-context ledger plus the reader that snapshots
 *  live state for one step. */
export interface StepDynamicContext {
  /** Per-activation, in-memory, never persisted. */
  readonly ledger: DynamicContextLedger;
  /**
   * Read every live source ONCE for this step — the pipeline runs between two
   * priced requests, so a snapshot is cheap next to what follows it.
   *
   * Synchronous by contract: every source it may read (SQL registries, the
   * executor router, the in-memory consent map) answers without I/O. State
   * that only an await can produce belongs to the turn, and callers close
   * over the value they read at turn assembly.
   */
  readonly snapshot: () => DynamicContext;
}

/** Everything the step pipeline composes, wired once per turn by the backend. */
export interface StepPipeline {
  /** Registered extensions — mid-turn steering, plugin rewrites. */
  readonly extensions?: ExtensionHost | undefined;
  /** Cache plan for marker strategies; null/absent leaves the array unmarked. */
  readonly cache?: StepCachePlan | null | undefined;
  /** Step-prune budget; null/absent skips the pruning pass. */
  readonly prune?: StepPruneBudget | null | undefined;
  /** The actor's mission budget governor, when the turn runs under a label. */
  readonly budget?: MissionGovernor | undefined;
  /** The live-state plane. Absent leaves the array without dynamic blocks. */
  readonly dynamic?: StepDynamicContext | undefined;
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
  pipeline: StepPipeline,
  ctx: { stepNumber: number; messages: ModelMessage[] },
): { system?: string | SystemModelMessage; messages: ModelMessage[] } | undefined {
  const refusal = pipeline.budget?.guard('model_call');
  if (refusal) throw new MissionBudgetExhausted(refusal);
  const steered = pipeline.extensions?.runPrepareStep(ctx);
  const base = steered ?? ctx.messages;
  const pruned = pipeline.prune ? pruneStepToolOutputs(base, pipeline.prune) : undefined;
  const shrunk = pruned ?? base;
  // The weave always rewrites (frozen blocks must be re-applied every step —
  // a prepareStep override never feeds the next step's input).
  const woven = pipeline.dynamic?.ledger.weave(shrunk, pipeline.dynamic.snapshot());
  const working = woven ?? shrunk;
  const plan = pipeline.cache;
  if (!plan) return steered || pruned || woven ? { messages: working } : undefined;
  const messages = markCacheTail(working, plan.strategy);
  return plan.system !== undefined ? { system: plan.system, messages } : { messages };
}
