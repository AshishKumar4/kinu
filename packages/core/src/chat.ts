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
import { applyCacheBreakpoints, hasCacheMarkers, type CacheBreakpointPlan, type PromptCacheRoute } from './prompting/cache-breakpoints';
import { DEFAULT_CACHE_RETENTION, type CacheRetention } from './providers/types';
import { TurnContextMeter, type ContextComposition } from './context-meter';
import { composePrepareStep, type StepContextPlane, type StepDynamicContext } from './prompting/prepare-step';
import type { MissionGovernor } from './mission-budget';
import type { AttachmentPolicy } from './prompting/attachment-sanitizer';
import { assembleTurnMessages } from './orchestrator/turn-context';
import { settleUnpairedToolCalls } from './prompting/interrupted-tool-calls';
import { contextWindowForModel, type ResolvedModelWindow } from './context-window';
import type { CountableRequest, InputTokenCount } from './providers/input-tokens';
import { OUTPUT_LIMIT_REACHED } from './orchestrator/turn-lifecycle';
import type { ExtensionHost } from './extension';
import { mergeProviderOptions } from './providers/effort';
import { describeProviderError, providerFailureFacts, toProviderError } from './providers/util';
import { repairToolCall } from './tools/repair-tool-call';
import { renderToolResult, synthesizeToolFallback } from './utils/evidence-window';
import * as v from 'valibot';
import { JsonObjectSchema, projectJsonValue, type JsonObject, type JsonValue } from './utils/json';
import { normalizeUsage, usageReported, type Usage } from './usage';
import { PROVIDER_SDK_RETRIES, RATE_LIMIT_HANDOVER_HEADER } from './providers/rate-limit-retry';
import { callAccountOf, type CallAccount } from './providers/quota';
import { classifyErrorCode, diagnostics, toKinuError } from './obs/index';
import { beginModelOperation, type ModelOperation, type ModelOperationSink } from './events/model-call';
import { failedToolOutcome, successfulToolOutcome, type ToolOutcome } from './tools/outcome';
import { invalidToolCallRefusal } from './tools/tool-schema';
import { ToolOutcomeSchema } from './types/tool-outcome';

export type ChatEvent =
  | { type: 'text-delta'; delta: string }
  /** Provider reasoning as it streams. Not step output: a step that only thought is a dead stream. */
  | { type: 'reasoning-delta'; delta: string }
  /** The provider's call id, pairing this event with its 'tool-result'; name alone cannot pair concurrent calls. */
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: JsonObject }
  /** `result`: the rendered output or error; `output`: the value as JSON, for the ledger. `durationMs` is absent for
   *  a call the SDK never dispatched here. */
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string; output?: JsonValue; error?: string; durationMs?: number } & ToolOutcome)
  /** `usage` is what the provider reported for this step; absent is not zero. `responseMessages` is the SDK's
   *  cumulative array by reference, so a long turn does not re-serialize its transcript per step. */
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
    account?: CallAccount;
    /** The request this step sent, taken when the SDK finished it and before the next, so a lagging reader still
     *  records each step's own request. */
    context?: ContextComposition;
    /** The fallback spec that served the step; absent for the turn's own model. */
    fallback?: string;
    /** The provider's model id for the step, when reported. */
    modelId?: string;
  }
  /** A failure the turn survived. `runChat` never yields this; the scaffold seam (scaffold/chat-transform.ts) does. */
  | { type: 'error'; message: string }
  | { type: 'model-fallback'; from: string; to: string; reason: string }
  /** `text`: the answer, else what streamed, else a tool-result synthesis. `answer`: only the final step's text
   *  ({@link answerFromSteps}), absent when there is none. */
  | { type: 'done'; text: string; responseMessages: ModelMessage[]; answer?: string };

export type ChatToolOutput = Extract<TextStreamPart<ToolSet>, { type: 'tool-result' }>;

/** Which provider call of a turn a relayed stream belongs to: a continuation or fallback is another SDK stream. */
export interface ObservedCall {
  readonly index: number;
}

export type ObserveStream = (chunks: ReadableStream<UIMessageChunk>, call: ObservedCall) => Promise<void>;

export interface ChatFallback {
  readonly spec: string;
  readonly bind: () => {
    readonly model: LanguageModel;
    readonly provider: string;
    readonly providerOptions?: ChatOptions['providerOptions'];
  };
}

export interface ChatOptions {
  model: LanguageModel;
  fallbacks?: readonly ChatFallback[];
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
  tools: ToolSet;
  /** Unsupported history file/media parts are replaced in place before the transform seam; message count never
   *  changes, so downstream indices hold. */
  attachments?: AttachmentPolicy;
  modelContext?: PromptModelContext;
  /** The turn model's spec, normalized as its fallbacks' are. */
  modelSpec?: string;
  /** A spec's stored credential; a 401 skips entries holding the refused one. */
  credentialOf?: (spec: string) => Promise<string | null>;
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
  /** A second reader of each call's stream as UIMessage chunks (the SDK tees it), once per call; {@link ObservedCall}. */
  observeStream?: ObserveStream;
  providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  /** The subset of `tools` the model may call; the rest stay wired for execution. Absent, all are offered. */
  activeTools?: readonly string[];
  /** A label whose cumulative cap is spent declines the next request. */
  budget?: MissionGovernor;
  /** An extra stop reason; there is no step cap to combine with (see UNBOUNDED_STEPS). */
  stopWhen?: StopCondition<ToolSet>;
  /** Each finished step, raw and awaited, since the sink may be another DO the next request waits for; a throw rejects
   *  the turn. */
  onStep?: (step: StepResult<ToolSet>) => Promise<void> | void;
  /** Raw SDK output for a host UI bridge; not part of the serializable ChatEvent projection. */
  onToolOutput?: (output: ChatToolOutput) => Promise<void> | void;
  /** Where each call opens and closes its `model_operation` rows, so one in flight at process death shows in
   *  `RunEventRecorder.unterminatedModelOperations`. */
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

/** The final step's text, or null to keep what streamed (earlier prose is narration); a toolless `length`-cut step
 *  joins its continuation. */
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

interface CallFailure {
  readonly cause: unknown;
  readonly error: Error;
  /** The failing step had streamed text or started a tool. */
  readonly streamed: boolean;
}

interface CallOutcome {
  /** The SDK's steps on a natural finish, the `onAbort` handover on a cut. */
  readonly steps: readonly StepResult<ToolSet>[];
  /** Messages the call generated, never the input prefix. */
  readonly produced: ModelMessage[];
  readonly finishReason: string | undefined;
  readonly interrupted: boolean;
  readonly failure: CallFailure | null;
}

/** A fallback takes a call that failed before streaming for a provider or account failure; a malformed or
 *  too-large request fails the turn. */
function handsOver(failure: CallFailure): boolean {
  if (failure.streamed) return false;
  const { status } = providerFailureFacts({ cause: failure.cause });

  if (status !== undefined) return [401, 402, 403, 404, 408, 429].includes(status) || status >= 500;
  const code = classifyErrorCode({ cause: failure.error });

  return code === null || code === 'unavailable' || code === 'timeout' || code === 'budget';
}

/** A failed lookup is logged and unknown: it skips nothing. */
async function credentialOrUnknown(credentialOf: (spec: string) => Promise<string | null>, spec: string): Promise<string | null> {
  const found = await credentialOf(spec).then(
    (key) => ({ key }),
    (...rejection: [unknown]) => ({ failed: toKinuError({ doing: 'look up a fallback\'s credential', cause: rejection[0], otherwise: 'io' }) }),
  );

  if ('key' in found) return found.key;
  diagnostics.failure('llm_call.fallback_credential_unknown', found.failed, { spec });

  return null;
}

/** A 401 refuses the credential, so entries holding it are passed over; a 403 may be model-scoped. */
async function nextFallback(
  chain: ChatFallback[], failed: string | undefined, failure: CallFailure, credentialOf: ChatOptions['credentialOf'],
): Promise<ChatFallback | undefined> {
  if (!handsOver(failure)) return undefined;
  const { status } = providerFailureFacts({ cause: failure.cause });
  const lookup = status === 401 && failed !== undefined ? credentialOf : undefined;
  const refused = lookup !== undefined && failed !== undefined ? await credentialOrUnknown(lookup, failed) : null;

  for (let next = chain.shift(); next !== undefined; next = chain.shift()) {
    if (refused === null || lookup === undefined || await credentialOrUnknown(lookup, next.spec) !== refused) return next;
  }

  return undefined;
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
  /** Whether the step the error cut had streamed, read on arrival: the step's end clears it. */
  private streamedBeforeError = false;
  lastFinishReason: string | undefined;
  /** No finish reason and no output: a provider stream that died, which the SDK would record as a normal stop. */
  private deadFinalStep = false;
  private stepHadOutput = false;
  /** The in-flight step's content: the SDK records only finished steps, so a cut would otherwise lose it. */
  private stepContent: Array<TextPart | ToolCallPart> = [];

  /** Schema-refused calls, until their tool-error arrives. */
  private readonly refusedCalls = new Map<string, Error>();
  /** A call can run before `fullStream` publishes it; kept until its step completes so a cut keeps admitted work. */
  private readonly dispatchedCalls = new Map<string, { readonly call: ToolCallPart; readonly startedAt: number }>();
  private responseSoFar: readonly ModelMessage[] = [];
  readonly finishedSteps: StepResult<ToolSet>[] = [];
  private readonly pendingStepEvents: PendingStepEvent[] = [];
  /** When the step's request left (`prepareStep`): a cache warm counts its TTL from there
   *  (docs/research/harness/anthropic-sources.md §2). */
  private stepSentAt = Date.now();
  /** A finished step whose record or hook failed; the SDK drops a step-callback throw (ai 6.0.214 `notify`). */
  stepFailure: { readonly doing: string; readonly cause: unknown } | null = null;

  constructor(private readonly fallback: string | undefined) {}

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
    this.finishedSteps.push(step);
    this.responseSoFar = [...step.response.messages];

    for (const part of step.content) if (part.type === 'tool-call') this.dispatchedCalls.delete(part.toolCallId);
    const usage = normalizeUsage(step.usage);
    const account = callAccountOf(step.response);
    const { modelId } = step.response;

    this.pendingStepEvents.push({
      stepIndex, responseMessages: this.responseSoFar,
      finishReason: step.finishReason, text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName })), toolResults: step.toolResults,
      request: { body: step.request.body, sentAt: this.stepSentAt },
      ...(usageReported(usage) && { usage }),
      ...(account !== undefined && { account }),
      ...(context && { context }),
      ...(this.fallback !== undefined && { fallback: this.fallback }),
      ...(modelId !== '' && { modelId }),
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
        const refusal = invalidToolCallRefusal(chunk);

        if (refusal !== undefined) this.refusedCalls.set(chunk.toolCallId, refusal);

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
        // A tool threw or its schema refused: the error text is the durable outcome and the seam's result.
        const cause = this.refusedCalls.get(chunk.toolCallId) ?? chunk.error;
        this.refusedCalls.delete(chunk.toolCallId);
        const error = describeProviderError({ cause });

        return {
          type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result: error, error,
          ...this.toolDuration(chunk.toolCallId), ...failedToolOutcome({ cause }),
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
        this.streamedBeforeError = this.stepContent.length > 0 || this.dispatchedCalls.size > 0;

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

  /** What ends a drained, uncut call, or null. Provider failures cross as `toProviderError` classifies them, never a
   *  raw `APICallError` body; a dead final step stays a bare throw. */
  failure(provider: string | undefined): CallFailure | null {
    if (this.interrupted) return null;

    if (this.streamError !== undefined) {
      return {
        cause: this.streamError, streamed: this.streamedBeforeError,
        error: toProviderError({ doing: 'calling the model', cause: this.streamError, provider }),
      };
    }

    if (this.deadFinalStep) return { cause: new Error('model stream ended without output'), error: new Error(DEAD_STREAM), streamed: false };

    return null;
  }

  /** The messages this call generated; a cut or failed call's unfinished step keeps every dispatched call paired, or
   *  every later request from this history is refused. */
  produced(): ModelMessage[] {
    const finished = [...this.responseSoFar];

    if (!this.interrupted && this.streamError === undefined) return finished;

    for (const { call } of this.dispatchedCalls.values()) {
      if (!this.stepContent.some((part) => part.type === 'tool-call' && part.toolCallId === call.toolCallId)) this.stepContent.push(call);
    }

    return this.stepContent.length > 0 ? [...finished, { role: 'assistant' as const, content: this.stepContent }] : finished;
  }
}

/** A call that finishes no step rejects the SDK's deferred accessors, unhandled if unread: tolerated for zero steps
 *  and cuts, anything else recorded as a defect. */
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

/** One chat turn; callers append its response messages to history. A cut turn yields `done`, then throws
 *  {@link INTERRUPTED_TURN}; a dead provider stream throws without `done`. */
export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  const extensions = opts.extensions;

  // Extension tools never shadow a caller tool of the same name.
  const tools: ToolSet = extensions ? { ...extensions.tools(), ...opts.tools } : opts.tools;
  assertToolsSupportedByModel(opts.modelContext, Object.keys(tools));

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
    instructions: opts.dynamicContext?.instructions,
    limits: window,
  };

  const stepContext = opts.stepContext;
  const initialContext = stepContext === undefined ? null : await stepContext.base();

  // Blocks born at the turn's first step ride right before its input, so the request stays the last user-role
  // content.
  const { messages: turnMessages, turnStart } = await assembleTurnMessages({
    ...assembly, history: initialContext?.messages ?? assembly.history, turnStart: initialContext?.turnStart,
  });

  let initialContextAvailable = initialContext !== null;

  const turnRoute: PromptCacheRoute = {
    ...(opts.cache?.providerId !== undefined && { providerId: opts.cache.providerId }),
    ...(opts.cache?.modelId !== undefined && { modelId: opts.cache.modelId }),
    retention: opts.cache?.retention ?? DEFAULT_CACHE_RETENTION,
  };

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
    // A fallback's cache is its own provider's.
    consume: step => stepContext.consume({ ...step, cache: servingFallback === undefined ? turnRoute : {
      ...(current.provider !== undefined && { providerId: current.provider }), retention: turnRoute.retention,
    } }),
  };

  const cache = turnCachePlan(opts, turnMessages);
  const rollTail = hasCacheMarkers(cache.strategy);

  let current = {
    spec: opts.modelSpec ?? opts.modelContext?.id ?? 'the turn model',
    provider: opts.modelContext?.provider ?? opts.cache?.providerId,
    model: opts.model,
    providerOptions: mergeProviderOptions(cache.providerOptions, opts.providerOptions),
  };

  const chain = [...(opts.fallbacks ?? [])];
  /** The fallback serving the turn, once one took over. */
  let servingFallback: string | undefined;
  let calls = 0;

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

  /** One provider call; a continuation or fallback is another. `stepOffset` keeps the turn's step numbers, by which
   *  prompting/step-injections.ts places steers. */
  const callModel = async function* (
    request: readonly ModelMessage[],
    stepOffset: number,
  ): AsyncGenerator<ChatEvent, CallOutcome> {
    const callIndex = calls++;

    const operation = beginModelOperation(
      { source: 'agent', operations: opts.operations },
      'stream',
      { spec: current.spec },
    );

    const call = new ProviderCall(servingFallback);

    const result = streamText({
      model: current.model,
      system: cache.system,
      // Ours, not the vendor's default: see PROVIDER_SDK_RETRIES.
      maxRetries: PROVIDER_SDK_RETRIES,
      messages: [...request],
      tools,
      ...offeredTools,
      stopWhen: [opts.stopWhen ?? UNBOUNDED_STEPS, () => call.stepFailure !== null],
      // Settled rewrites only (name case, fenced or double-encoded args); otherwise the model retries.
      experimental_repairToolCall: repairToolCall(),
      abortSignal: opts.signal,
      ...(chain.length > 0 && { headers: { [RATE_LIMIT_HANDOVER_HEADER]: '1' } }),
      // The SDK default console.error dumped raw provider payloads; the rethrow below is the one place failures read.
      onError: ({ error }) => { call.streamError = error; },
      experimental_onToolCallStart: ({ toolCall }) => { call.dispatched(toolCall); },
      // The only terminal handover: an aborted run never settles `result.steps`.
      onAbort: ({ steps }) => { call.aborted(steps); },
      providerOptions: current.providerOptions,
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
        try {
          stepCount++;
          await opts.persistStep?.(step.response.messages);
          call.stepFinished(step, stepCount, meter?.take());
        } catch (cause) {
          call.stepFailure ??= { doing: 'recording a finished model step', cause };
        }

        if (call.stepFailure !== null) return;

        try {
          await opts.onStep?.(step);
        } catch (cause) {
          call.stepFailure ??= { doing: 'run the step hook', cause };
        }
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

    if (call.stepFailure !== null) {
      const failed = toKinuError({ doing: call.stepFailure.doing, cause: call.stepFailure.cause, otherwise: 'io' });
      operation.failed({ cause: failed });
      throw failed;
    }

    const failure = call.failure(current.provider);
    const produced = call.produced();
    const paired = settleUnpairedToolCalls(produced) ?? produced;

    if (failure !== null) {
      operation.failed({ cause: failure.cause });

      return { steps: call.finishedSteps, produced: paired, finishReason: undefined, interrupted: false, failure };
    }

    // A cut run never settles `result.response`/`result.steps`; read what `onAbort` handed over.
    const cut = call.interrupted;

    settleModelOperation(operation, result, cut);
    const steps = cut ? call.recordedSteps : await result.steps;

    if (cut) await opts.persistStep?.(paired);

    return {
      steps,
      produced: paired,
      finishReason: call.lastFinishReason,
      interrupted: cut,
      failure: null,
    };
  };

  const callChain = async function* (
    request: readonly ModelMessage[],
    stepOffset: number,
  ): AsyncGenerator<ChatEvent, CallOutcome> {
    const outcome = yield* callModel(request, stepOffset);

    if (outcome.failure === null) return outcome;
    const next = await nextFallback(chain, servingFallback ?? opts.modelSpec, outcome.failure, opts.credentialOf);

    if (next === undefined) throw outcome.failure.error;
    yield { type: 'model-fallback', from: current.spec, to: next.spec, reason: describeProviderError({ cause: outcome.failure.cause }) };
    await opts.persistStep?.(outcome.produced);

    const bound = next.bind();
    current = { ...bound, spec: next.spec, providerOptions: mergeProviderOptions(cache.providerOptions, bound.providerOptions) };
    servingFallback = next.spec;

    const rest = yield* callChain([...request, ...outcome.produced], stepOffset + outcome.steps.length);

    return { ...rest, steps: [...outcome.steps, ...rest.steps], produced: [...outcome.produced, ...rest.produced] };
  };

  const first = yield* callChain(cache.messages, 0);
  let steps: readonly StepResult<ToolSet>[] = first.steps;
  let responseMessages: ModelMessage[] = first.produced;
  let interrupted = first.interrupted;

  // One output-limit continuation: the SDK does not continue a `length` finish with no pending call. The request is
  // the same prefix plus everything produced, so nothing is replayed. A second `length` finish is partial completion.
  if (!interrupted && first.finishReason === OUTPUT_LIMIT_REACHED) {
    const continued = yield* callChain([...cache.messages, ...first.produced], first.steps.length);
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
