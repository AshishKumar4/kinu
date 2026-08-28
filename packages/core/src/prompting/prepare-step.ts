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
import type { TurnContextMeter } from '../context-meter';
import type { ExtensionHost } from '../extension';
import { MissionBudgetExhausted, type MissionGovernor } from '../mission-budget';
import { markCacheTail, type PromptCacheStrategy } from './cache-breakpoints';
import { pruneStepToolOutputs, type StepPruneBudget } from './step-prune';
import { normalizeReplayForDestination } from './replay-normalization';
import type { DynamicContext, DynamicContextLedger } from './volatile-context';

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
  /** The provider that will receive this request. A destination boundary,
   *  not durable history: replayed tool ids/reasoning are normalized here
   *  immediately before wire-facing cache markers and measurement. */
  readonly destinationProviderId?: string | undefined;
  /** Per-step context measurement. This is the only place that holds the FINAL
   *  composed array, so it is the only place the breakdown can be measured
   *  against what the request actually was rather than what it was going to be
   *  before the rewrites, the pruning and the weave. Absent = not measured. */
  readonly meter?: TurnContextMeter | undefined;
}

export type StepPrepareResult =
  | { system?: string | SystemModelMessage; messages: ModelMessage[] }
  | undefined;

/** Run the step pipeline. Returns the step overrides (AI SDK
 *  `PrepareStepResult` shape), or `undefined` when nothing changed. The
 *  synchronous path remains synchronous; an extension that must finish I/O
 *  before the model sees its rewrite promotes this invocation to a Promise.
 *
 *  Throws {@link MissionBudgetExhausted} when the turn runs under a mission
 *  label whose cap is spent: the host declines the request instead of issuing
 *  it, the governor has already written the `budget_exhausted` run event, and
 *  the turn ends with the refusal as its error. A turn with no mission scope
 *  (the default) can never reach that branch. */
export function composePrepareStep(
  pipeline: StepPipeline,
  ctx: { stepNumber: number; messages: ModelMessage[] },
): StepPrepareResult | Promise<StepPrepareResult> {
  const refusal = pipeline.budget?.guard('model_call');
  if (refusal) throw new MissionBudgetExhausted(refusal);
  const steered = pipeline.extensions?.runPrepareStep(ctx);
  if (steered instanceof Promise) {
    return steered.then((messages) => finishPrepareStep(pipeline, ctx, messages));
  }
  return finishPrepareStep(pipeline, ctx, steered);
}

function finishPrepareStep(
  pipeline: StepPipeline,
  ctx: { stepNumber: number; messages: ModelMessage[] },
  steered: ModelMessage[] | undefined,
): StepPrepareResult {
  const base = steered ?? ctx.messages;
  // The weave runs AFTER the prune (step 3 — frozen block positions have to be
  // coordinates in the array the model actually receives), so the pruner has
  // to be TOLD what the ledger is about to hand back. Unreserved it prices a
  // request smaller than the one that gets sent, by the ledger's whole size.
  const pruned = pipeline.prune
    ? pruneStepToolOutputs(base, pipeline.dynamic
      ? { ...pipeline.prune, reservedTokens: pipeline.dynamic.ledger.overheadTokens }
      : pipeline.prune)
    : undefined;
  const shrunk = pruned ?? base;
  // The weave always rewrites (frozen blocks must be re-applied every step —
  // a prepareStep override never feeds the next step's input).
  const woven = pipeline.dynamic?.ledger.weave(shrunk, pipeline.dynamic.snapshot());
  const working = woven ?? shrunk;
  const replayed = normalizeReplayForDestination(working, pipeline.destinationProviderId);
  const destinationReady = replayed ?? working;
  const plan = pipeline.cache;
  const messages = plan ? markCacheTail(destinationReady, plan.strategy) : destinationReady;
  // Measured on the FINAL array, and on every step — including the step that
  // changed nothing and returns undefined below, which is still a priced
  // request and still occupies the window.
  pipeline.meter?.measure(messages);
  if (!plan) return steered || pruned || woven || replayed ? { messages } : undefined;
  return plan.system !== undefined ? { system: plan.system, messages } : { messages };
}
