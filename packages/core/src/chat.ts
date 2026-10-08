/** Shared chat engine for server and CLI; returns the full ModelMessage array, tool calls and results included. */

import { withToolResultImages } from './providers/tool-result-images';
import {
  APICallError,
  InvalidResponseDataError,
  isLoopFinished,
  NoOutputGeneratedError,
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
  type TextPart,
  type ToolCallPart,
  type PrepareStepResult,
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
import { DEFAULT_CACHE_RETENTION, parseModelSpec, type CacheRetention } from './providers/types';
import { TurnContextMeter, type ContextComposition } from './context-meter';
import { composePrepareStep, type StepContextPlane, type StepDynamicContext } from './prompting/prepare-step';
import { ReplayProgress } from './prompting/replay-normalization';
import { modelStepMessages } from './prompting/tool-error-feedback';
import type { SpendGate } from './mission-budget';
import { sanitizeAttachmentsForModel, type AttachmentPolicy, type MediaModality } from './prompting/attachment-sanitizer';
import { messageTokens } from './prompting/media-tokens';
import { assembleTurnMessages } from './orchestrator/turn-context';
import { settleUnpairedToolCalls } from './prompting/interrupted-tool-calls';
import type { LostToolCall } from './tools/effect-claim';
import { modelWindow, type ModelWindow } from './context-window';
import type { CountableRequest, InputTokenCount } from './providers/input-tokens';
import { OUTPUT_LIMIT_REACHED } from './orchestrator/turn-lifecycle';
import type { CompactionTrigger, ExtensionHost } from './extension';
import { mergeProviderOptions } from './providers/effort';
import { compactionTriggerOptions, isServerCompaction, serverCompactionOptions, serverCompactor, sinceLatestCompaction } from './providers/server-compaction';
import { describeProviderError, toProviderError } from './providers/util';
import { repairToolCall } from './tools/repair-tool-call';
import { renderToolResult, synthesizeToolFallback } from './utils/evidence-window';
import * as v from 'valibot';
import { JsonObjectSchema, projectJsonValue, type JsonObject, type JsonValue } from './utils/json';
import { answeredPromptTokens, normalizeUsage, usageReported, type Usage } from './usage';
import { callRetries } from './providers/middleware/retry';
import type { FallbackCooldowns } from './providers/fallback-cooldown';
import { FallbackRoute, type CallFailure } from './providers/fallback-route';
import { callAccountOf, type CallAccount } from './providers/quota';
import { EGRESS_ROUTE_HEADER } from './execution/device-relay';
import { diagnostics, renderThrownChain, toKinuError, type TurnTrace } from './obs/index';
import { beginModelOperation, type ModelOperation, type ModelOperationSink } from './events/model-call';
import { failedToolOutcome, successfulToolOutcome, type ToolOutcome } from './tools/outcome';
import { invalidToolCallRefusal, withStableSchemas } from './tools/tool-schema';
import { ToolOutcomeSchema } from './types/tool-outcome';
import { StepSpans, traceTools } from './turn-trace';

export type ChatEvent = (
  | { type: 'text-delta'; delta: string }
  /** Provider reasoning as it streams. Not step output: a step that only thought is a dead stream. */
  | { type: 'reasoning-delta'; delta: string }
  /** The provider's call id, pairing this event with its 'tool-result'; name alone cannot pair concurrent calls. */
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: JsonObject }
  /** `result`: the rendered output or error; `output`: the value as JSON, for the ledger. `durationMs` is absent for
   *  a call the SDK never dispatched here. */
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string; output?: JsonValue; error?: string; durationMs?: number } & ToolOutcome)
  /** Cumulative turn outputs; an absent usage field is not zero. */
  | {
    type: 'step-finish'; stepIndex: number; responseMessages: readonly ModelMessage[]; usage?: Usage;
    /** Where the step's one request sampled more than once (`answeredPromptTokens`): the prompt it answered from. */
    promptTokens?: number;
    finishReason?: string;
    text?: string;
    toolCalls?: ReadonlyArray<{ toolName: string }>;
    toolResults?: ReadonlyArray<unknown>;
    /** The body this step sent and when, so a prompt-cache warm can re-send it byte-identically
     *  (providers/cache-warming.ts). */
    request?: { body?: unknown; sentAt?: number };
    account?: CallAccount;
    egress?: string;
    /** The request this step sent, taken when the SDK finished it and before the next, so a lagging reader still
     *  records each step's own request. */
    context?: ContextComposition;
    /** The fallback spec that served the step; absent for the turn's own model. */
    fallback?: string;
    modelId?: string;
  }
  /** A failure the turn survived. `runChat` never yields this; the scaffold seam (scaffold/chat-transform.ts) does. */
  | { type: 'error'; message: string }
  | { type: 'model-fallback'; from: string; to: string; reason: string }
  | { type: 'context-admitted'; tokens: number; contextWindow: number | null }
  /** `text`: the answer, else what streamed, else a tool-result synthesis. `answer`: only the final step's text
   *  ({@link answerFromSteps}), absent when there is none. */
  | { type: 'done'; text: string; responseMessages: ModelMessage[]; answer?: string }
) & { source?: 'native' | 'scaffold' };

export type ChatToolOutput = Extract<TextStreamPart<ToolSet>, { type: 'tool-result' }>;

export type ObserveStream = (chunks: ReadableStream<UIMessageChunk>) => Promise<void>;

export interface ChatFallback {
  readonly spec: string;
  /** The media this model takes, so a tool result's image reaches it or leaves a note (`tool-result-images.ts`). */
  readonly accepts: ReadonlySet<MediaModality>;
  /** Its own catalog window, which its attempt is assembled and compacted against. */
  readonly window: ModelWindow;
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
  lostToolCall?: (call: { readonly toolCallId: string; readonly toolName: string }) => LostToolCall | null;
  /** Re-read and re-woven at every step, never at turn assembly, so a compaction plugin never sees or persists it. */
  dynamicContext?: StepDynamicContext;
  /** Measure each request, delivered as its `step-finish` event's `context`. */
  measureContext?: boolean;
  /** Durable context plane; absent for unclaimed work (a head's own inference, a shadow-eval replay). */
  stepContext?: StepContextPlane;
  persistStreamPart?: (part: TextStreamPart<ToolSet>) => Promise<void>;
  persistStep?: (record: StepRecord) => Promise<void>;
  tools: ToolSet;
  /** Unsupported history file/media parts are replaced in place before the transform seam; message count never
   *  changes, so downstream indices hold. */
  attachments?: AttachmentPolicy;
  modelContext?: PromptModelContext;
  /** The turn model's spec, normalized as its fallbacks' are. */
  modelSpec: string;
  /** A spec's stored credential; a 401 skips entries holding the refused one. */
  credentialOf?: (spec: string) => Promise<string | null>;
  retries?: number;
  cooldowns?: FallbackCooldowns;
  /** Provider-reported prompt tokens of the previous turn's final request, the measured compaction trigger. */
  providerReportedTokens?: number;
  transformTrigger?: CompactionTrigger;
  /** The provider's own request token count (providers/input-tokens.ts); omitted, the shared estimate gates. */
  countInputTokens?: (request: CountableRequest) => Promise<InputTokenCount>;
  signal?: AbortSignal;
  extensions?: ExtensionHost;
  /** The conversation extensions keep their state under (compaction's plans and archives). */
  conversationKey?: string;
  /** The provider and model the prompt cache is planned for (prompting/cache-breakpoints.ts). */
  cache?: { providerId?: string; modelId?: string; retention?: CacheRetention };
  /** A second reader of each call's stream as UIMessage chunks (the SDK tees it), once per call. */
  observeStream?: ObserveStream;
  providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  /** The subset of `tools` the model may call; the rest stay wired for execution. Absent, all are offered. */
  activeTools?: readonly string[];
  /** A label whose cumulative cap is spent declines the next request. */
  budget?: SpendGate;
  /** An extra stop reason. Absent, no step cap: `streamText`'s own default is `isStepCount(1)`. */
  stopWhen?: StopCondition<ToolSet>;
  /** Each finished step, raw and as its own recorded messages, awaited, since the sink may be another DO the next request
   *  waits for; a throw rejects the turn. */
  onStep?: (step: StepResult<ToolSet>, messages: readonly ModelMessage[]) => Promise<void> | void;
  /** Raw SDK output for a host UI bridge; not part of the serializable ChatEvent projection. */
  onToolOutput?: (output: ChatToolOutput) => Promise<void> | void;
  /** Where each call opens and closes its `model_operation` rows, so one in flight at process death shows in
   *  `RunEventRecorder.unterminatedModelOperations`. */
  operations?: ModelOperationSink;
  trace?: TurnTrace;
}

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
  stream: { usage: PromiseLike<LanguageModelUsage>; response: PromiseLike<{ modelId: string }> },
  cut: boolean,
): void {
  if (cut) {
    operation.failed({ cause: new Error(INTERRUPTED_TURN) });

    return;
  }

  void Promise.all([stream.usage, stream.response]).then(
    ([usage, response]) => operation.completed({
      usage: normalizeUsage(usage),
      modelId: response.modelId,
    }),
    operationRejected(operation),
  );
}

const operationRejected = (operation: ModelOperation) =>
  (...rejection: [unknown]): void => { operation.failed({ cause: rejection[0] }); };

interface AnswerStep {
  readonly content: StepResult<ToolSet>['content'];
  readonly finishReason?: string;
  readonly toolCalls?: ReadonlyArray<unknown>;
}

/** A step's own prose: the provider's compaction summary is not the model speaking. */
function stepText(step: AnswerStep): string {
  return step.content.flatMap((part) => (part.type === 'text' && !isServerCompaction(part.providerMetadata) ? [part.text] : [])).join('');
}

function carriesCompaction(step: AnswerStep | undefined): boolean {
  return step?.content.some((part) => part.type === 'custom' && isServerCompaction(part.providerMetadata)) === true;
}

function endsAtCompaction(steps: readonly AnswerStep[]): boolean {
  const last = steps.at(-1);

  return carriesCompaction(last) && (last?.toolCalls?.length ?? 0) === 0 && last !== undefined && stepText(last) === '';
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
  const answer = steps.slice(from).map(stepText).join('');

  return answer.trim() ? answer : null;
}

/** The tool's returned value projected to JSON, or nothing so the rendered text stands in. */
function toolOutput(raw: ChatToolOutput['output']): { output: JsonValue } | undefined {
  return raw === undefined ? undefined : { output: projectJsonValue({ value: raw }) };
}

type PendingStepEvent = Omit<Extract<ChatEvent, { type: 'step-finish' }>, 'type'>;

/** A finished step as its seal records it, built from the SDK's step before any consumer has read its chunks. */
export interface StepRecord {
  readonly messages: readonly ModelMessage[];
  readonly step?: Omit<PendingStepEvent, 'responseMessages'>;
  readonly toolResults: readonly { readonly event: Extract<ChatEvent, { type: 'tool-result' }>; readonly args: JsonObject }[];
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

const DEAD_STREAM = 'Model stream ended without output: the provider stream terminated prematurely '
  + '(no finish reason, no content). The turn did not complete.';

/** One provider call's state, as the SDK's stream drains into it via {@link ProviderCall.consume}. */
/** The provider's compaction summary is for the model: the stream the owner sees leaves it out. */
function withoutServerSummaries(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  const summaries = new Set<string>();

  return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === 'text-start' && isServerCompaction(chunk.providerMetadata)) summaries.add(chunk.id);

      if ((chunk.type === 'text-start' || chunk.type === 'text-delta' || chunk.type === 'text-end') && summaries.has(chunk.id)) return;

      if (chunk.type === 'custom' && isServerCompaction(chunk.providerMetadata)) return;
      controller.enqueue(chunk);
    },
  }));
}

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
  /** Text the provider wrote for itself, its compaction summary, by stream id: kept for replay, never the answer. */
  private readonly summaries = new Set<string>();
  /** The in-flight step's content: the SDK records only finished steps, so a cut would otherwise lose it. */
  private stepContent: Array<TextPart | ToolCallPart> = [];

  /** Schema-refused calls, until their tool-error arrives. */
  private readonly refusedCalls = new Map<string, Error>();
  /** A call can run before `fullStream` publishes it; kept until its step completes so a cut keeps admitted work. */
  private readonly dispatchedCalls = new Map<string, { readonly call: ToolCallPart; readonly startedAt: number }>();
  private readonly settledCalls = new Map<string, number>();
  private readonly openResults = new Map<string, StepRecord['toolResults'][number]>();
  private responseSoFar: readonly ModelMessage[] = [];
  readonly finishedSteps: StepResult<ToolSet>[] = [];
  private readonly pendingStepEvents: PendingStepEvent[] = [];
  /** When the step's request left (`prepareStep`): a cache warm counts its TTL from there
   *  (docs/research/harness/anthropic-sources.md §2). */
  private stepSentAt = Date.now();
  private requestBody: unknown;
  /** A finished step whose record or hook failed; the SDK drops a step-callback throw (ai 6.0.214 `notify`). */
  stepFailure: { readonly doing: string; readonly cause: unknown } | null = null;

  constructor(private readonly fallback: string | undefined) {}

  /** The seal consumes the wire body for cache warming; SDK step and stream replay retain none. */
  model(model: LanguageModel): LanguageModel {
    if (typeof model === 'string') return model;

    return wrapLanguageModel({ model, middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream }) => {
        const { request, ...answer } = await doStream();
        this.requestBody = request?.body;

        return answer;
      },
    } });
  }

  /** Each step's request starts from the call's input and the seal's answers: ai 7 would carry the last step's
   *  rewrite (markers, weave) and its raw tool outputs into the next one. */
  requestStarting(initial: readonly ModelMessage[]): ModelMessage[] {
    this.stepSentAt = Date.now();

    return [...initial, ...this.responseSoFar];
  }

  dispatched(toolCall: { toolCallId: string; toolName: string; input: unknown }): void {
    this.dispatchedCalls.set(toolCall.toolCallId, { startedAt: Date.now(), call: { type: 'tool-call',
      toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input } });
  }

  settled(toolCallId: string, durationMs: number): void {
    this.settledCalls.set(toolCallId, durationMs);
  }

  aborted(steps: readonly StepResult<ToolSet>[]): void {
    this.recordedSteps = steps;
    this.interrupted = true;
  }

  /** SDK getters are read before stream consumers can lag the seal. */
  stepRecord(step: StepResult<ToolSet>, stepIndex: number, context: ContextComposition | undefined, prefix: readonly ModelMessage[]): StepRecord {
    const usage = normalizeUsage(step.usage);
    const promptTokens = answeredPromptTokens(step.usage);
    const account = callAccountOf(step.response);
    const egress = step.response.headers?.[EGRESS_ROUTE_HEADER];
    const { modelId } = step.response;
    const body = this.requestBody;
    this.requestBody = undefined;
    const calls = new Map(step.content.flatMap((part) => (part.type === 'tool-call' ? [[part.toolCallId, part] as const] : [])));

    const toolResults = step.content.flatMap((part) => {
      if (part.type !== 'tool-result' && part.type !== 'tool-error') return [];
      const call = calls.get(part.toolCallId);
      const record = this.openResults.get(part.toolCallId) ?? { event: this.toolResult(part, call === undefined ? undefined : invalidToolCallRefusal(call)), args: call === undefined ? {} : parseToolArgs(call.input) };

      return [record];
    });

    return { messages: [...prefix, ...this.responseSoFar, ...modelStepMessages(step)], toolResults, step: {
      stepIndex,
      finishReason: step.finishReason, text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName })), toolResults: step.toolResults,
      request: { body, sentAt: this.stepSentAt },
      ...(usageReported(usage) && { usage }),
      ...(promptTokens !== undefined && { promptTokens }),
      ...(account !== undefined && { account }),
      ...(egress !== undefined && { egress }),
      ...(context && { context }),
      ...(this.fallback !== undefined && { fallback: this.fallback }),
      ...(modelId !== '' && { modelId }),
    } };
  }

  /** Returns the step's own messages: what the record holds past this call's earlier steps. */
  stepFinished(step: StepResult<ToolSet>, record: StepRecord, prefixLength: number): readonly ModelMessage[] {
    this.finishedSteps.push(step);
    const response = prefixLength === 0 ? record.messages : record.messages.slice(prefixLength);
    const own = response.slice(this.responseSoFar.length);

    this.responseSoFar = response;

    for (const part of step.content) if (part.type === 'tool-call') {
      this.dispatchedCalls.delete(part.toolCallId);
      this.openResults.delete(part.toolCallId);
    }

    if (record.step !== undefined) this.pendingStepEvents.push({ ...record.step, responseMessages: record.messages });

    return own;
  }

  nativePart(part: TextStreamPart<ToolSet>): void {
    if (part.type === 'tool-call') {
      const refusal = invalidToolCallRefusal(part);

      if (refusal !== undefined) this.refusedCalls.set(part.toolCallId, refusal);
    } else if (part.type === 'tool-result' || part.type === 'tool-error') {
      this.openResults.set(part.toolCallId, { event: this.toolResult(part, this.refusedCalls.get(part.toolCallId)), args: parseToolArgs(part.input) });
    }
  }

  openRecord(messages: readonly ModelMessage[]): StepRecord {
    return { messages, toolResults: [...this.openResults.values()] };
  }

  *takeStepEvents(): Generator<ChatEvent> {
    while (this.pendingStepEvents.length > 0) {
      const ev = this.pendingStepEvents.shift();

      if (ev) yield { type: 'step-finish' as const, ...ev, source: 'native' };
    }
  }

  consume(chunk: TextStreamPart<ToolSet>): ChatEvent | null {
    switch (chunk.type) {
      case 'text-start':
      case 'text-delta':
        return this.prose(chunk);

      case 'reasoning-delta':
        return this.reasoning(chunk.text);

      case 'tool-call':
        return this.toolCall(chunk);

      case 'tool-result':
        return this.toolResult(chunk, undefined);

      case 'tool-error': {
        const refusal = this.refusedCalls.get(chunk.toolCallId);
        this.refusedCalls.delete(chunk.toolCallId);

        return this.toolResult(chunk, refusal);
      }

      case 'finish-step':
        this.stepEnded(chunk.finishReason);

        return null;

      case 'error':
        this.failed({ cause: chunk.error });

        return null;

      case 'abort':
      case 'custom':
      case 'file':
      case 'finish':
      case 'raw':
      case 'reasoning-end':
      case 'reasoning-file':
      case 'reasoning-start':
      case 'source':
      case 'start':
      case 'start-step':
      case 'text-end':
      case 'tool-approval-request':
      case 'tool-approval-response':
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

  private reasoning(text: string): ChatEvent | null {
    return text ? { type: 'reasoning-delta', delta: text } : null;
  }

  private toolCall(chunk: Extract<TextStreamPart<ToolSet>, { type: 'tool-call' }>): ChatEvent {
    this.stepHadOutput = true;
    this.stepContent.push({ type: 'tool-call', toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input });
    const refusal = invalidToolCallRefusal(chunk);

    if (refusal !== undefined) this.refusedCalls.set(chunk.toolCallId, refusal);

    return { type: 'tool-call', toolName: chunk.toolName, toolCallId: chunk.toolCallId, args: parseToolArgs(chunk.input) };
  }

  /** No finish reason and no output (reasoning-only included): the provider stream died. */
  private stepEnded(finishReason: string): void {
    this.lastFinishReason = finishReason;
    this.deadFinalStep = !this.stepHadOutput && finishReason === 'other';
    this.stepHadOutput = false;
    this.stepContent = [];
  }

  private prose(chunk: Extract<TextStreamPart<ToolSet>, { type: 'text-start' | 'text-delta' }>): ChatEvent | null {
    if (chunk.type === 'text-start') {
      if (isServerCompaction(chunk.providerMetadata)) this.summaries.add(chunk.id);

      return null;
    }

    if (!chunk.text || this.summaries.has(chunk.id)) return null;
    this.stepHadOutput = true;
    this.stepContent.push({ type: 'text', text: chunk.text });

    return { type: 'text-delta', delta: chunk.text };
  }

  failed({ cause }: { readonly cause: unknown }): void {
    this.streamError = cause;
    this.streamedBeforeError = this.stepContent.length > 0 || this.dispatchedCalls.size > 0;
  }

  private toolResult(
    part: { readonly type: 'tool-result'; readonly toolCallId: string; readonly toolName: string; readonly output: unknown }
      | { readonly type: 'tool-error'; readonly toolCallId: string; readonly toolName: string; readonly error: unknown },
    refusal: Error | undefined,
  ): Extract<ChatEvent, { type: 'tool-result' }> {
    const named = { type: 'tool-result' as const, toolName: part.toolName, toolCallId: part.toolCallId, ...this.toolDuration(part.toolCallId) };

    if (part.type === 'tool-result') {
      return { ...named, result: renderToolResult(part.output), ...toolOutput(part.output), ...successfulToolOutcome(part.toolName, { output: part.output }) };
    }

    const cause = refusal ?? part.error;
    const error = describeProviderError({ cause });

    return { ...named, result: error, error, ...failedToolOutcome({ cause }) };
  }

  private toolDuration(toolCallId: string): { durationMs: number } | undefined {
    const settled = this.settledCalls.get(toolCallId);

    if (settled !== undefined) return { durationMs: settled };
    const dispatched = this.dispatchedCalls.get(toolCallId);

    return dispatched === undefined ? undefined : { durationMs: Date.now() - dispatched.startedAt };
  }

  /** What ends a drained, uncut call, or null. Provider failures cross as `toProviderError` classifies them, never a
   *  raw `APICallError` body; a dead final step stays a bare throw. */
  failure(provider: string | undefined): CallFailure | null {
    if (this.interrupted) return null;

    // The OpenAI-compatible adapter reports a stream that closed without a finish reason itself; others finish it as
    // `other`, which the step's finish reads.
    const reported = InvalidResponseDataError.isInstance(this.streamError) && this.streamError.data === undefined;
    const dead = this.streamError === undefined ? this.deadFinalStep : reported && !this.streamedBeforeError;

    if (dead) return { cause: new Error('model stream ended without output'), error: new Error(DEAD_STREAM), streamed: false };

    if (this.streamError !== undefined) {
      return {
        cause: this.streamError, streamed: this.streamedBeforeError,
        error: toProviderError({ doing: 'calling the model', cause: this.streamError, provider }),
      };
    }

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
  result: { steps: PromiseLike<unknown>; finishReason: PromiseLike<unknown>; rawFinishReason: PromiseLike<unknown>; usage: PromiseLike<unknown> },
  tolerated: () => boolean,
): void {
  const ignore = (error: Error): void => {
    if (NoOutputGeneratedError.isInstance(error) || tolerated()) return;

    diagnostics.failure(
      'llm_call.deferred_rejected',
      toKinuError({ doing: 'settle an unread stream accessor', cause: error, otherwise: 'io' }),
    );
  };

  for (const deferred of [result.steps, result.finishReason, result.rawFinishReason, result.usage]) deferred.then(undefined, ignore);
}

/** The serving model's prompt-cache plan; marker strategies re-roll tail breakpoints each step. */
function attemptCachePlan(opts: ChatOptions, route: PromptCacheRoute, turnMessages: readonly ModelMessage[], tools: ToolSet): CacheBreakpointPlan {
  return applyCacheBreakpoints({
    providerId: route.providerId,
    modelId: route.modelId ?? opts.modelContext?.id,
    system: opts.system,
    messages: turnMessages,
    tools,
    retention: route.retention,
  });
}

function turnText(streamed: string, steps: readonly StepResult<ToolSet>[], answer: string | null): string {
  let allText = answer ?? streamed;

  if (!allText.trim()) {
    for (const step of steps) {
      const text = stepText(step);

      if (text.trim()) allText += text;
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
function* admittedEvent(tokens: number | undefined, contextWindow: number | null): Generator<ChatEvent> {
  if (tokens !== undefined) yield { type: 'context-admitted', tokens, contextWindow, source: 'native' };
}

/** Every medium some model of the chain takes. */
function chainMedia(primary: ReadonlySet<MediaModality>, fallbacks: readonly ChatFallback[]): ReadonlySet<MediaModality> {
  return new Set([primary, ...fallbacks.map((fallback) => fallback.accepts)].flatMap((accepts) => [...accepts]));
}

async function admitRequest(opts: ChatOptions) {
  const extensions = opts.extensions;

  // Extension tools never shadow a caller tool of the same name.
  const tools = traceTools(opts.trace, withStableSchemas(extensions ? { ...extensions.tools(), ...opts.tools } : opts.tools));
  assertToolsSupportedByModel(opts.modelContext, Object.keys(tools));
  const window = modelWindow(opts.modelContext);
  const { contextWindow } = window;

  // Shared turn-context assembly (orchestrator/turn-context.ts); cf's beforeTurn runs the same function.
  const assembly: Parameters<typeof assembleTurnMessages>[0] = {
    system: opts.system,
    history: opts.history,
    // What any model in the chain takes survives assembly; each attempt narrows it to its own model's media.
    attachments: opts.attachments && { ...opts.attachments, accepts: chainMedia(opts.attachments.accepts, opts.fallbacks ?? []) },
    extensions,
    sessionKey: opts.conversationKey ?? '',
    contextWindow,
    model: opts.modelSpec,
    providerReportedTokens: opts.providerReportedTokens,
    trigger: opts.transformTrigger ?? 'auto',
    abortSignal: opts.signal,
    lostToolCall: opts.lostToolCall,
  };

  const primary = {
    spec: opts.modelSpec,
    provider: opts.modelContext?.provider ?? opts.cache?.providerId,
  };

  // Pre-submission admission; turn-context.ts owns the policy. The tools are counted as the first call sends them.
  assembly.admission = {
    count: opts.countInputTokens,
    tools,
    instructions: opts.dynamicContext?.instructions,
    activated: opts.dynamicContext?.activated,
    limits: window,
  };

  const stepContext = opts.stepContext;
  const initialContext = stepContext === undefined ? null : await stepContext.base();

  // Blocks born at the turn's first step ride right before its input, so the request stays the last user-role
  // content.
  const admitted = await assembleTurnMessages({
    ...assembly, history: initialContext?.messages ?? assembly.history, turnStart: initialContext?.turnStart,
  });

  return { extensions, tools, window, assembly, primary, stepContext, initialContext, admitted };
}

/** What follows the latest OpenAI compaction item, priced for the model serving it; null when none is replayed. */
function tokensSinceLatestCompaction(spec: string, messages: readonly ModelMessage[]): number | null {
  const since = sinceLatestCompaction(messages);

  return since === null ? null : messageTokens(spec, since);
}

/** Only the transform's own fold may call a model. */
export async function measureTurnRequest(opts: ChatOptions): Promise<{ readonly tokens: number; readonly contextWindow: number | null } | null> {
  const { admitted, window } = await admitRequest({ ...opts, stepContext: undefined });

  return admitted.admittedTokens === undefined ? null : { tokens: admitted.admittedTokens, contextWindow: window.contextWindow };
}

export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  let stepCount = 0;
  const { extensions, tools, window, assembly, primary, stepContext, initialContext, admitted } = await admitRequest(opts);
  const { contextWindow, modelOutputLimit } = window;
  const { messages: turnMessages, turnStart, admittedTokens } = admitted;

  yield* admittedEvent(admittedTokens, contextWindow);

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
      const assembled = await assembleTurnMessages({ ...serving, history: base.messages, turnStart: base.turnStart, admission: undefined });

      return { ...assembled, changed: base.changed };
    },
    consume: step => stepContext.consume({ ...step, cache: servingRoute }),
  };

  let servingRoute = turnRoute;
  let cache = attemptCachePlan(opts, servingRoute, turnMessages, tools);
  const forcedInput = opts.transformTrigger === 'force' ? admittedTokens : undefined;

  /** One attempt's provider options: its cache's, the serving model's server compaction, then its own. OpenAI's is
   *  asked per step, from what the step replays. */
  const optionsFor = (spec: string | undefined, served: number | null | undefined, own: ChatOptions['providerOptions']) => mergeProviderOptions(
    mergeProviderOptions(cache.providerOptions, serverCompactor(spec) === 'openai' ? undefined : serverCompactionOptions(spec, served, forcedInput)), own);

  /** The model each attempt calls, with the media it takes: the turn's for the primary, its own for a fallback. */
  let current = {
    ...primary,
    model: opts.model,
    accepts: opts.attachments?.accepts,
    providerOptions: optionsFor(assembly.model, opts.modelContext?.contextWindow, opts.providerOptions),
  };

  /** How the serving model's requests are assembled, and the request it sends before what the turn produced. */
  let serving = assembly;
  let base = cache.messages;

  const route = new FallbackRoute<ChatFallback>(opts);
  /** The fallback serving the turn, once one took over. */
  let servingFallback: string | undefined;
  let calls = 0;
  const replay = new ReplayProgress();

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
  /** The request as this attempt's model takes it: narrowed only where the chain took more than the model does. */
  const narrowedFor = async (request: readonly ModelMessage[]): Promise<ModelMessage[]> => {
    const policy = assembly.attachments;

    if (policy === undefined || current.accepts === undefined || current.accepts.size === policy.accepts.size) return [...request];

    return [...await sanitizeAttachmentsForModel(request, { ...policy, accepts: current.accepts })];
  };

  const callModel = async function* (
    request: readonly ModelMessage[],
    stepOffset: number,
    responsePrefix: readonly ModelMessage[],
  ): AsyncGenerator<ChatEvent, CallOutcome> {
    const stepSpans = new StepSpans(opts.trace, {
      spec: current.spec, provider: current.provider, index: calls, fallback: servingFallback !== undefined,
    });

    try {
      const outcome = yield* callModelOnce(request, stepOffset, stepSpans, responsePrefix);
      stepSpans.close(outcome.failure?.error ?? null, outcome.interrupted);

      return outcome;
    } catch (error) {
      stepSpans.close(error instanceof Error ? error : new Error(renderThrownChain({ cause: error })), false);
      throw error;
    }
  };

  const callModelOnce = async function* (
    request: readonly ModelMessage[],
    stepOffset: number,
    stepSpans: StepSpans,
    responsePrefix: readonly ModelMessage[],
  ): AsyncGenerator<ChatEvent, CallOutcome> {
    calls += 1;
    const consumer = new AbortController();
    const signal = opts.signal === undefined ? consumer.signal : AbortSignal.any([opts.signal, consumer.signal]);

    const operation = beginModelOperation(
      { source: 'agent', operations: opts.operations },
      'stream',
      { spec: current.spec },
    );

    const call = new ProviderCall(servingFallback);
    const attempt = cache;

    const result = streamText({
      model: call.model(current.accepts === undefined ? current.model : withToolResultImages(current.model, current.accepts)),
      instructions: attempt.system,
      // The model's stack spends the call's retries; the SDK retries nothing on top.
      maxRetries: 0,
      messages: await narrowedFor(request),
      tools: attempt.tools,
      ...offeredTools,
      stopWhen: [opts.stopWhen ?? isLoopFinished(), () => call.stepFailure !== null],
      // Settled rewrites only (name case, fenced or double-encoded args); otherwise the model retries.
      experimental_repairToolCall: repairToolCall(),
      abortSignal: signal,
      include: { requestBody: false },
      // The SDK default console.error dumped raw provider payloads; the rethrow below is the one place failures read.
      onError: ({ error }) => { call.streamError = error; },
      onToolExecutionStart: ({ toolCall }) => { call.dispatched(toolCall); },
      onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => { call.settled(toolCall.toolCallId, toolExecutionMs); },
      // The only terminal handover: an aborted run never settles `result.steps`.
      onAbort: ({ steps }) => { call.aborted(steps); },
      providerOptions: { ...current.providerOptions, ...callRetries(route.callRetries) },
      // Shared step pipeline, as Think's beforeStep composes it. Also stamps the request start
      // (`ProviderCall.requestStarting`).
      prepareStep: ({ stepNumber, initialMessages, steps }) => {
        const messages = call.requestStarting(initialMessages);
        stepSpans.start(stepOffset + stepNumber);
        const opening = stepOffset + stepNumber === 0;
        const previous = steps.at(-1);

        // Never asked again right after its own compaction.
        const trigger = carriesCompaction(previous) ? undefined
          : compactionTriggerOptions(current.spec, serving.contextWindow, opening ? admittedTokens : previous?.usage.inputTokens, opening && forcedInput !== undefined);

        const prepared = composePrepareStep({
          extensions,
          abortSignal: signal,
          cache: hasCacheMarkers(attempt.strategy) ? { strategy: attempt.strategy } : null,
          prune: { contextWindow, modelOutputLimit },
          budget: opts.budget,
          dynamic: opts.dynamicContext,
          destination: servingRoute,
          replay,
          meter,
          context: stepContextPlane,
          turnStart,
        }, { stepNumber: stepOffset + stepNumber, messages, steps });

        const asked = (done: PrepareStepResult<ToolSet>) => {
          const threshold = current.spec !== undefined && serverCompactor(current.spec) === 'openai'
            ? serverCompactionOptions(current.spec, serving.contextWindow, opening ? forcedInput : undefined, tokensSinceLatestCompaction(current.spec, done?.messages ?? messages))
            : undefined;

          const extra = mergeProviderOptions(trigger, threshold);

          return extra === undefined || done === undefined ? done : { ...done, providerOptions: mergeProviderOptions(done.providerOptions, extra) };
        };

        return prepared instanceof Promise ? prepared.then((done) => asked(done ?? { messages })) : asked(prepared ?? { messages });
      },
      experimental_transform: () => new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
        async transform(part, controller) {
          call.nativePart(part);
          await opts.persistStreamPart?.(part);
          controller.enqueue(part);
        },
      }),
      onStepEnd: async (step) => {
        stepSpans.finish(step);
        let own: readonly ModelMessage[] | null = null;

        try {
          stepCount++;
          const record = call.stepRecord(step, stepCount, meter?.take(), responsePrefix);
          await opts.persistStep?.(record);
          own = call.stepFinished(step, record, responsePrefix.length);
        } catch (cause) {
          call.stepFailure ??= { doing: 'recording a finished model step', cause };
        }

        if (call.stepFailure !== null || own === null) return;

        try {
          await opts.onStep?.(step, own);
        } catch (cause) {
          call.stepFailure ??= { doing: 'run the step hook', cause };
        }
      },
    });

    suppressDeferredRejections(result, () => call.interrupted || signal.aborted);
    // Started before this loop so the tee is taken before any chunk flows; awaited in the tail.
    const observed = opts.observeStream?.(withoutServerSummaries(result.toUIMessageStream({ onError: (error) => describeProviderError({ cause: error }) })));

    let drained = false;

    try {
      for await (const chunk of result.stream) {
        const event = call.consume(chunk);

        if (event !== null) {
          if (event.type === 'text-delta') allText += event.delta;
          await announce(event, chunk);
          event.source = 'native';
          yield event;
        }

        yield* call.takeStepEvents();
      }

      drained = true;
    } catch (err) {
      // The signal is authoritative: a provider may throw its abort reason before `onAbort` runs.
      if (opts.signal?.aborted) call.interrupted = true;
      else if (APICallError.isInstance(err)) call.failed({ cause: err });
      else {
        operation.failed({ cause: err });
        throw err;
      }
    } finally {
      let completed = false;

      try {
        if (!drained && call.streamError === undefined && call.stepFailure === null) consumer.abort();
        await observed;
        completed = drained && !call.interrupted && call.streamError === undefined;
      } finally {
        // A failed seal is not permission to commit its partial rows on a second attempt.
        if (!completed && call.stepFailure === null) {
          if (consumer.signal.aborted) call.interrupted = true;
          const produced = call.produced();
          const paired = settleUnpairedToolCalls(produced, opts.lostToolCall) ?? produced;

          await opts.persistStep?.(call.openRecord(responsePrefix.length === 0 ? paired : [...responsePrefix, ...paired]));
        }
      }
    }

    if (call.stepFailure !== null) {
      const failed = toKinuError({ doing: call.stepFailure.doing, cause: call.stepFailure.cause, otherwise: 'io' });
      operation.failed({ cause: failed });
      throw failed;
    }

    const failure = call.failure(current.provider);
    const produced = call.produced();
    const paired = settleUnpairedToolCalls(produced, opts.lostToolCall) ?? produced;

    if (failure !== null) {
      operation.failed({ cause: failure.cause });

      return { steps: call.finishedSteps, produced: paired, finishReason: undefined, interrupted: false, failure };
    }

    // A cut run never settles `result.response`/`result.steps`; read what `onAbort` handed over.
    const cut = call.interrupted;

    settleModelOperation(operation, result, cut);
    const steps = cut ? call.recordedSteps : await result.steps;

    return { steps, produced: paired, finishReason: call.lastFinishReason, interrupted: cut, failure: null };
  };

  /** A fallback gets its own provider's cache, replay and options, and a request assembled for it: its window, its
   *  compaction and its attachment prices. */
  const takeOver = async (next: ChatFallback): Promise<void> => {
    const bound = next.bind();
    const served = next.window.contextWindow;

    serving = { ...assembly, model: next.spec, contextWindow: served };
    initialContextAvailable = false;
    const history = initialContext?.messages ?? assembly.history;
    const { messages } = await assembleTurnMessages({ ...serving, history, turnStart: initialContext?.turnStart, admission: undefined });

    servingRoute = { providerId: bound.provider, modelId: parseModelSpec(next.spec).modelId, retention: turnRoute.retention };
    cache = attemptCachePlan(opts, servingRoute, messages, tools);
    base = cache.messages;
    current = { ...bound, spec: next.spec, accepts: next.accepts, providerOptions: optionsFor(next.spec, served, bound.providerOptions) };
    servingFallback = next.spec;
    route.tried.push(next.spec);
  };

  const callChain = async function* (stepOffset: number, responsePrefix: readonly ModelMessage[]): AsyncGenerator<ChatEvent, CallOutcome> {
    const outcome = yield* callModel([...base, ...responsePrefix], stepOffset, responsePrefix);

    if (outcome.failure === null) return outcome;
    const next = await route.next(servingFallback ?? opts.modelSpec, outcome.failure);

    if (next === undefined) throw route.exhausted(outcome.failure);
    yield { type: 'model-fallback', from: current.spec, to: next.spec, reason: describeProviderError({ cause: outcome.failure.cause }), source: 'native' };
    const produced = responsePrefix.length === 0 ? outcome.produced : [...responsePrefix, ...outcome.produced];

    await takeOver(next);

    const rest = yield* callChain(stepOffset + outcome.steps.length, produced);

    return { ...rest, steps: [...outcome.steps, ...rest.steps], produced: [...outcome.produced, ...rest.produced] };
  };

  const cooled = route.cooledStart();

  if (cooled !== undefined) {
    yield { type: 'model-fallback', from: current.spec, to: cooled.spec, reason: `${current.spec} is cooling down after failing over`, source: 'native' };
    await takeOver(cooled);
  }

  const first = yield* callChain(0, []);
  let steps: readonly StepResult<ToolSet>[] = first.steps;
  let responseMessages: ModelMessage[] = first.produced;
  let interrupted = first.interrupted;

  // One output-limit continuation: the SDK does not continue a `length` finish with no pending call. The request is
  // the same prefix plus everything produced, so nothing is replayed. A second `length` finish is partial completion.
  if (!interrupted && first.finishReason === OUTPUT_LIMIT_REACHED) {
    const continued = yield* callChain(first.steps.length, first.produced);
    steps = [...steps, ...continued.steps];
    responseMessages = [...responseMessages, ...continued.produced];
    interrupted = continued.interrupted;
  }

  if (!interrupted && endsAtCompaction(steps)) {
    const continued = yield* callChain(steps.length, responseMessages);
    steps = [...steps, ...continued.steps];
    responseMessages = [...responseMessages, ...continued.produced];
    interrupted = continued.interrupted;
  }

  const answer = answerFromSteps(steps, interrupted);
  const text = turnText(allText, steps, answer);

  await extensions?.emitTurnEnd({ text, responseMessages });
  yield { type: 'done', text, responseMessages, ...(answer !== null && { answer }), source: 'native' };

  // Thrown only after `done`, so the history is kept.
  if (interrupted) throw new Error(INTERRUPTED_TURN);
}

function parseToolArgs(raw: TypedToolCall<ToolSet>['input']): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, raw);

  return parsed.success ? parsed.output : {};
}
