/**
 * The ONE per-step message pipeline, shared verbatim by both backends'
 * step hooks (`runChat`'s prepareStep on the CLI, the cf orchestrator's
 * Think `beforeStep`):
 *
 *   0. mission budget guard        — the turn is about to issue another priced
 *      request, so an exhausted mission label stops it HERE, before the spend,
 *      rather than after N more steps of an unbounded run
 *   1. typed SDK error feedback — project original native errors into their
 *      model-facing error channel before anything prices or rewrites the request
 *   2. extension prepareStep chain — mid-turn steering / plugin rewrites
 *   3. step-boundary tool-output pruning — an over-budget step context
 *      shrinks OLD tool outputs (step-prune.ts), so a long tool-heavy turn
 *      stops re-paying its own tool traffic on every request
 *   4. dynamic-context weave        — the live state of the system, re-read at
 *      THIS step and appended as a new `<dynamic_context>` block only when it
 *      changed (volatile-context.ts). Runs after the rewrites above so the
 *      ledger's frozen positions are coordinates in the array the model
 *      actually receives
 *   5. prompt-cache tail markers    — LAST, onto the final message array,
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
import { applyStagedContext, type StagedContextDeferral, type StagedContextEdit } from './staged-context';
import type { DynamicContext, DynamicContextLedger } from './volatile-context';
import { projectToolErrorFeedback, type ToolErrorStep } from './tool-error-feedback';

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

/**
 * The durable context plane of the claim this turn runs under.
 *
 * Three obligations, all at this seam because this is the only place that holds
 * both the live raw array and the FINAL rendered one:
 *
 *  • the actor's working base is asked for at every boundary and applied, so a
 *    landed edit stays applied for the rest of the turn instead of surfacing for
 *    one request and vanishing at the next (the SDK rebuilds each step from the
 *    array the stream started with, so a per-step override is not history);
 *  • a PENDING edit lands at the first safe boundary (`staged-context.ts`
 *    decides which) and its deferral is reported with a reason, so an edit is
 *    never silently dropped and never silently ignored;
 *  • the array the step actually consumes is recorded as the rendered revision
 *    that step ran on — after error projection, steering, pruning, the
 *    dynamic-context weave and the destination re-key, and before the request
 *    goes out — pointing at the working revision it was rendered from.
 *
 * Both backends wire this: the CLI through `ActorSession.execute`, the hosted
 * root through its `beforeStep` hook. A pipeline with no claim — a shadow-eval
 * replay, a head's own inference — leaves it absent and records nothing, which
 * is correct: that work is not a claimed actor turn.
 */
export interface StepContextPlane {
  /** The working base this step must render from, or null when the turn still
   *  runs on exactly the array it was admitted with. */
  base(): (StagedContextEdit & { readonly revision: number }) | null;
  /** Record the exact array this step consumes, the working revision it came
   *  from, and — when a pending revision could not land here — why. */
  consume(step: {
    readonly stepNumber: number;
    readonly messages: readonly ModelMessage[];
    readonly base: (StagedContextEdit & { readonly revision: number }) | null;
    readonly deferred: StagedContextDeferral | null;
  }): void;
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
  /** The claim's durable context plane: where a staged mid-turn edit lands and
   *  where the consumed revision is recorded. Absent = unclaimed work. */
  readonly context?: StepContextPlane | undefined;
  /** The turn's cancellation, handed to every extension hook. */
  readonly abortSignal?: AbortSignal | undefined;
}

export type StepPrepareResult =
  | { system?: string | SystemModelMessage; messages: ModelMessage[] }
  | undefined;

export interface StepPrepareContext {
  readonly stepNumber: number;
  readonly messages: ModelMessage[];
  /** The SDK's own completed steps, not a second outcome registry. */
  readonly steps: readonly ToolErrorStep[];
}

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
  ctx: StepPrepareContext,
): StepPrepareResult | Promise<StepPrepareResult> {
  const refusal = pipeline.budget?.guard('model_call');
  if (refusal) throw new MissionBudgetExhausted(refusal);
  const projected = projectToolErrorFeedback(ctx.messages, ctx.steps);
  const prepared = { ...ctx, messages: projected ?? ctx.messages, abortSignal: pipeline.abortSignal };
  const steered = pipeline.extensions?.runPrepareStep(prepared);
  if (steered instanceof Promise) {
    return steered.then((messages) => finishPrepareStep(pipeline, ctx, messages ?? projected));
  }
  return finishPrepareStep(pipeline, ctx, steered ?? projected);
}

function finishPrepareStep(
  pipeline: StepPipeline,
  ctx: StepPrepareContext,
  steered: ModelMessage[] | undefined,
): StepPrepareResult {
  const steeredBase = steered ?? ctx.messages;
  // The working base is applied HERE — after steering, so a steer that landed
  // mid-turn is part of the tail the edit preserves, and before pruning, so the
  // edited array is what the window budget is applied to.
  const workingBase = pipeline.context?.base() ?? null;
  const applied = workingBase === null ? null : applyStagedContext(steeredBase, workingBase);
  const rebased = applied?.kind === 'landed' ? applied.messages : null;
  const base = rebased ?? steeredBase;
  // A LANDING moves every message index in the array, and the ledger's frozen
  // blocks are indices. `weave` self-heals only when a block runs past the end
  // or backwards; an edit that shortens the history BETWEEN two block positions
  // leaves both in range and both wrong, so the landing step resets the ledger
  // and the next weave starts over with one fresh block at the tail.
  if (rebased !== null && workingBase?.pending === true) pipeline.dynamic?.ledger.reset();
  // The weave runs AFTER pruning: frozen block positions refer to the final
  // message array. Reserve its overhead before pruning, or the request would
  // be priced smaller than the one actually sent.
  const pruned = pipeline.prune
    ? pruneStepToolOutputs(base, pipeline.dynamic
      ? { ...pipeline.prune, reservedTokens: (pipeline.prune.reservedTokens ?? 0) + pipeline.dynamic.ledger.overheadTokens }
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
  // Recorded on that same final array, and BEFORE this request is issued: the
  // revision a step ran on is durable by the time the step can have an effect.
  pipeline.context?.consume({
    stepNumber: ctx.stepNumber,
    messages,
    base: rebased === null ? null : workingBase,
    deferred: applied?.kind === 'deferred' ? applied.reason : null,
  });
  if (!plan) return steered || rebased || pruned || woven || replayed ? { messages } : undefined;
  return plan.system !== undefined ? { system: plan.system, messages } : { messages };
}
