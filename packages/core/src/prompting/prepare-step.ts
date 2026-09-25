/**
 * Both backends' per-step pipeline: mission budget guard (before the spend), tool-error feedback, extension
 * prepareStep chain, tool-output pruning, the dynamic-context weave, then cache tail markers, last, as markers
 * placed before a rewrite would bust one backend's prefix.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { TurnContextMeter } from '../context-meter';
import type { ExtensionHost } from '../extension';
import { MissionBudgetExhausted, type MissionGovernor } from '../mission-budget';
import { markCacheTail, type PromptCacheRoute, type PromptCacheStrategy } from './cache-breakpoints';
import { pruneStepToolOutputs, type StepPruneBudget } from './step-prune';
import { normalizeReplayForDestination } from './replay-normalization';
import type { DynamicContext, DynamicContextLedger, TurnInput } from './volatile-context';
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
  /** The turn's unapproved workspace files as one message, null for none; the ledger keeps where it went out. */
  readonly instructions?: string | null | undefined;
}

/** Raw context ownership is settled before ephemeral render transforms run. */
export interface StepContextPlane {
  /** `turnStart`: the index of the turn's input, which blocks born at its first step ride before. */
  base(): Promise<{ readonly messages: ModelMessage[]; readonly changed: boolean; readonly turnStart?: number }>;
  consume(step: { readonly stepNumber: number; readonly messages: readonly ModelMessage[]; readonly cache?: PromptCacheRoute }): Promise<void>;
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
  /** The input's index in the step's messages when no context plane re-reads them. */
  readonly turnStart?: number | undefined;
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

/** Step overrides, or `undefined` when unchanged; synchronous unless an extension must finish I/O. Throws
 *  {@link MissionBudgetExhausted} on a spent cap, after the governor wrote `budget_exhausted`. */
export function composePrepareStep(pipeline: StepPipeline, ctx: StepPrepareContext): StepPrepareResult | Promise<StepPrepareResult> {
  const refusal = pipeline.budget?.guard('model_call');

  if (refusal) throw new MissionBudgetExhausted(refusal);

  if (pipeline.context !== undefined) return pipeline.context.base().then(base => {
    if (base.changed) pipeline.dynamic?.ledger.reset();

    return prepareFromContext(pipeline, { ...ctx, messages: base.messages }, base.turnStart);
  });

  return prepareFromContext(pipeline, ctx, pipeline.turnStart);
}

function prepareFromContext(
  pipeline: StepPipeline, ctx: StepPrepareContext, turnStart: number | undefined,
): StepPrepareResult | Promise<StepPrepareResult> {
  const projected = projectToolErrorFeedback(ctx.messages, ctx.steps);
  const prepared = { ...ctx, messages: projected ?? ctx.messages, abortSignal: pipeline.abortSignal };
  const steered = pipeline.extensions?.runPrepareStep(prepared);

  const input = turnStart === undefined ? undefined : { at: turnStart, firstStep: ctx.stepNumber === 0 } satisfies TurnInput;

  return steered instanceof Promise
    ? steered.then(messages => finishPrepareStep(pipeline, ctx, messages ?? projected, input))
    : finishPrepareStep(pipeline, ctx, steered ?? projected, input);
}

function finishPrepareStep(
  pipeline: StepPipeline,
  ctx: StepPrepareContext,
  steered: ModelMessage[] | undefined,
  input: TurnInput | undefined,
): StepPrepareResult | Promise<StepPrepareResult> {
  const base = steered ?? ctx.messages;

  // The weave runs after pruning (frozen positions refer to the final array); reserve what it adds before pruning,
  // or the request is priced too small.
  const reserved = pipeline.dynamic?.ledger.overheadTokens ?? 0;

  const pruned = pipeline.prune
    ? pruneStepToolOutputs(base, { ...pipeline.prune, reservedTokens: (pipeline.prune.reservedTokens ?? 0) + reserved })
    : undefined;

  const shrunk = pruned ?? base;

  // Always rewrites: a prepareStep override never feeds the next step's input.
  const woven = pipeline.dynamic?.ledger.weave(shrunk, pipeline.dynamic.snapshot(), input, pipeline.dynamic.instructions);

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
