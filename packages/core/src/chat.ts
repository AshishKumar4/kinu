/**
 * Shared chat engine — one implementation used by both the server and CLI.
 *
 * Yields streaming events (text deltas, tool calls, tool results) and
 * returns the FULL ModelMessage array including tool call/result messages.
 * Callers store these messages in history so the model sees tool context
 * on subsequent turns.
 */

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
  type UIMessageChunk,
  type LanguageModelUsage,
} from 'ai';
import {
  assertToolsSupportedByModel,
  type PromptModelContext,
} from './prompting/model-profile';
import { applyCacheBreakpoints, hasCacheMarkers, type CacheRetention } from './prompting/cache-breakpoints';
import type { TurnContextMeter } from './context-meter';
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
  /** Provider reasoning, as it streams — the ONE canonical provider-to-caller
   *  reasoning delta in this tree. A surface that paints thinking while it
   *  happens reads this; the step's settled reasoning text still arrives with
   *  the step itself, so nothing durable depends on any frame landing.
   *
   *  Deliberately NOT counted as step output: a step that only thought is a
   *  dead provider stream, and 'finish-step' below is what classifies it. */
  | { type: 'reasoning-delta'; delta: string }
  /** `toolCallId` is the provider's own id for the call — the key that pairs
   *  this event with its 'tool-result'. Surfaces that report calls out of band
   *  (ACP's tool_call/tool_call_update) need it; name alone cannot pair
   *  concurrent calls to the same tool. */
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: JsonObject }
  /** A tool call settled. `result` is the stringified output on success or the
   *  error text on failure, for every reader that renders; `output` is the
   *  VALUE the tool returned on success, projected to JSON, for the ledger —
   *  the run ledger records what a tool returned, never a rendering of it, so
   *  a reader that asks a row for `action` finds a field and not a string.
   *  `success`/`error` carry the discriminator the evolution signal reads
   *  (hadError, outcome review). `durationMs` is how long the call ran, from
   *  the SDK's dispatch of it to its settled part; absent for a call the SDK
   *  never dispatched here (a client-side tool). */
  | ({ type: 'tool-result'; toolName: string; toolCallId: string; result: string; output?: JsonValue; error?: string; durationMs?: number } & ToolOutcome)
  /** `usage` is what the provider reported for THIS step's request, and only
   *  that: a field it did not mention stays absent, a zero it did report stays
   *  a zero. `usage.input` doubles as the caller's measured compaction signal
   *  and `usage.cacheRead` feeds cache telemetry, both of which need the
   *  distinction — "every step reported a zero cache read" is a working cache
   *  plan with a cold prefix, "no step mentioned caching" is a provider that
   *  does not report cache reads at all.
   *
   *  `responseMessages` is the SDK's CUMULATIVE response array as of this step:
   *  every assistant message and paired tool message the turn has produced so
   *  far. It is how a completed step becomes durable at the moment it completes
   *  — the caller hands it to the shared accumulator, which takes the per-step
   *  delta and appends it to the run's durable log. Carried by reference and
   *  never copied: a 40-step turn must not re-serialize its transcript 40
   *  times. */
  | {
    type: 'step-finish'; stepIndex: number; responseMessages: readonly ModelMessage[]; usage?: Usage;
    /** How the step ended, the SDK's mapped reason: the accumulator keeps the
     *  LAST one for the settle classifier and the output-limit continuation. */
    finishReason?: string;
    /** What the step produced, for the step's own record: its text, its calls
     *  and their results. Read off the SDK step here because they are
     *  getter-backed on its prototype, which a spread would drop. */
    text?: string;
    toolCalls?: ReadonlyArray<{ toolName: string }>;
    toolResults?: ReadonlyArray<unknown>;
  }
  /** A failure the turn survived. `runChat` itself never yields this — it
   *  throws, and the caller owns the turn-failure policy. The scaffold seam
   *  (scaffold/chat-transform.ts) does: an evolved scaffold reports a failed
   *  sub-step or a failed run without losing the output already streamed. */
  | { type: 'error'; message: string }
  | { type: 'done'; text: string; responseMessages: ModelMessage[] };

export type ChatToolOutput = Extract<TextStreamPart<ToolSet>, { type: 'tool-result' }>;

export interface ChatOptions {
  model: LanguageModel;
  system: string;
  /** Durable conversation history — what extensions' transformContext sees
   *  (and may rewrite, e.g. compaction). */
  history: ModelMessage[];
  /** Per-activation dynamic-context ledger + the live-state reader. Re-read
   *  and re-woven at EVERY step by the shared step pipeline, never at turn
   *  assembly, so a compaction plugin never sees or persists a block. */
  dynamicContext?: StepDynamicContext;
  /** Per-step context measurement. runChat opens the turn on it with this
   *  turn's system + tools; the step pipeline then measures each request. */
  meter?: TurnContextMeter;
  /** The claim's durable context plane. The step pipeline records the exact
   *  array each step consumes on it, and lands a staged mid-turn edit at the
   *  first safe boundary. Absent for unclaimed work — a head's own inference,
   *  a shadow-eval replay. */
  stepContext?: StepContextPlane;
  /** Turn-local context (skill activation reasons, device notice) — spliced
   *  at the tail of the turn's initial array for THIS turn only; never visible
   *  to a transform and never treated as durable history. */
  turnLocal?: readonly ModelMessage[];
  tools: ToolSet;
  /** Model-capability attachment policy: history file/media parts the
   *  resolved model cannot accept are replaced (VFS reference / inline text)
   *  BEFORE the transform seam, so compaction sees sanitized history and the
   *  weave freezes over it. Per-part in-place replacement — message count
   *  never changes, so downstream indices hold. */
  attachments?: AttachmentPolicy;
  modelContext?: PromptModelContext;
  /** Provider-reported prompt tokens of the previous turn's final request —
   *  the measured trigger signal handed to transformContext (chars/4
   *  estimates lie). Callers persist it from the last turn's step-finish
   *  `usage.input`. */
  providerReportedTokens?: number;
  /** Context-transform trigger: 'force' when the caller consumed an armed
   *  force-compaction flag (overflow recovery — the previous turn's request
   *  exceeded the window, so a stale plan replay is not enough). */
  transformTrigger?: 'auto' | 'force';
  /**
   * The resolved provider's own count of an assembled request
   * (providers/input-tokens.ts), for exact admission before anything is
   * submitted. Omitted = the provider publishes no count endpoint, and the
   * shared estimate gates instead — see the module comment there for the
   *  exact-count-then-estimate contract.
   */
  countInputTokens?: (request: CountableRequest) => Promise<InputTokenCount>;
  signal?: AbortSignal;
  /** Extension seam (public API): registered extensions observe the turn
   *  (onTurnStart/onToolCall/onToolResult/onTurnEnd), rewrite the step messages
   *  (prepareStep — the mid-turn steering drain rides this), and contribute
   *  tools (registerTools). One host drives internal consumers and plugins. */
  extensions?: ExtensionHost;
  /** Prompt-cache identity: the registry provider id the model resolved
   *  through + a stable per-conversation key. When present, provider-native
   *  cache markers land on the wire — Anthropic breakpoints (end-of-system +
   *  a tail rolled forward every step) or prompt_cache_key routing for the
   *  OpenAI-compatible family. `retention` sets how long the provider keeps
   *  the prefix (default `short`). See prompting/cache-breakpoints.ts. */
  cache?: { providerId?: string; modelId?: string; sessionKey: string; retention?: CacheRetention };
  /**
   * A second reader of each model call's stream, handed the SDK's own
   * UIMessage chunk conversion of it. The turn loop reads the call through
   * `fullStream`; a transport that speaks the SDK's chat protocol reads the
   * same call here, in the vocabulary the SDK's clients and stores expect,
   * without a second request. The SDK tees the underlying stream per reader
   * (`StreamTextResult.teeStream`), so neither consumer starves the other; the
   * loop awaits the reader's return before it settles the turn, so the answer
   * it persists carries every part the transport relayed.
   */
  observeStream?: (chunks: ReadableStream<UIMessageChunk>) => Promise<void>;
  /** Request-level provider options contributed by the caller. They are
   *  merged by provider namespace with the cache options assembled here. */
  providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
  /** The subset of `tools` the model may CALL this turn, when the caller
   *  narrows one: the rest stay wired for execution but are not offered.
   *  Absent, every tool is offered. */
  activeTools?: readonly string[];
  /** The actor's mission budget governor. When the turn runs under a label
   *  whose cumulative cap is spent, the step pipeline declines the next
   *  request instead of issuing it. Unscoped turns are unaffected. */
  budget?: MissionGovernor;
  /**
   * One more reason this turn may stop. There is NO step cap to OR with: the
   * agentic loop runs until the model stops calling tools, and a fork's driver
   * adds its own reasons here (the abort flag its spawner polls, the wall clock
   * the search granted it, an ASYNC mission guard) rather than running a second
   * loop that would have to re-derive everything below.
   */
  stopWhen?: StopCondition<ToolSet>;
  /**
   * Each finished step, raw, in process, awaited.
   *
   * The event stream is the SERIALIZABLE projection of a turn: it crosses the
   * scaffold seam's valibot schema and the ACP/TUI boundary, so it carries
   * rendered text and parsed args. A head's journal row needs what a
   * projection cannot carry — the step's reasoning text, and its tool calls
   * paired with their outputs by id. Awaited, because the sink can be an RPC
   *  to another Durable Object and the next request must not be issued while
   *  the trace of the previous step is still in flight.
   *
   *  Errors are the sink's own: a throw here rejects the turn, exactly as a
   *  throw from `prepareStep` does, so a sink that must survive its own
   *  failures handles them (heads/head-inference.ts does).
   */
  onStep?: (step: StepResult<ToolSet>) => Promise<void> | void;
  /** Raw SDK output for a host UI bridge, before presentation/model conversion.
   * Not included in the serializable ChatEvent projection. */
  onToolOutput?: (output: ChatToolOutput) => Promise<void> | void;
  /**
   * Where the turn's own model calls open and close their lifecycle rows
   * (`model_operation`, source `agent`). The step pipeline writes a row per
   * FINISHED step; a turn whose provider call never returned leaves nothing
   * behind — no row says which operation was in flight when the process died,
   * which is the signature `RunEventRecorder.unterminatedModelOperations`
   * exists to read. Optional for the same reason the other sinks are: a turn
   * with no ledger wired is one whose calls record nothing.
   */
  operations?: ModelOperationSink;
}

/**
 * The stop condition a turn runs under when its caller names none: never stop.
 *
 * It replaces the former `stepCountIs(DEFAULT_MAX_STEPS)` cap, per owner ruling —
 * there is no per-turn step bound. The AI SDK's own default is `stepCountIs(1)`,
 * so the loop must be given SOMETHING: an omitted `stopWhen` would silently end
 * every turn after one step. What bounds a turn instead, all from inside:
 * the model itself (the loop ends when a step finishes without tool calls), the
 * mission budget governor ({@link ChatOptions.budget}) where a label is scoped,
 * and whatever extra condition a fork's driver passes as
 * {@link ChatOptions.stopWhen}.
 */
export const UNBOUNDED_STEPS: StopCondition<ToolSet> = () => false;

/**
 * The step count a turn runs under when no bound is wanted — for the loops that
 * take a NUMBER rather than a condition.
 *
 * `runChat` needs none of this: it hands `stopWhen` straight to `streamText`, so
 * {@link UNBOUNDED_STEPS} alone makes it unbounded. `@cloudflare/think` does
 * not. It composes `[stepCountIs(config.maxSteps ?? this.maxSteps), ...caller]`
 * and the array is OR-ed, so a caller's condition can only ever ADD a way to
 * stop — it cannot widen the cap ahead of it, and the vendor's own type doc
 * says so ("Think always keeps its `maxSteps` stop condition as a safety
 * bound"). Its instance default is 10, which is how the cloud backend ran
 * capped at ten steps for the whole time the CLI ran unbounded, with both
 * loops' comments asserting parity.
 *
 * So the number IS the lever, and this is it. `stepCountIs` compares with
 * `===`, so a step count no turn can reach never fires — an unreachable bound
 * rather than a removed one, because the vendor gives no way to remove it.
 */
export const UNBOUNDED_MAX_STEPS = Number.MAX_SAFE_INTEGER;

/**
 * THE TWO OPENINGS A SILENT TURN'S FAILURE WAS RECORDED WITH.
 *
 * Turns that ran under the removed silence watchdog recorded their endings as
 * durable prose: `head_journal.error_message`, `SwarmCandidate.incomplete`, and
 * the `swarm.branch_failed` event a surface renders still carry these two
 * openings, and they distinguish two causes that need different answers — a
 * wedge is a fault to investigate, a rate limit is capacity to wait for or pace
 * against. Nothing in the engine writes the prose; the classifier below is what
 * keeps the recorded rows readable. The prefixes stay module-scoped so no second
 * reader can grow its own copy of the vocabulary.
 */
const RATE_LIMITED_TURN_PREFIX = 'Turn ended by provider rate limiting:';

/**
 * Whether a turn's recorded failure is the provider having rate-limited it,
 * rather than the turn having gone silent on its own. The one classifier: every
 * surface that renders a node's reason reads it through this.
 *
 * `includes` rather than `startsWith`, and that is measured rather than lax: a
 * node's row does not carry the turn's message, it carries the CHAIN that wrapped
 * it — the incident's own row read `run agent <id> to a report: Turn stalled:
 * nothing flowed for 300s …`. So the prefix is a marker inside a chain, which is
 * exactly why it has to be a declared constant rather than a phrase each reader
 * reconstructs.
 */
export function isRateLimitedTurnError(message: string): boolean {
  return message.includes(RATE_LIMITED_TURN_PREFIX);
}

/** What the caller records for a turn its own abort signal ended. Thrown after
 *  the turn's `done` event, so the interrupted turn's history is kept and the
 *  turn is still recorded as unfinished. */
export const INTERRUPTED_TURN = 'The turn was interrupted before it finished.';

/**
 * Run one chat turn. Yields streaming events and finishes with a 'done'
 * event containing the full text and the SDK's response messages.
 *
 * The response messages include assistant messages (with tool_call parts)
 * and tool messages (with tool_result parts). Callers MUST append these
 * to the conversation history — not just the flat text.
 *
 * A CUT turn — the caller's abort — yields `done` and THEN throws
 * {@link INTERRUPTED_TURN}. The history it produced is the record of what the
 * turn did: every completed step, plus the step the cut landed in, with a
 * terminal result for the call that never returned. The throw is how the caller
 * records that the turn did not finish. Both are true, and a caller that
 * persists on `done` and flags the turn on a throw already does the right thing
 * with both. A dead provider stream is the one terminal that still throws
 * WITHOUT a `done` — see its site for why. There is no elapsed bound on a turn:
 * it runs until its work is done, the caller cancels it, or the provider or a
 * tool fails definitively.
 */

/** One call's frame, closed whichever way it left. Called by the generator's
 *  tail — never `await`ed there, because a cut path cannot touch the deferred
 *  accessors and the end row should land before the consumer's `turn_end`
 *  reads the stream as finished. */
function settleModelOperation(
  operation: ModelOperation,
  stream: { totalUsage: PromiseLike<LanguageModelUsage>; response: PromiseLike<{ modelId: string }> },
  cut: boolean,
): void {
  if (cut) {
    operation.failed({ cause: new Error(INTERRUPTED_TURN) });

    return;
  }

  // The natural finish: usage is what the provider reported across the whole
  // call, the modelId the last step's. `response` settles on a non-cut path (it
  // never settles on a cut), and `totalUsage` is the same deferred the
  // ignoreDeferred guard already tolerates rejecting — the rejection handler
  // here is the end row's own, not a second swallow of the same fault.
  void Promise.all([stream.totalUsage, stream.response]).then(
    ([totalUsage, response]) => operation.completed({
      usage: normalizeUsage(totalUsage),
      modelId: response.modelId,
    }),
    operationRejected(operation),
  );
}

/** A deferred accessor rejecting on a call that finished: the frame's failure
 *  row, written with the rejection as its cause. Kept as a named function so
 *  the `then` rejection arm has a typed parameter — both rules the inline
 *  shape would trip (a bare annotation reads as an unparsed boundary, a
 *  missing one as an untyped catch variable) — and so the arm reads as the
 *  event it writes, not the promise mechanics around it. */
const operationRejected = (operation: ModelOperation) =>
  <Failure>(cause: Failure): void => { operation.failed({ cause }); };

/** What {@link answerFromSteps} reads off one step, and nothing more: a
 *  provider's `StepResult` satisfies it structurally, which is what keeps this
 *  rule readable without the SDK's twenty other step fields in view. */
interface AnswerStep {
  readonly text?: string;
  readonly finishReason?: string;
}

/**
 * THE TURN'S ANSWER: the text of its FINAL step, or null when the steps do not
 * carry one and what the turn streamed stands.
 *
 * A multi-step turn narrates: each step may emit prose before its tool calls
 * ("I'll look at the workspace first…"), and that prose is the step's,
 * recorded on its own `step_finish` row and streamed to whoever was watching.
 * The turn's answer is what it said when it stopped. Joining every step's text
 * made the durable reply a wall of narration with the answer buried at its end
 * and no boundary in front of it — measured 2026-09-16 on the deployed build:
 * the stored reply for a ten-step slate turn was the nine narrations plus the
 * answer, concatenated, so a reader asking for the answer's own first line
 * found narration instead.
 *
 * Two steps JOIN: a step the provider cut at its output limit and the
 * continuation that finishes it are one answer in two requests, so the walk
 * back over `length` finishes collects both. An INTERRUPTED turn has no answer
 * here at all — the cut text is what the operator saw, and the last finished
 * step is not it — and neither does a turn whose steps hold no text; both are
 * null, and the caller keeps what it streamed.
 */
function answerFromSteps(
  steps: readonly AnswerStep[],
  interrupted: boolean,
): string | null {
  if (interrupted || steps.length === 0) return null;
  let from = steps.length - 1;

  while (from > 0 && steps[from - 1]?.finishReason === OUTPUT_LIMIT_REACHED) from -= 1;
  const answer = steps.slice(from).map((step) => step.text ?? '').join('');

  return answer.trim() ? answer : null;
}

/** What a settled tool call contributes to the durable ledger: the VALUE the
 *  tool returned, projected to JSON, or nothing when it returned nothing —
 *  then the rendered text stands in, which is what such a row has always
 *  held. The argument is the SDK's own `output` off the settled part, whose
 *  type is the tool's return value: anything JSON-shaped, which is why the
 *  projection is the parse. */
function toolOutput(raw: ChatToolOutput['output']): { output: JsonValue } | undefined {
  return raw === undefined ? undefined : { output: projectJsonValue({ value: raw }) };
}

/** A finished step, as the accumulator reads it — queued by the SDK's
 *  callback and yielded by the generator after the chunk that closed it. */
interface PendingStepEvent {
  stepIndex: number;
  responseMessages: readonly ModelMessage[];
  usage?: Usage;
  finishReason?: string;
  text?: string;
  toolCalls?: ReadonlyArray<{ toolName: string }>;
  toolResults?: ReadonlyArray<unknown>;
}

/** What ONE provider call of a turn ended with. */
interface CallOutcome {
  /** The steps the SDK recorded for the call — its own on a natural finish,
   *  the `onAbort` handover on a cut. */
  readonly steps: readonly StepResult<ToolSet>[];
  /** The messages the call generated, tool-call pairing already settled. Never
   *  the input prefix: this is what the caller appends to durable history, and
   *  what a continuation call is handed on top of the same prefix. */
  readonly produced: ModelMessage[];
  /** The mapped `finishReason` of the call's LAST step, absent when no step
   *  reported one. {@link OUTPUT_LIMIT_REACHED} is what the continuation
   *  reads. */
  readonly finishReason: string | undefined;
  /** The caller cut the call. */
  readonly interrupted: boolean;
}

/** The dead-stream message a call that ran to a natural end without a mapped
 *  finish reason or any output is rejected with. */
const DEAD_STREAM = 'Model stream ended without output: the provider stream terminated prematurely '
  + '(no finish reason, no content). The turn did not complete.';

/**
 * ONE provider call's state, as the SDK's stream drains into it.
 *
 * The stream is read by {@link ProviderCall.consume}, a function of the chunk
 * and this state alone: it maps each SDK part to the {@link ChatEvent} the
 * caller yields (or none) and keeps the three facts the tail reads — whether
 * the in-flight step produced anything, whether the last step was a dead
 * stream, and how the last step ended. The SDK's callbacks write the rest:
 * every dispatched call and its instant, every finished step's cumulative
 * messages, and the abort handover.
 */
class ProviderCall {
  /** The caller cut the call — set by `onAbort`, or by the drain when the
   *  provider threw the abort reason before the SDK invoked it. */
  interrupted = false;
  /** The steps `onAbort` handed over. An aborted run never settles
   *  `result.steps`, so this is the only record of a cut call's steps. */
  recordedSteps: readonly StepResult<ToolSet>[] = [];
  /** A provider failure routed into the stream as an in-band error chunk. */
  streamError: unknown;
  /** The mapped finish reason of the last step that finished. What the
   *  output-limit continuation reads, and what a caller records. */
  lastFinishReason: string | undefined;
  /** A step that finished with no mapped finish reason AND produced nothing is
   *  a provider stream that died mid-request — the SDK records it as a normal
   *  empty step and ends the turn as if the model chose to stop (observed: a
   *  bench turn "completed" cleanly, hadError:false, after its second request
   *  returned a dead SSE). */
  private deadFinalStep = false;
  private stepHadOutput = false;
  /** The in-flight step's assistant content, as it streams. An abort ends the
   *  SDK's loop mid-step and the SDK records only steps that FINISHED, so
   *  everything the model produced in the step the cut landed in is absent
   *  from `result.response` — including a tool call the caller has already
   *  been handed. Cleared at every step boundary. */
  private stepContent: Array<TextPart | ToolCallPart> = [];
  /** Tool execution can begin before `fullStream` publishes its tool-call part.
   *  Dispatched calls are kept until the SDK completes their step, so a cut
   *  cannot erase work already admitted by the tool boundary; the dispatch
   *  instant rides along, and the settled part's `durationMs` is measured
   *  from it. */
  private readonly dispatchedCalls = new Map<string, { readonly call: ToolCallPart; readonly startedAt: number }>();
  /** This call's cumulative generated array as of its last finished step. The
   *  SDK accumulates `step.response.messages` within the call and never
   *  includes the input prefix, so this is what the call generated. */
  private responseSoFar: readonly ModelMessage[] = [];
  private readonly pendingStepEvents: PendingStepEvent[] = [];

  dispatched(toolCall: { toolCallId: string; toolName: string; input: unknown }): void {
    this.dispatchedCalls.set(toolCall.toolCallId, { startedAt: Date.now(), call: { type: 'tool-call',
      toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input } });
  }

  aborted(steps: readonly StepResult<ToolSet>[]): void {
    this.recordedSteps = steps;
    this.interrupted = true;
  }

  /** One finished step, as the accumulator reads it: how it ended, what it
   *  produced, and what it cost. `text`, `toolCalls` and `toolResults` are
   *  read off the SDK step here because they are getter-backed on its
   *  prototype, which a spread would drop. A call the model has now answered
   *  is no longer outstanding. */
  stepFinished(step: StepResult<ToolSet>, stepIndex: number): void {
    this.responseSoFar = [...step.response.messages];

    for (const part of step.content) if (part.type === 'tool-call') this.dispatchedCalls.delete(part.toolCallId);
    const usage = normalizeUsage(step.usage);

    this.pendingStepEvents.push({
      stepIndex, responseMessages: this.responseSoFar,
      finishReason: step.finishReason, text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ toolName: call.toolName })), toolResults: step.toolResults,
      ...(usageReported(usage) && { usage }),
    });
  }

  /** The step events the SDK's callback queued since the last chunk. */
  *takeStepEvents(): Generator<ChatEvent> {
    while (this.pendingStepEvents.length > 0) {
      const ev = this.pendingStepEvents.shift();

      if (ev) yield { type: 'step-finish' as const, ...ev };
    }
  }

  /** The event one SDK stream part becomes for the caller, or null for a part
   *  the caller has no event for. */
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
        // Full text, never a head slice: this string is the call's durable
        // record (recordToolCall → the evolution signal) AND the identity the
        // turn steering hashes. A clipped copy made two different outputs
        // sharing a long preamble hash identical, and made cf and the CLI
        // record different evolution evidence for the same call. Every
        // display path bounds it at render.
        const raw = chunk.output;

        return {
          type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result: renderToolResult(raw),
          ...toolOutput(raw), ...this.toolDuration(chunk.toolCallId), ...successfulToolOutcome(chunk.toolName, raw),
        };
      }

      case 'tool-error': {
        // A tool threw: the error is the durable outcome the evolution signal
        // reads. The extension seam sees the error text as the result (same as
        // the cf afterToolCall), and the discriminator rides success/error.
        const error = describeProviderError({ cause: chunk.error });

        return {
          type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result: error, error,
          ...this.toolDuration(chunk.toolCallId), ...failedToolOutcome({ cause: chunk.error }),
        };
      }

      case 'finish-step': {
        // A finished step with no mapped finish reason and no output is a
        // provider stream that died (closed early, empty SSE, dropped route):
        // the model never chose to stop. Reasoning-only steps count as dead
        // too — a turn cannot proceed from thinking that never landed.
        this.lastFinishReason = chunk.finishReason;
        this.deadFinalStep = !this.stepHadOutput && chunk.finishReason === 'other';
        this.stepHadOutput = false;
        this.stepContent = [];

        return null;
      }

      case 'error':
        this.streamError = chunk.error;

        return null;

      default:
        return null;
    }
  }

  /** How long a settled call ran, from the SDK's dispatch of it. Absent when
   *  the SDK never announced a dispatch — a call it did not execute here. */
  private toolDuration(toolCallId: string): { durationMs: number } | undefined {
    const dispatched = this.dispatchedCalls.get(toolCallId);

    return dispatched === undefined ? undefined : { durationMs: Date.now() - dispatched.startedAt };
  }

  /**
   * What ends a drained call that the caller did not cut, or null when the
   * call stands.
   *
   * A DEFINITIVE provider or transport failure crosses as a CLASSIFIED failure.
   * Rethrown verbatim it would reach the CLI and the chat surface as an
   * `APICallError` with its raw `responseBody` still attached and its own
   * message saying only "AI_APICallError" — so the overflow-recovery
   * classifier would read nothing usable while the user read the endpoint's
   * whole body. `toProviderError` carries the closed code and the structured
   * facts (status, provider code, provider id) in the message, keeps the raw
   * failure on `cause`, and files the provider's own text on the diagnostics
   * record. The provider the request went to is the resolved model's when the
   * caller named one, else the cache plan's routing.
   *
   * A dead final step is deliberately still a bare throw, unlike the
   * interrupt: this turn was never cut. It ran to a natural end and what is
   * being rejected is the RESULT, so there is no "work the cancellation
   * discarded" to rescue — and the empty dead step would ride into the durable
   * history with nothing established about what an empty assistant message
   * does on replay.
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
   * The messages this call generated, for the caller's durable history and
   * for a continuation's prefix.
   *
   * On a natural finish that is the cumulative array of the last finished
   * step, captured as it finished — and, message for message, what the
   * per-step durable rows hold, so the history the caller persists and the
   * durable record are one construction. A CUT call adds what the cut
   * interrupted: the step the SDK will never report, with every dispatched
   * call the stream had not yet published, so the pairing invariant holds over
   * the whole call and `streamText` will assemble a later request from it.
   * Without that, a tool call the caller has already recorded has no result
   * anywhere, and every later request from this history — the continuation
   * request included, whose prefix IS this array — is refused.
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
 * A call that never finishes a step — the provider failed before one, or the
 * caller cut the call — makes the SDK REJECT its deferred accessors (`steps`,
 * `finishReason`, `rawFinishReason`, `totalUsage`) when the stream ends. The
 * turn reports all of those through the streamed error or the interrupt path
 * and never reads the deferrals, and a rejection nobody reads is an unhandled
 * one that crashes test files and pollutes DO logs. The zero-steps rejection
 * is classified by type; a cut is classified by the state that caused it
 * (`tolerated`); anything else is recorded, because a deferred rejecting on a
 * turn that finished naturally would be a defect here and must be visible.
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

export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  const extensions = opts.extensions;

  // One ToolSet: the caller's tools plus every extension's contributed tools.
  // Extension tools never shadow a caller (built-in) tool of the same name.
  const tools: ToolSet = extensions ? { ...extensions.tools(), ...opts.tools } : opts.tools;
  assertToolsSupportedByModel(opts.modelContext, Object.keys(tools));

  /** The spec every provider call this turn makes is attributed to — resolved
   *  once, beside the tools those calls share. */
  const modelSpec = opts.modelContext?.id;

  let stepCount = 0;

  // The shared turn-context assembly (orchestrator/turn-context.ts): attachment
  // sanitize → extension onTurnStart → awaited transformContext (compaction) →
  // turn-local tail. The cf backend's beforeTurn runs the SAME function, so the
  // ordering cannot drift per backend.
  const contextWindow = opts.modelContext?.contextWindow
    ?? contextWindowForModel(opts.modelContext?.id ?? '');

  // An unreported answer allowance says nothing about how much of the window
  // the answer may take, so the honest reading is the whole window and
  // `outputReserveTokens` splits from there. A picked number here would put a
  // fact in the catalog's mouth.
  const modelOutputLimit = opts.modelContext?.modelOutputLimit ?? contextWindow;

  const assembly: Parameters<typeof assembleTurnMessages>[0] = {
    system: opts.system,
    history: opts.history,
    attachments: opts.attachments,
    extensions,
    turnLocal: opts.turnLocal,
    sessionKey: opts.cache?.sessionKey ?? '',
    contextWindow,
    providerReportedTokens: opts.providerReportedTokens,
    trigger: opts.transformTrigger ?? 'auto',
    abortSignal: opts.signal,
  };

  // Pre-submission admission. The provider's own counter is used when the
  // caller resolved one; without it the assembled request is measured by the
  // shared estimate and the same gate applies — one forced compaction, then a
  // re-measure, then a refusal (turn-context.ts owns the policy, so neither
  // backend holds a second copy). The tools that ride every request are part
  // of what is measured, which is why they are handed over here.
  assembly.admission = {
    count: opts.countInputTokens,
    tools,
    limits: { contextWindow, modelOutputLimit },
  };

  const turnMessages = await assembleTurnMessages(assembly);

  // Provider prompt-cache plan: cache-eligible system + request-level cache
  // routing at turn assembly; marker strategies additionally re-roll the tail
  // breakpoints in prepareStep so every request of the agentic loop reads the
  // previous step's prefix. Without opts.cache the plan is a pass-through.
  const cache = applyCacheBreakpoints({
    providerId: opts.cache?.providerId,
    modelId: opts.cache?.modelId ?? opts.modelContext?.id,
    system: opts.system,
    messages: turnMessages,
    sessionKey: opts.cache?.sessionKey ?? '',
    retention: opts.cache?.retention,
  });

  const rollTail = hasCacheMarkers(cache.strategy);
  const providerOptions = mergeProviderOptions(cache.providerOptions, opts.providerOptions);

  // The turn's constants for the per-step breakdown: the cache-eligible system
  // is the text that actually rides the request, and the merged ToolSet is the
  // schema payload that rides it every step.
  opts.meter?.openTurn({ system: cache.system, tools });

  /** The text the turn STREAMED, across every provider call it takes: what a
   *  client watching saw, and the fallback for a turn whose steps carry no
   *  text of their own. The turn's ANSWER is narrower — see below. */
  let allText = '';

  /** The subset of `tools` the model may CALL, when the caller narrowed one:
   *  the rest stay wired for execution but are not offered. One decision per
   *  turn; every provider call of the turn offers the same set.
   *
   *  SAFETY: the names come from the caller that built `tools`; the SDK
   *  ignores a name the set does not carry, which is the narrowing a caller
   *  asked for and not a fault. */
  const offeredTools = opts.activeTools === undefined
    ? {}
    : { activeTools: [...opts.activeTools] as Array<keyof ToolSet> };

  /** What a mapped event owes the seams before it is yielded: the extension
   *  host hears every call and every result, and the host UI bridge sees the
   *  raw SDK output of a settled call. Kept beside the loop rather than inside
   *  the mapper so the mapper stays a function of the chunk and the call. */
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
   * ONE provider call: the SDK's own agentic loop over the messages it is
   * handed, drained into {@link ChatEvent}s, ending in what the call produced.
   *
   * A CALL and a TURN are not the same thing, and that is why this is a closure
   * rather than the function's straight line: an answer the provider cut at its
   * output limit is continued by a second call, and both calls are one turn —
   * one meter, one text, one step numbering, one durable history, one `done`.
   *
   * `stepOffset` keeps the step numbering the TURN's rather than the call's. The
   * step pipeline's injection ledger captures its base coordinates at step 0
   * (prompting/step-injections.ts) and replays recorded injections into the
   * turn's response messages relative to them, so a second call restarting the
   * SDK's own `stepNumber` at 0 would re-base those coordinates against the
   * longer continuation input and misplace every steer message the turn had
   * already taken.
   */
  const callModel = async function* (
    request: readonly ModelMessage[],
    stepOffset: number,
  ): AsyncGenerator<ChatEvent, CallOutcome> {
    // One operation frame per PROVIDER CALL — the continuation below is a
    // second `callModel`, so a turn that hit the output limit opens a second
    // frame rather than quietly extending the first.
    const operation = beginModelOperation(
      { source: 'agent', operations: opts.operations },
      'stream',
      { spec: modelSpec },
    );

    const call = new ProviderCall();

    const result = streamText({
      model: opts.model,
      system: cache.system,
      // OURS, not the vendor's default: how many times the SDK may re-issue a
      // request of its own accord is transport policy, so the count is one we
      // set. See PROVIDER_SDK_RETRIES.
      maxRetries: PROVIDER_SDK_RETRIES,
      messages: [...request],
      tools,
      ...offeredTools,
      // NO STEP CAP. The agentic loop runs until the model stops calling tools;
      // what bounds it lives entirely inside this file and the budget governor —
      // see UNBOUNDED_STEPS.
      stopWhen: opts.stopWhen ?? UNBOUNDED_STEPS,
      // A tool call the SDK cannot parse is rewritten where a rewrite is settled
      // (case-only name drift, fenced or double-encoded arguments) and left to
      // the model's own retry otherwise — no inference behind the spend ledger.
      // Every backend's loop, so a malformed call reads the same on each.
      experimental_repairToolCall: repairToolCall(),
      abortSignal: opts.signal,
      // The SDK's default onError is `console.error(error)`, which dumped the
      // raw provider payload to the terminal alongside our own rendering of it.
      // Capture instead: the error still reaches callers through the rethrow
      // below, so there is exactly one place that decides how a failure reads.
      onError: ({ error }) => { call.streamError = error; },
      experimental_onToolCallStart: ({ toolCall }) => { call.dispatched(toolCall); },
      // The caller's abort interrupts the TURN. This callback is the only
      // terminal handover: an aborted run never settles `result.steps`, so
      // the tail records the finished steps from here.
      onAbort: ({ steps }) => { call.aborted(steps); },
      providerOptions,
      // The shared step pipeline projects native error feedback before extension
      // rewrites, pruning, dynamic context, destination normalization and cache
      // markers. Think's beforeStep uses the same composition and SDK history.
      prepareStep: ({ stepNumber, messages, steps }) =>
        composePrepareStep({
          extensions,
          abortSignal: opts.signal,
          cache: rollTail ? { strategy: cache.strategy } : null,
          prune: { contextWindow, modelOutputLimit },
          budget: opts.budget,
          dynamic: opts.dynamicContext,
          destinationProviderId: opts.cache?.providerId,
          meter: opts.meter,
          context: opts.stepContext,
        }, { stepNumber: stepOffset + stepNumber, messages, steps }),
      onStepFinish: async (step) => {
        stepCount++;
        call.stepFinished(step, stepCount);
        await opts.onStep?.(step);
      },
    });

    suppressDeferredRejections(result, () => call.interrupted || (opts.signal?.aborted ?? false));
    // Started before this reader's own loop, so the transport's tee is taken
    // before any chunk flows; awaited in the tail so the turn cannot settle
    // ahead of the last relayed chunk.
    const observed = opts.observeStream?.(result.toUIMessageStream({ onError: (error) => describeProviderError({ cause: error }) }));

    try {
      // Drained to the SDK's own `abort` part rather than broken out of on
      // `opts.signal.aborted`. Costs nothing — the abort check would sit AFTER
      // this `await`, so both shapes wait for exactly one more chunk — and buys
      // two things: `onAbort` is guaranteed to have run by the time the tail
      // below reads the recorded steps, and a tool result that lands after the
      // abort still reaches the surfaces and the turn's tool ledger instead of
      // leaving the call rendered as never having returned.
      for await (const chunk of result.fullStream) {
        const event = call.consume(chunk);

        if (event !== null) {
          if (event.type === 'text-delta') allText += event.delta;
          await announce(event, chunk);
          yield event;
        }

        // Yield any step-finish events that fired via onStepFinish callback
        yield* call.takeStepEvents();
      }
    } catch (err) {
      // The signal is authoritative. A provider may throw its abort reason before
      // the SDK invokes `onAbort`; waiting on the callback made explicit
      // cancellation look like a provider failure. A cut falls through so the
      // partial turn is yielded as `done`, then throws INTERRUPTED_TURN.
      if (!opts.signal?.aborted) {
        operation.failed({ cause: err });
        throw err;
      }

      call.interrupted = true;
    } finally {
      // The second reader drains the same tee to its end (or its error) before
      // the turn is over: an answer settled while a chunk was still in flight
      // to the client would be persisted short of what the client saw.
      await observed;
    }

    const failure = call.failure(opts);

    if (failure !== null) {
      operation.failed({ cause: failure.cause });
      throw failure.error;
    }

    // The call's steps, and the messages they produced. A CUT run — the caller's
    // abort — leaves `result.response`/`result.steps` unsettled; they resolve only
    // on a natural finish, and a cut before the first step never settles them at
    // all. So a cut call reads what `onAbort` handed over.
    const cut = call.interrupted;

    // The call's frame, closed whichever way it left — not awaited, so the end
    // row lands before the consumer's `turn_end` and a cut path never touches
    // the deferred accessors.
    settleModelOperation(operation, result, cut);
    const steps = cut ? call.recordedSteps : await result.steps;
    const produced = call.produced();

    return {
      steps,
      produced: settleUnpairedToolCalls(produced) ?? produced,
      finishReason: call.lastFinishReason,
      interrupted: cut,
    };
  };

  const first = yield* callModel(cache.messages, 0);
  let steps: readonly StepResult<ToolSet>[] = first.steps;
  let responseMessages: ModelMessage[] = first.produced;
  let interrupted = first.interrupted;

  // THE OUTPUT-LIMIT CONTINUATION: exactly one.
  //
  // A step that ends at OUTPUT_LIMIT_REACHED is a model that had more to say and
  // was not allowed to say it — after prose, and equally after a completed tool
  // result, the case that would otherwise publish a turn as finished with the work
  // after the tool never done. The SDK's own loop does not continue it: it
  // re-issues a request only while a step ended with tool calls whose outputs all
  // landed, so a length finish with no pending call ends the loop and the
  // accumulated partial answer stands as the turn's.
  //
  // The continuation request is the SAME prefix plus what the turn has already
  // produced — every assistant message and every tool result, in order. So the
  // model reads its own truncated answer and the completed calls behind it as
  // history and carries on, and NOTHING is replayed: a completed tool call
  // arrives paired with its result, which is exactly what tells the SDK the call
  // is finished rather than pending. (The trailing assistant text needs no
  // whitespace treatment: `@ai-sdk/anthropic` already trims the final assistant
  // text part of a prefilled block, and it is the one provider that refuses one.)
  //
  // Detection and dispatch are one continuation of this generator — no `yield`
  // and no persistence boundary sits between them, so nothing can reset in
  // between and there is no continuation state for anything to lose. What
  // crosses to the caller is still one `done` with the whole turn in it.
  //
  // A SECOND output-limit finish is honest partial completion, not another
  // request: the turn keeps everything it produced, and the last finish reason
  // still says `length`, so the caller records a turn that ended at the
  // provider's output limit rather than one that answered.
  if (!interrupted && first.finishReason === OUTPUT_LIMIT_REACHED) {
    const continued = yield* callModel([...cache.messages, ...first.produced], first.steps.length);
    steps = [...steps, ...continued.steps];
    responseMessages = [...responseMessages, ...continued.produced];
    interrupted = continued.interrupted;
  }

  const answer = answerFromSteps(steps, interrupted);

  if (answer !== null) allText = answer;

  // If the model produced no text (ended on a tool call), gather from steps
  if (!allText.trim()) {
    for (const step of steps) {
      if (step.text?.trim()) allText += step.text;
    }
  }

  // If still no text, synthesize from tool results
  if (!allText.trim()) {
    const fallback = synthesizeToolFallback(steps);

    if (fallback) allText = fallback;
  }

  await extensions?.emitTurnEnd({ text: allText, responseMessages });
  yield { type: 'done', text: allText, responseMessages };

  // The turn did not finish, and the caller's turn record must say so — but
  // only AFTER `done`, so the history above is durably kept. Being cut is not a
  // failure of the turn's work; losing that work would be.
  if (interrupted) throw new Error(INTERRUPTED_TURN);
}

function parseToolArgs<T>(raw: T): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, raw);

  return parsed.success ? parsed.output : {};
}
