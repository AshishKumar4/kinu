/**
 * The one per-step message pipeline shared by both backends' step hooks.
 * Order: mission budget guard (before the spend), SDK tool-error feedback,
 * extension prepareStep chain, tool-output pruning, dynamic-context weave with
 * the turn-local messages right before the turn's input, then prompt-cache tail
 * markers last. Cache markers placed before any rewrite
 * would bust the rolling prefix on one backend and not the other.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { TurnContextMeter } from '../context-meter';
import type { ExtensionHost } from '../extension';
import { MissionBudgetExhausted, type MissionGovernor } from '../mission-budget';
import { markCacheTail, type PromptCacheStrategy } from './cache-breakpoints';
import { pruneStepToolOutputs, type StepPruneBudget } from './step-prune';
import { normalizeReplayForDestination } from './replay-normalization';
import { placeTurnLocal, type DynamicContext, type DynamicContextLedger, type TurnLocalPlacement } from './volatile-context';
import { estimateTokens } from '../llm';
import { projectToolErrorFeedback, type ToolErrorStep } from './tool-error-feedback';

/** `system`: cache-eligible system override for backends whose turn-level system
 *  channel is string-only (Think) and must re-ride every step; the CLI omits it. */
export interface StepCachePlan {
  readonly strategy: PromptCacheStrategy;
  readonly system?: string | SystemModelMessage;
}

export interface StepDynamicContext {
  readonly ledger: DynamicContextLedger;
  /** Read every live source once for this step. Synchronous by contract: sources
     *  answer without I/O; await-only state belongs to turn assembly. */
  readonly snapshot: () => DynamicContext;
}

/** Raw context ownership is settled before ephemeral render transforms run. */
export interface StepContextPlane {
  /** `turnStart`: the index of the turn's first message in `messages`, where turn-local messages ride. */
  base(): Promise<{ readonly messages: ModelMessage[]; readonly changed: boolean; readonly turnStart?: number }>;
  consume(step: { readonly stepNumber: number; readonly messages: readonly ModelMessage[] }): Promise<void>;
}

export interface StepPipeline {
  readonly extensions?: ExtensionHost | undefined;
  /** Cache plan for marker strategies; null/absent leaves the array unmarked. */
  readonly cache?: StepCachePlan | null | undefined;
  /** Step-prune budget; null/absent skips the pruning pass. */
  readonly prune?: StepPruneBudget | null | undefined;
  readonly budget?: MissionGovernor | undefined;
  readonly dynamic?: StepDynamicContext | undefined;
  /** Replayed tool ids/reasoning are normalized for this provider right before cache markers and measurement. */
  readonly destinationProviderId?: string | undefined;
  /** Measures the final composed array, the only place it exists. */
  readonly meter?: TurnContextMeter | undefined;
  /** Where a staged mid-turn edit lands and the consumed revision is recorded. Absent = unclaimed work. */
  readonly context?: StepContextPlane | undefined;
  /** This turn's turn-local messages, placed right before its input on every step, and that input's index in the
   *  step's messages when no context plane re-reads them. */
  readonly turnLocal?: { readonly messages: readonly ModelMessage[]; readonly turnStart: number } | undefined;
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

/** Returns step overrides (`PrepareStepResult`) or `undefined` when unchanged.
 *  Stays synchronous unless an extension must finish I/O first.
 *  Throws {@link MissionBudgetExhausted} when the mission label's cap is spent;
 *  the governor has already written `budget_exhausted`. */
export function composePrepareStep(pipeline: StepPipeline, ctx: StepPrepareContext): StepPrepareResult | Promise<StepPrepareResult> {
  const refusal = pipeline.budget?.guard('model_call');

  if (refusal) throw new MissionBudgetExhausted(refusal);

  if (pipeline.context !== undefined) return pipeline.context.base().then(base => {
    if (base.changed) pipeline.dynamic?.ledger.reset();

    return prepareFromContext(pipeline, { ...ctx, messages: base.messages }, base.turnStart);
  });

  return prepareFromContext(pipeline, ctx, pipeline.turnLocal?.turnStart);
}

function prepareFromContext(
  pipeline: StepPipeline, ctx: StepPrepareContext, turnStart: number | undefined,
): StepPrepareResult | Promise<StepPrepareResult> {
  const projected = projectToolErrorFeedback(ctx.messages, ctx.steps);
  const prepared = { ...ctx, messages: projected ?? ctx.messages, abortSignal: pipeline.abortSignal };
  const steered = pipeline.extensions?.runPrepareStep(prepared);

  const turnLocal = pipeline.turnLocal === undefined || turnStart === undefined
    ? undefined
    : { at: turnStart, messages: pipeline.turnLocal.messages };

  return steered instanceof Promise
    ? steered.then(messages => finishPrepareStep(pipeline, ctx, messages ?? projected, turnLocal))
    : finishPrepareStep(pipeline, ctx, steered ?? projected, turnLocal);
}

function finishPrepareStep(
  pipeline: StepPipeline,
  ctx: StepPrepareContext,
  steered: ModelMessage[] | undefined,
  turnLocal: TurnLocalPlacement | undefined,
): StepPrepareResult | Promise<StepPrepareResult> {
  const base = steered ?? ctx.messages;

  // The weave runs after pruning (frozen positions refer to the final array); reserve what it adds, and the
  // turn-local messages, before pruning or the request is priced too small.
  const reserved = (pipeline.dynamic?.ledger.overheadTokens ?? 0)
    + (turnLocal === undefined ? 0 : estimateTokens(JSON.stringify(turnLocal.messages).length));

  const pruned = pipeline.prune
    ? pruneStepToolOutputs(base, { ...pipeline.prune, reservedTokens: (pipeline.prune.reservedTokens ?? 0) + reserved })
    : undefined;

  const shrunk = pruned ?? base;

  // Always rewrites: a prepareStep override never feeds the next step's input. Turn-local messages stay out of the
  // ledger's positions.
  const woven = pipeline.dynamic?.ledger.weave(shrunk, pipeline.dynamic.snapshot(), turnLocal)
    ?? (turnLocal === undefined ? undefined : placeTurnLocal(shrunk, turnLocal));

  const working = woven ?? shrunk;
  const replayed = normalizeReplayForDestination(working, pipeline.destinationProviderId);
  const destinationReady = replayed ?? working;
  const plan = pipeline.cache;
  const messages = plan ? markCacheTail(destinationReady, plan.strategy) : destinationReady;
  // Measure every step, including unchanged ones: each is still a priced request.
  pipeline.meter?.measure(messages);
  // Recorded before the request is issued, so the revision is durable before it can have an effect.
  const consumed = pipeline.context?.consume({ stepNumber: ctx.stepNumber, messages });

  const rewritten = pipeline.context !== undefined || steered !== undefined
    || pruned !== undefined || woven !== undefined || replayed !== undefined;

  let result: StepPrepareResult;

  if (plan) {
    result = plan.system === undefined ? { messages } : { system: plan.system, messages };
  } else {
    result = rewritten ? { messages } : undefined;
  }

  return consumed instanceof Promise ? consumed.then(() => result) : result;
}
