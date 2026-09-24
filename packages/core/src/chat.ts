/** Shared chat engine for server and CLI; returns the full ModelMessage array, tool calls and results included. */

import {
  NoOutputGeneratedError,
  streamText,
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
  type TextPart,
  type ToolCallPart,
  type StepResult,
  type StopCondition,
  type TextStreamPart,
  type TypedToolCall,
  type UIMessageChunk,
  type LanguageModelUsage,
} from 'ai';
import {
  assertToolsSupportedByModel,
  type PromptModelContext,
} from './prompting/model-profile';
import { applyCacheBreakpoints, hasCacheMarkers, type CacheBreakpointPlan } from './prompting/cache-breakpoints';
import type { ResolvedModelWindow } from './prompting/step-prune';
import type { CacheRetention } from './providers/types';
import { TurnContextMeter, type ContextComposition } from './context-meter';
import { composePrepareStep, type StepContextPlane, type StepDynamicContext } from './prompting/prepare-step';
import type { MissionGovernor } from './mission-budget';
import type { AttachmentPolicy } from './prompting/attachment-sanitizer';
import { assembleTurnMessages } from './orchestrator/turn-context';
import { settleUnpairedToolCalls } from './prompting/interrupted-tool-calls';
import { contextWindowForModel } from './context-window';
import type { CountableRequest, InputTokenCount } from './providers/input-tokens';
import { OUTPUT_LIMIT_REACHED } from './orchestrator/turn-lifecycle';
import type { ExtensionHost } from './extension';
import { mergeProviderOptions } from './strategy/effort';
import { describeProviderError, toProviderError } from './providers/util';
import { repairToolCall } from './tools/repair-tool-call';
import { renderToolResult, synthesizeToolFallback } from './prompts/evidence-window';
import * as v from 'valibot';
import { JsonObjectSchema, projectJsonValue, type JsonObject, type JsonValue } from './utils/json';
import { normalizeUsage, usageReported, type Usage } from './usage';
import { PROVIDER_SDK_RETRIES } from './providers/rate-limit-retry';
import { diagnostics, toKinuError } from './obs/index';
import { beginModelOperation, type ModelOperation, type ModelOperationSink } from './events/model-call';
import { failedToolOutcome, successfulToolOutcome, type ToolOutcome } from './tools/outcome';
import { ToolOutcomeSchema } from './types/tool-outcome';

export type ChatEvent =
  | { type: 'text-delta'; delta: string }
  /** Provider reasoning as it streams. Not step output: a step that only thought is a dead stream. */
  | { type: 'reasoning-delta'; delta: string }
  /** The provider's call id, pairing this event with its 'tool-result'; name alone cannot pair concurrent calls. */
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: JsonObject }
  /** `result` is the rendered output or error text; `output` is the returned value projected to JSON, for the
   *  ledger. `durationMs` is absent for a call the SDK never dispatched here. */
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string; output?: JsonValue; error?: string; durationMs?: number } & ToolOutcome)
  /** `usage` is only what the provider reported for this step: absent is not zero. `responseMessages` is the SDK's
   *  cumulative array, carried by reference so a long turn does not re-serialize its transcript per step. */
  | {
    type: 'step-finish'; stepIndex: number; responseMessages: readonly ModelMessage[]; usage?: Usage;
    finishReason?: string;
    /** Read off the SDK step here: its fields are prototype getters a spread would drop. */
    text?: string;
    toolCalls?: ReadonlyArray<{ toolName: string }>;
    toolResults?: ReadonlyArray<unknown>;
    /** The body this step sent and when, so a prompt-cache warm can re-send it byte-identically
     *  (providers/cache-warming.ts). */
    request?: { body?: unknown; sentAt?: number };
    /** The breakdown of the request this step sent, taken when the SDK finished the step and before it
     *  prepares the next one: a reader that lags the model still records each step's own request. */
    context?: ContextComposition;
  }
  /** A failure the turn survived. `runChat` never yields this; the scaffold seam (scaffold/chat-transform.ts) does. */
  | { type: 'error'; message: string }
  /** `text`: the answer, else what streamed, else a tool-result synthesis. `answer`: only the final step's text
   *  ({@link answerFromSteps}), absent when there is none. */
  | { type: 'done'; text: string; responseMessages: ModelMessage[]; answer?: string };

export type ChatToolOutput = Extract<TextStreamPart<ToolSet>, { type: 'tool-result' }>;

/** Which provider call of a turn a relayed stream belongs to: an output-limit continuation is a second SDK stream,
 *  so a relay must renew per-stream state while the answer stays one message. */
export interface ObservedCall {
  readonly index: number;
}

export type ObserveStream = (chunks: ReadableStream<UIMessageChunk>, call: ObservedCall) => Promise<void>;

export interface ChatOptions {
  model: LanguageModel;
  system: string;
  history: ModelMessage[];
  /** Re-read and re-woven at every step, never at turn assembly, so a compaction plugin never sees or persists it. */
  dynamicContext?: StepDynamicContext;
  /** Measure each request, delivered as its `step-finish` event's `context`. */
  measureContext?: boolean;
  /** Durable context plane; absent for unclaimed work (a head's own inference, a shadow-eval replay). */
  stepContext?: StepContextPlane;
  persistStreamPart?: (part: TextStreamPart<ToolSet>) => Promise<void>;
  persistStep?: (messages: readonly ModelMessage[]) => Promise<void>;
  /** Placed right before the turn's input on every step; never seen by a transform or stored. */
  turnLocal?: readonly ModelMessage[];
  tools: ToolSet;
  /** Unsupported history file/media parts are replaced in place before the transform seam; message count never
   *  changes, so downstream indices hold. */
  attachments?: AttachmentPolicy;
  modelContext?: PromptModelContext;
  /** Provider-reported prompt tokens of the previous turn's final request, the measured compaction trigger. */
  providerReportedTokens?: number;
  /** 'force' when the caller consumed an armed force-compaction flag after an overflow. */
  transformTrigger?: 'auto' | 'force';
  /** The provider's own request token count (providers/input-tokens.ts); omitted, the shared estimate gates. */
  countInputTokens?: (request: CountableRequest) => Promise<InputTokenCount>;
  signal?: AbortSignal;
  extensions?: ExtensionHost;
  /** Prompt-cache identity: provider id + stable conversation key. See prompting/cache-breakpoints.ts. */
  cache?: { providerId?: string; modelId?: string; sessionKey: string; retention?: CacheRetention };
  /**
   * A second reader of each call's stream, as the SDK's UIMessage chunks; the SDK tees the stream so neither starves.
   * Called once per provider call; see {@link ObservedCall}.
   */
  observeStream?: ObserveStream;
  providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  /** The subset of `tools` the model may call; the rest stay wired for execution. Absent, all are offered. */
  activeTools?: readonly string[];
  /** A label whose cumulative cap is spent declines the next request. */
  budget?: MissionGovernor;
  /** An extra stop reason; there is no step cap to combine with (see UNBOUNDED_STEPS). */
  stopWhen?: StopCondition<ToolSet>;
  /**
   * Each finished step, raw and awaited: the sink may be an RPC to another DO, and the next request must wait for it.
   * A throw rejects the turn, as from `prepareStep`.
   */
  onStep?: (step: StepResult<ToolSet>) => Promise<void> | void;
  /** Raw SDK output for a host UI bridge; not part of the serializable ChatEvent projection. */
  onToolOutput?: (output: ChatToolOutput) => Promise<void> | void;
  /** Where each model call opens and closes its `model_operation` rows, so a call in flight at process death is
   *  visible to `RunEventRecorder.unterminatedModelOperations`. */
  operations?: ModelOperationSink;
}

/**
 * Never stop: there is no per-turn step bound. The SDK defaults to `stepCountIs(1)`, so an omitted `stopWhen` would
 * end every turn after one step.
 */
export const UNBOUNDED_STEPS: StopCondition<ToolSet> = () => false;

/** Prefixes recorded in durable failure prose by the removed silence watchdog; the classifier below reads them. */
const RATE_LIMITED_TURN_PREFIX = 'Turn ended by provider rate limiting:';

/** Whether a recorded failure is a provider rate limit rather than silence. `includes`, because the reason is
 *  a wrapped chain with the prefix inside it. */
export function isRateLimitedTurnError(message: string): boolean {
  return message.includes(RATE_LIMITED_TURN_PREFIX);
}

/** Thrown after the turn's `done` event, so the interrupted turn's history is kept but recorded as unfinished. */
export const INTERRUPTED_TURN = 'The turn was interrupted before it finished.';

/** One call's frame, closed whichever way it left; never awaited, so the end row lands before `turn_end`. */
function settleModelOperation(
  operation: ModelOperation,
  stream: { totalUsage: PromiseLike<LanguageModelUsage>; response: PromiseLike<{ modelId: string }> },
  cut: boolean,
): void {
  if (cut) {
    operation.failed({ cause: new Error(INTERRUPTED_TURN) });

    return;
  }

  void Promise.all([stream.totalUsage, stream.response]).then(
    ([totalUsage, response]) => operation.completed({
      usage: normalizeUsage(totalUsage),
      modelId: response.modelId,
    }),
    operationRejected(operation),
  );
}

const operationRejected = (operation: ModelOperation) =>
  (...rejection: [unknown]): void => { operation.failed({ cause: rejection[0] }); };

interface AnswerStep {
  readonly text?: string;
  readonly finishReason?: string;
  readonly toolCalls?: ReadonlyArray<unknown>;
}

/**
 * The turn's answer: its final step's text, or null to keep what streamed. Earlier steps' prose is narration.
 * A `length`-cut step without tool calls joins its continuation; an interrupted turn has no answer.
 */
function answerFromSteps(
  steps: readonly AnswerStep[],
  interrupted: boolean,
): string | null {
  if (interrupted || steps.length === 0) return null;
  let from = steps.length - 1;

  while (from > 0 && steps[from - 1]?.finishReason === OUTPUT_LIMIT_REACHED && (steps[from - 1]?.toolCalls?.length ?? 0) === 0) from -= 1;
  const answer = steps.slice(from).map((step) => step.text ?? '').join('');

  return answer.trim() ? answer : null;
}

/** The tool's returned value projected to JSON, or nothing so the rendered text stands in. */
function toolOutput(raw: ChatToolOutput['output']): { output: JsonValue } | undefined {
  return raw === undefined ? undefined : { output: projectJsonValue({ value: raw }) };
}

type PendingStepEvent = Omit<Extract<ChatEvent, { type: 'step-finish' }>, 'type'>;

interface CallOutcome {
  /** The SDK's steps on a natural finish, the `onAbort` handover on a cut. */
  readonly steps: readonly StepResult<ToolSet>[];
  /** Messages the call generated, never the input prefix. */
  readonly produced: ModelMessage[];
  readonly finishReason: string | undefined;
  readonly interrupted: boolean;
}

const DEAD_STREAM = 'Model stream ended without output: the provider stream terminated prematurely '
  + '(no finish reason, no content). The turn did not complete.';

/** One provider call's state, as the SDK's stream drains into it via {@link ProviderCall.consume}. */
class ProviderCall {
  /** Set by `onAbort`, or by the drain when the provider threw the abort reason first. */
  interrupted = false;
  /** An aborted run never settles `result.steps`, so this is a cut call's only record of its steps. */
  recordedSteps: readonly StepResult<ToolSet>[] = [];
  streamError: unknown;
  lastFinishReason: string | undefined;
  /** No finish reason and no output: a provider stream that died, which the SDK would record as a normal stop. */
  private deadFinalStep = false;
  private stepHadOutput = false;
  /** The in-flight step's content: the SDK records only finished steps, so a cut would otherwise lose it. */
  private stepContent: Array<TextPart | ToolCallPart> = [];
  /** Tool execution can start before `fullStream` publishes the call; kept until its step completes so a cut cannot
   *  erase admitted work. */
  private readonly dispatchedCalls = new Map<string, { readonly call: ToolCallPart; readonly startedAt: number }>();
  private responseSoFar: readonly ModelMessage[] = [];
  private readonly pendingStepEvents: PendingStepEvent[] = [];
  /** When the in-flight step's request left, stamped in `prepareStep`: a cache warm counts its TTL from the request's
   *  start (docs/research/harness/anthropic-sources.md §2). */
  private stepSentAt = Date.now();

  requestStarting(): void {
    this.stepSentAt = Date.now();
  }

  dispatched(toolCall: { toolCallId: string; toolName: string; input: unknown }): void {
    this.dispatchedCalls.set(toolCall.toolCallId, { startedAt: Date.now(), call: { type: 'tool-call',
      toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input } });
  }

  aborted(steps: readonly StepResult<ToolSet>[]): void {
    this.recordedSteps = steps;
    this.interrupted = true;
  }

  /** SDK step fields are prototype getters a spread would drop, so they are read off here. */
  stepFinished(step: StepResult<ToolSet>, stepIndex: number, context: ContextComposition | undefined): void {
    this.responseSoFar = [...step.response.messages];

    for (const part of step.content) if (part.type === 'tool-call') this.dispatchedCalls.delete(part.toolCallId);
    const usage = normalizeUsage(step.usage);

    this.pendingStepEvents.push({
      stepIndex, responseMessages: this.responseSoFar,
      finishReason: step.finishReason, text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName })), toolResults: step.toolResults,
      request: { body: step.request.body, sentAt: this.stepSentAt },
      ...(usageReported(usage) && { usage }),
      ...(context && { context }),
    });
  }

  *takeStepEvents(): Generator<ChatEvent> {
    while (this.pendingStepEvents.length > 0) {
      const ev = this.pendingStepEvents.shift();

      if (ev) yield { type: 'step-finish' as const, ...ev };
    }
  }

  consume(chunk: TextStreamPart<ToolSet>): ChatEvent | null {
    switch (chunk.type) {
      case 'text-delta': {
        if (!chunk.text) return null;
        this.stepHadOutput = true;
        this.stepContent.push({ type: 'text', text: chunk.text });

        return { type: 'text-delta', delta: chunk.text };
      }

      case 'reasoning-delta':
        return chunk.text ? { type: 'reasoning-delta', delta: chunk.text } : null;

      case 'tool-call': {
        this.stepHadOutput = true;
        this.stepContent.push({ type: 'tool-call', toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input });

        return { type: 'tool-call', toolName: chunk.toolName, toolCallId: chunk.toolCallId, args: parseToolArgs(chunk.input) };
      }

      case 'tool-result': {
        // Full text, never a slice: it is the durable record and the steering hash identity; displays bound it.
        const raw = chunk.output;

        return {
          type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result: renderToolResult(raw),
          ...toolOutput(raw), ...this.toolDuration(chunk.toolCallId), ...successfulToolOutcome(chunk.toolName, { output: raw }),
        };
      }

      case 'tool-error': {
        // A tool threw: the error text is the durable outcome and the extension seam's result.
        const error = describeProviderError({ cause: chunk.error });

        return {
          type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result: error, error,
          ...this.toolDuration(chunk.toolCallId), ...failedToolOutcome({ cause: chunk.error }),
        };
      }

      case 'finish-step': {
        // No finish reason and no output (reasoning-only included): the provider stream died.
        this.lastFinishReason = chunk.finishReason;
        this.deadFinalStep = !this.stepHadOutput && chunk.finishReason === 'other';
        this.stepHadOutput = false;
        this.stepContent = [];

        return null;
      }

      case 'error':
        this.streamError = chunk.error;

        return null;

      case 'abort':
      case 'file':
      case 'finish':
      case 'raw':
      case 'reasoning-end':
      case 'reasoning-start':
      case 'source':
      case 'start':
      case 'start-step':
      case 'text-end':
      case 'text-start':
      case 'tool-approval-request':
      case 'tool-input-delta':
      case 'tool-input-end':
      case 'tool-input-start':
      case 'tool-output-denied':
        return null;

      // A part this SDK version does not name.
      default:
        return null;
    }
  }

  private toolDuration(toolCallId: string): { durationMs: number } | undefined {
    const dispatched = this.dispatchedCalls.get(toolCallId);

    return dispatched === undefined ? undefined : { durationMs: Date.now() - dispatched.startedAt };
  }

  /**
   * What ends a drained, uncut call, or null when it stands. Provider failures cross classified via `toProviderError`
   * so callers never see a raw `APICallError` body. A dead final step stays a bare throw: the result is rejected.
   */
  failure(opts: Pick<ChatOptions, 'modelContext' | 'cache'>): { readonly cause: unknown; readonly error: Error } | null {
    if (this.interrupted) return null;

    if (this.streamError !== undefined) {
      return {
        cause: this.streamError,
        error: toProviderError({
          doing: 'calling the model',
          cause: this.streamError,
          provider: opts.modelContext?.provider ?? opts.cache?.providerId,
        }),
      };
    }

    if (this.deadFinalStep) return { cause: new Error('model stream ended without output'), error: new Error(DEAD_STREAM) };

    return null;
  }

  /**
   * The messages this call generated. A cut call adds the interrupted step with every dispatched call paired, or
   * every later request from this history would be refused.
   */
  produced(): ModelMessage[] {
    const finished = [...this.responseSoFar];

    if (!this.interrupted) return finished;

    for (const { call } of this.dispatchedCalls.values()) {
      if (!this.stepContent.some((part) => part.type === 'tool-call' && part.toolCallId === call.toolCallId)) this.stepContent.push(call);
    }

    return this.stepContent.length > 0 ? [...finished, { role: 'assistant' as const, content: this.stepContent }] : finished;
  }
}

/**
 * A call that never finishes a step makes the SDK reject its deferred accessors; unread, that is an unhandled
 * rejection. Tolerated for zero steps and cuts; anything else is recorded as a defect.
 */
function suppressDeferredRejections(
  result: { steps: PromiseLike<unknown>; finishReason: PromiseLike<unknown>; rawFinishReason: PromiseLike<unknown>; totalUsage: PromiseLike<unknown> },
  tolerated: () => boolean,
): void {
  const ignore = (error: Error): void => {
    if (NoOutputGeneratedError.isInstance(error) || tolerated()) return;

    diagnostics.failure(
      'llm_call.deferred_rejected',
      toKinuError({ doing: 'settle an unread stream accessor', cause: error, otherwise: 'io' }),
    );
  };

  for (const deferred of [result.steps, result.finishReason, result.rawFinishReason, result.totalUsage]) deferred.then(undefined, ignore);
}

/** The window this turn is admitted against, and its provenance; admission refuses only on a measured window
 *  (orchestrator/turn-context.ts). */
function turnWindow(opts: ChatOptions): ResolvedModelWindow {
  const table = contextWindowForModel(opts.modelContext?.id ?? '');

  return {
    contextWindow: opts.modelContext?.contextWindow ?? table.window,
    windowMeasured: opts.modelContext?.windowMeasured ?? table.measured,
    // An unreported allowance reserves nothing (prompting/step-prune.ts).
    modelOutputLimit: opts.modelContext?.modelOutputLimit ?? null,
  };
}

/** Provider prompt-cache plan; marker strategies re-roll tail breakpoints each step. Pass-through without opts.cache. */
function turnCachePlan(opts: ChatOptions, turnMessages: readonly ModelMessage[]): CacheBreakpointPlan {
  return applyCacheBreakpoints({
    providerId: opts.cache?.providerId,
    modelId: opts.cache?.modelId ?? opts.modelContext?.id,
    system: opts.system,
    messages: turnMessages,
    sessionKey: opts.cache?.sessionKey ?? '',
    retention: opts.cache?.retention,
  });
}

function turnText(streamed: string, steps: readonly StepResult<ToolSet>[], answer: string | null): string {
  let allText = answer ?? streamed;

  if (!allText.trim()) {
    for (const step of steps) {
      if (step.text?.trim()) allText += step.text;
    }
  }

  if (!allText.trim()) {
    const fallback = synthesizeToolFallback(steps);

    if (fallback) allText = fallback;
  }

  return allText;
}

/**
 * Run one chat turn. Callers must append the returned response messages (tool calls and results included) to
 * history. A cut turn yields `done`, then throws {@link INTERRUPTED_TURN}; a dead provider stream throws without
 * `done`.
 */
export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  const extensions = opts.extensions;

  // Extension tools never shadow a caller tool of the same name.
  const tools: ToolSet = extensions ? { ...extensions.tools(), ...opts.tools } : opts.tools;
  assertToolsSupportedByModel(opts.modelContext, Object.keys(tools));

  const modelSpec = opts.modelContext?.id;

  let stepCount = 0;
  const window = turnWindow(opts);
  const { contextWindow, modelOutputLimit } = window;

  // Shared turn-context assembly (orchestrator/turn-context.ts); cf's beforeTurn runs the same function.
  const assembly: Parameters<typeof assembleTurnMessages>[0] = {
    system: opts.system,
    history: opts.history,
    attachments: opts.attachments,
    extensions,
    sessionKey: opts.cache?.sessionKey ?? '',
    contextWindow,
    providerReportedTokens: opts.providerReportedTokens,
    trigger: opts.transformTrigger ?? 'auto',
    abortSignal: opts.signal,
  };

  // Pre-submission admission; turn-context.ts owns the policy. The tools riding every request are measured too.
  assembly.admission = {
    count: opts.countInputTokens,
    tools,
    turnLocal: opts.turnLocal,
    limits: window,
  };

  const stepContext = opts.stepContext;
  const initialContext = stepContext === undefined ? null : await stepContext.base();

  // The turn-local messages ride right before the turn's input on every step, so the request stays the last
  // user-role content and each step's prefix is the last one's.
  const { messages: turnMessages, turnStart } = await assembleTurnMessages({
    ...assembly, history: initialContext?.messages ?? assembly.history, turnStart: initialContext?.turnStart,
  });

  let initialContextAvailable = initialContext !== null;

  const stepContextPlane: StepContextPlane | undefined = stepContext === undefined ? undefined : {
    base: async () => {
      if (initialContextAvailable) {
        initialContextAvailable = false;

        return { messages: turnMessages, changed: initialContext?.changed ?? false, turnStart };
      }

      const base = await stepContext.base();
      const assembled = await assembleTurnMessages({ ...assembly, history: base.messages, turnStart: base.turnStart, admission: undefined });

      return { ...assembled, changed: base.changed };
    },
    consume: step => stepContext.consume(step),
  };

  const turnLocal = opts.turnLocal !== undefined && opts.turnLocal.length > 0 ? opts.turnLocal : undefined;

  const cache = turnCachePlan(opts, turnMessages);
  const rollTail = hasCacheMarkers(cache.strategy);
  const providerOptions = mergeProviderOptions(cache.providerOptions, opts.providerOptions);

  const meter = opts.measureContext === true ? new TurnContextMeter({ system: cache.system, tools }) : undefined;

  /** What the turn streamed across all its calls; the answer is narrower. */
  let allText = '';

  /** One decision per turn; the SDK ignores a name the set does not carry. */
  const offeredTools: { activeTools?: Array<keyof ToolSet> } = opts.activeTools === undefined
    ? {}
    : { activeTools: [...opts.activeTools] };

  const announce = async (event: ChatEvent, chunk: TextStreamPart<ToolSet>): Promise<void> => {
    if (event.type === 'tool-call') {
      await extensions?.emitToolCall({ toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });

      return;
    }

    if (event.type !== 'tool-result' || (chunk.type !== 'tool-result' && chunk.type !== 'tool-error')) return;

    if (chunk.type === 'tool-result') await opts.onToolOutput?.(chunk);

    await extensions?.emitToolResult({
      toolName: event.toolName, toolCallId: event.toolCallId, args: parseToolArgs(chunk.input), result: event.result,
      ...v.parse(ToolOutcomeSchema, event),
    });
  };

  /**
   * One provider call. A closure because an output-limit continuation is a second call in the same turn.
   * `stepOffset` keeps step numbering the turn's, or the injection ledger (prompting/step-injections.ts) would
   * misplace steer messages.
   */
  const callModel = async function* (
    request: readonly ModelMessage[],
    stepOffset: number,
    callIndex: number,
  ): AsyncGenerator<ChatEvent, CallOutcome> {
    // One operation frame per provider call; a continuation opens a second frame.
    const operation = beginModelOperation(
      { source: 'agent', operations: opts.operations },
      'stream',
      { spec: modelSpec },
    );

    const call = new ProviderCall();

    const result = streamText({
      model: opts.model,
      system: cache.system,
      // Ours, not the vendor's default: see PROVIDER_SDK_RETRIES.
      maxRetries: PROVIDER_SDK_RETRIES,
      messages: [...request],
      tools,
      ...offeredTools,
      // No step cap; see UNBOUNDED_STEPS.
      stopWhen: opts.stopWhen ?? UNBOUNDED_STEPS,
      // Settled rewrites only (name case, fenced or double-encoded args); otherwise the model retries.
      experimental_repairToolCall: repairToolCall(),
      abortSignal: opts.signal,
      // The SDK default console.error dumped raw provider payloads; the rethrow below is the one place failures read.
      onError: ({ error }) => { call.streamError = error; },
      experimental_onToolCallStart: ({ toolCall }) => { call.dispatched(toolCall); },
      // The only terminal handover: an aborted run never settles `result.steps`.
      onAbort: ({ steps }) => { call.aborted(steps); },
      providerOptions,
      // Shared step pipeline, as Think's beforeStep composes it. Also stamps the request start
      // (`ProviderCall.requestStarting`).
      prepareStep: ({ stepNumber, messages, steps }) => {
        call.requestStarting();

        return composePrepareStep({
          extensions,
          abortSignal: opts.signal,
          cache: rollTail ? { strategy: cache.strategy } : null,
          prune: { contextWindow, modelOutputLimit },
          budget: opts.budget,
          dynamic: opts.dynamicContext,
          destinationProviderId: opts.cache?.providerId,
          meter,
          context: stepContextPlane,
          turnLocal,
          turnStart,
        }, { stepNumber: stepOffset + stepNumber, messages, steps });
      },
      experimental_transform: () => new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
        async transform(part, controller) {
          await opts.persistStreamPart?.(part);
          controller.enqueue(part);
        },
      }),
      onStepFinish: async (step) => {
        stepCount++;
        await opts.persistStep?.(step.response.messages);
        call.stepFinished(step, stepCount, meter?.take());
        await opts.onStep?.(step);
      },
    });

    suppressDeferredRejections(result, () => call.interrupted || (opts.signal?.aborted ?? false));
    // Started before this loop so the tee is taken before any chunk flows; awaited in the tail.
    const observed = opts.observeStream?.(result.toUIMessageStream({ onError: (error) => describeProviderError({ cause: error }) }), { index: callIndex });

    try {
      // Drained to the SDK's `abort` part rather than broken out of: `onAbort` has then run, and a late tool result
      // still reaches the surfaces.
      for await (const chunk of result.fullStream) {
        const event = call.consume(chunk);

        if (event !== null) {
          if (event.type === 'text-delta') allText += event.delta;
          await announce(event, chunk);
          yield event;
        }

        yield* call.takeStepEvents();
      }
    } catch (err) {
      // The signal is authoritative: a provider may throw its abort reason before `onAbort` runs.
      if (!opts.signal?.aborted) {
        operation.failed({ cause: err });
        throw err;
      }

      call.interrupted = true;
    } finally {
      // Drained to its end before the turn settles, so the persisted answer is not short of what the client saw.
      await observed;
    }

    const failure = call.failure(opts);

    if (failure !== null) {
      operation.failed({ cause: failure.cause });
      throw failure.error;
    }

    // A cut run never settles `result.response`/`result.steps`; read what `onAbort` handed over.
    const cut = call.interrupted;

    settleModelOperation(operation, result, cut);
    const steps = cut ? call.recordedSteps : await result.steps;
    const produced = call.produced();
    const paired = settleUnpairedToolCalls(produced) ?? produced;

    if (cut) await opts.persistStep?.(paired);

    return {
      steps,
      produced: paired,
      finishReason: call.lastFinishReason,
      interrupted: cut,
    };
  };

  const first = yield* callModel(cache.messages, 0, 0);
  let steps: readonly StepResult<ToolSet>[] = first.steps;
  let responseMessages: ModelMessage[] = first.produced;
  let interrupted = first.interrupted;

  // One output-limit continuation: the SDK does not continue a `length` finish with no pending call. The request is
  // the same prefix plus everything produced, so nothing is replayed. A second `length` finish is partial completion.
  if (!interrupted && first.finishReason === OUTPUT_LIMIT_REACHED) {
    const continued = yield* callModel([...cache.messages, ...first.produced], first.steps.length, 1);
    steps = [...steps, ...continued.steps];
    responseMessages = [...responseMessages, ...continued.produced];
    interrupted = continued.interrupted;
  }

  const answer = answerFromSteps(steps, interrupted);
  const text = turnText(allText, steps, answer);

  await extensions?.emitTurnEnd({ text, responseMessages });
  yield { type: 'done', text, responseMessages, ...(answer !== null && { answer }) };

  // Thrown only after `done`, so the history is kept.
  if (interrupted) throw new Error(INTERRUPTED_TURN);
}

function parseToolArgs(raw: TypedToolCall<ToolSet>['input']): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, raw);

  return parsed.success ? parsed.output : {};
}
