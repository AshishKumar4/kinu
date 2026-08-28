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
} from 'ai';
import {
  assertToolsSupportedByModel,
  type PromptModelContext,
} from './prompting/model-profile';
import { applyCacheBreakpoints, hasCacheMarkers, type CacheRetention } from './prompting/cache-breakpoints';
import type { TurnContextMeter } from './context-meter';
import { composePrepareStep, type StepDynamicContext } from './prompting/prepare-step';
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
import { EVIDENCE_BUDGETS, evidenceWindow } from './prompts/evidence-window';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from './utils/json';
import { normalizeUsage, usageReported, type Usage } from './usage';
import { PROVIDER_SDK_RETRIES } from './providers/rate-limit-retry';
import { diagnostics, renderThrownChain, toKinuError } from './obs/index';

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
   *  error text on failure; `success`/`error` carry the discriminator the
   *  evolution signal reads (hadError, outcome review) — matching the cf
   *  backend's afterToolCall. */
  | { type: 'tool-result'; toolName: string; toolCallId: string; result: string; success: boolean; error?: string }
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
  | { type: 'step-finish'; stepIndex: number; responseMessages: readonly ModelMessage[]; usage?: Usage }
  /** A failure the turn survived. `runChat` itself never yields this — it
   *  throws, and the caller owns the turn-failure policy. The scaffold seam
   *  (scaffold/chat-transform.ts) does: an evolved scaffold reports a failed
   *  sub-step or a failed run without losing the output already streamed. */
  | { type: 'error'; message: string }
  | { type: 'done'; text: string; responseMessages: ModelMessage[] };

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
   * submitted. Omitted = the provider publishes no count endpoint, and the turn
   * is assembled exactly as it was before admission existed. Never a character
   * estimate: see the module comment there for why an estimate cannot admit.
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
  /** Request-level provider options contributed by the caller. They are
   *  merged by provider namespace with the cache options assembled here. */
  providerOptions?: NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;
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
 * against. Nothing produces the prose any more; the classifier below is what
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
export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  const extensions = opts.extensions;

  // One ToolSet: the caller's tools plus every extension's contributed tools.
  // Extension tools never shadow a caller (built-in) tool of the same name.
  const tools: ToolSet = extensions ? { ...extensions.tools(), ...opts.tools } : opts.tools;
  assertToolsSupportedByModel(opts.modelContext, Object.keys(tools));

  // Channel step-finish events from the onStepFinish callback to the generator.
  // We use a simple array that the generator checks after each stream chunk.
  interface PendingStepEvent {
    stepIndex: number;
    responseMessages: readonly ModelMessage[];
    usage?: Usage;
  }
  /** What ONE provider call of this turn ended with. */
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
     *  below reads. */
    readonly finishReason: string | undefined;
    /** The caller cut the call. */
    readonly interrupted: boolean;
  }
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
  };
  // Exact pre-submission admission, when the caller resolved a provider that
  // can answer what a request costs. The assembly owns the decision (one
  // forced compaction, then a re-count, then a refusal) so neither backend
  // holds a second copy of the policy; the tools that ride every request are
  // part of what is counted, which is why they are handed over here.
  if (opts.countInputTokens) {
    assembly.admission = {
      count: opts.countInputTokens,
      tools,
      limits: { contextWindow, modelOutputLimit },
    };
  }
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

  /** The turn's text, across every provider call the turn takes. */
  let allText = '';

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
    // streamText routes provider failures into the stream as an in-band error
    // chunk instead of throwing — captured here and rethrown VERBATIM after the
    // loop, so callers' failure handling (the overflow-recovery classifier)
    // sees the provider's actual error text, never the opaque
    // AI_NoOutputGeneratedError that awaiting result.response would raise.
    let streamError: unknown;

    // The call was cancelled from outside (the owner pressing stop, a
    // supervisor) rather than failing. An aborted run NEVER settles
    // `result.response` or `result.steps` — they resolve only on a natural
    // finish — so this callback is the only place the SDK hands over the STEPS
    // it did record (the text fallbacks read them). The messages those steps
    // produced are already held by `responseSoFar`, captured per step as each
    // one finished.
    let interrupted = false;
    let recordedSteps: readonly StepResult<ToolSet>[] = [];

    // Dead-stream detection state: a step that finishes with no mapped finish
    // reason ('other'/'unknown') AND produced nothing is a provider stream that
    // died mid-request — the SDK records it as a normal empty step and ends the
    // turn as if the model chose to stop (observed: a bench turn "completed"
    // cleanly, hadError:false, after its second request returned a dead SSE).
    let stepHadOutput = false;
    let deadFinalStep = false;

    /** The mapped finish reason of the last step that finished. What the
     *  output-limit continuation reads, and what a caller records as how the
     *  turn ended. */
    let lastFinishReason: string | undefined;

    // The in-flight step's assistant content, as it streams.
    //
    // An abort ends the SDK's loop mid-step, and the SDK records only steps that
    // FINISHED — so everything the model produced in the step the interrupt
    // landed in is absent from `result.response`, including the tool call the
    // caller has already been handed (and rendered, and recorded). Kept here so
    // an interrupted turn's history says what the turn actually did. Cleared at
    // every step boundary: from there the step is the SDK's to report.
    let stepContent: Array<TextPart | ToolCallPart> = [];

    /** This call's cumulative generated array as of its last finished step. The
     *  SDK accumulates `step.response.messages` within the call and never
     *  includes the input prefix, so that array is what the call generated. */
    let responseSoFar: readonly ModelMessage[] = [];
    const pendingStepEvents: PendingStepEvent[] = [];

    const result = streamText({
      model: opts.model,
      system: cache.system,
      // OURS, not the vendor's default: how many times the SDK may re-issue a
      // request of its own accord is transport policy, so the count is one we
      // set. See PROVIDER_SDK_RETRIES.
      maxRetries: PROVIDER_SDK_RETRIES,
      messages: [...request],
      tools,
      // NO STEP CAP. The agentic loop runs until the model stops calling tools;
      // what bounds it lives entirely inside this file and the budget governor —
      // see UNBOUNDED_STEPS.
      stopWhen: opts.stopWhen ?? UNBOUNDED_STEPS,
      abortSignal: opts.signal,
      // The SDK's default onError is `console.error(error)`, which dumped the
      // raw provider payload to the terminal alongside our own rendering of it.
      // Capture instead: the error still reaches callers through the rethrow
      // below, so there is exactly one place that decides how a failure reads.
      onError: ({ error }) => { streamError = error; },
      onAbort: ({ steps }) => {
        // The caller's abort interrupts the TURN. This callback is the only
        // terminal handover: an aborted run never settles `result.steps`, so
        // the tail records the finished steps from here.
        recordedSteps = steps;
        interrupted = true;
      },
      providerOptions,
      // The shared step pipeline (prompting/prepare-step.ts): extension rewrites
      // first, then step-boundary tool-output pruning against the window budget,
      // then the dynamic-context weave, cache tail markers LAST onto the final
      // array. The cf orchestrator's beforeStep runs the identical composition.
      prepareStep: ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) =>
        composePrepareStep({
          extensions,
          cache: rollTail ? { strategy: cache.strategy } : null,
          prune: { contextWindow, modelOutputLimit },
          budget: opts.budget,
          dynamic: opts.dynamicContext,
          destinationProviderId: opts.cache?.providerId,
          meter: opts.meter,
        }, { stepNumber: stepOffset + stepNumber, messages }),
      onStepFinish: async (step) => {
        stepCount++;
        const usage = normalizeUsage(step.usage);
        responseSoFar = [...step.response.messages];
        const event: PendingStepEvent = { stepIndex: stepCount, responseMessages: responseSoFar };
        if (usageReported(usage)) event.usage = usage;
        pendingStepEvents.push(event);
        await opts.onStep?.(step);
      },
    });
    // A call that never finishes a step — the provider failed before one, or the
    // caller cut the call — makes the SDK REJECT its deferred accessors (`steps`,
    // `finishReason`, `rawFinishReason`, `totalUsage`) when the stream ends. The
    // turn reports all of those through the streamed error or the interrupt path
    // and never reads the deferrals, and a rejection nobody reads is an unhandled
    // one that crashes test files and pollutes DO logs. The zero-steps rejection
    // is classified by type; a cut is classified by the state that caused it;
    // anything else is recorded, because a deferred rejecting on a turn that
    // finished naturally would be a defect here and must be visible.
    const ignoreDeferred = (error: Error): void => {
      if (NoOutputGeneratedError.isInstance(error)) return;
      if (interrupted || (opts.signal?.aborted ?? false)) return;
      diagnostics.failure(
        'llm_call.deferred_rejected',
        toKinuError({ doing: 'settle an unread stream accessor', cause: error, otherwise: 'io' }),
      );
    };
    result.steps.then(undefined, ignoreDeferred);
    result.finishReason.then(undefined, ignoreDeferred);
    result.rawFinishReason.then(undefined, ignoreDeferred);
    result.totalUsage.then(undefined, ignoreDeferred);

    try {
      // Drained to the SDK's own `abort` part rather than broken out of on
      // `opts.signal.aborted`. Costs nothing — the abort check would sit AFTER
      // this `await`, so both shapes wait for exactly one more chunk — and buys
      // two things: `onAbort` is guaranteed to have run by the time the tail
      // below reads `recordedSteps`, and a tool result that lands after the
      // abort still reaches the surfaces and the turn's tool ledger instead of
      // leaving the call rendered as never having returned.
      for await (const chunk of result.fullStream) {
        switch (chunk.type) {
          case 'text-delta': {
            const delta = chunk.text;
            if (delta) {
              stepHadOutput = true;
              allText += delta;
              stepContent.push({ type: 'text', text: delta });
              yield { type: 'text-delta', delta };
            }
            break;
          }
          case 'reasoning-delta': {
            const delta = chunk.text;
            if (delta) yield { type: 'reasoning-delta', delta };
            break;
          }
          case 'tool-call': {
            stepHadOutput = true;
            const args = parseToolArgs(chunk.input);
            stepContent.push({
              type: 'tool-call', toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input,
            });
            await extensions?.emitToolCall({ toolName: chunk.toolName, args });
            yield { type: 'tool-call', toolName: chunk.toolName, toolCallId: chunk.toolCallId, args };
            break;
          }
          case 'tool-result': {
            const raw = chunk.output;
            // Full text, never a head slice: this string is the call's durable
            // record (recordToolCall → the evolution signal) AND the identity the
            // turn steering hashes. A clipped copy made two different outputs
            // sharing a long preamble hash identical, and made cf and the CLI
            // record different evolution evidence for the same call. Every
            // display path bounds it at render.
            const rendered = renderToolResult(raw);
            const input = parseToolArgs(chunk.input);
            await extensions?.emitToolResult({ toolName: chunk.toolName, args: input, result: rendered, success: true });
            yield { type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result: rendered, success: true };
            break;
          }
          case 'tool-error': {
            // A tool threw: the error is the durable outcome the evolution signal
            // reads. The extension seam sees the error text as the result (same as
            // the cf afterToolCall), and the discriminator rides success/error.
            const error = describeProviderError({ cause: chunk.error });
            const input = parseToolArgs(chunk.input);
            await extensions?.emitToolResult({ toolName: chunk.toolName, args: input, result: error, success: false });
            yield { type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result: error, success: false, error };
            break;
          }
          case 'finish-step': {
            // A finished step with no mapped finish reason and no output is a
            // provider stream that died (closed early, empty SSE, dropped route):
            // the model never chose to stop. Reasoning-only steps count as dead
            // too — a turn cannot proceed from thinking that never landed.
            const reason = chunk.finishReason;
            lastFinishReason = reason;
            deadFinalStep = !stepHadOutput && reason === 'other';
            stepHadOutput = false;
            stepContent = [];
            break;
          }
          case 'error': {
            streamError = chunk.error;
            break;
          }
        }

        // Yield any step-finish events that fired via onStepFinish callback
        while (pendingStepEvents.length > 0) {
          const ev = pendingStepEvents.shift();
          if (ev) yield { type: 'step-finish' as const, ...ev };
        }
      }
    } catch (err) {
      // The signal is authoritative. A provider may throw its abort reason before
      // the SDK invokes `onAbort`; waiting on the callback made explicit
      // cancellation look like a provider failure. A cut falls through so the
      // partial turn is yielded as `done`, then throws INTERRUPTED_TURN.
      if (!opts.signal?.aborted) throw err;
      interrupted = true;
    }

    // A DEFINITIVE provider or transport failure crosses as a CLASSIFIED failure
    // when the caller did not cancel the turn. It used to be rethrown verbatim,
    // which meant an `APICallError` reached the CLI and the chat surface with its
    // raw `responseBody` still attached and its own message saying only
    // "AI_APICallError" — so the overflow-recovery classifier read nothing usable
    // while the user read the endpoint's whole body. `toProviderError` puts the
    // provider's own reason (and its status/code) in the message and keeps the
    // raw failure on `cause`, where diagnostics can still reach it.
    if (streamError !== undefined && !interrupted) {
      throw toProviderError({ doing: 'calling the model', cause: streamError });
    }
    if (deadFinalStep && !interrupted) {
      // Deliberately still a bare throw, unlike the interrupt: this turn was
      // never cut. It ran to a natural end and what is being rejected is
      // the RESULT, so there is no "work the cancellation discarded" to rescue —
      // and the empty dead step would ride into the durable history with nothing
      // established about what an empty assistant message does on replay.
      throw new Error(
        'Model stream ended without output: the provider stream terminated prematurely ' +
        '(no finish reason, no content). The turn did not complete.',
      );
    }

    // The call's steps, and the messages they produced. A CUT run — the caller's
    // abort — leaves `result.response`/`result.steps` unsettled; they resolve only
    // on a natural finish, and a cut before the first step never settles them at
    // all. So a cut call reads what `onAbort` handed over.
    //
    // The MESSAGES need no such branch: `responseSoFar` is the cumulative array
    // of the last step that finished, captured as it finished, and that is the
    // whole call on either path. It is also, message for message, what the
    // per-step durable rows hold — the history the caller persists and the
    // durable record are one construction, so neither can say something the
    // other does not.
    const cut = interrupted;
    const steps = cut ? recordedSteps : await result.steps;
    const finished = [...responseSoFar];
    // Then what the cut interrupted: the step the SDK will never report, and the
    // pairing invariant over the whole call, so the caller persists a history a
    // follow-up turn can be built from. Without it a tool call the caller has
    // already recorded has no result anywhere, and `streamText` refuses to
    // assemble EVERY later request from that history — including the
    // continuation request below, whose prefix IS this array.
    const produced = cut && stepContent.length > 0
      ? [...finished, { role: 'assistant' as const, content: stepContent }]
      : finished;
    return {
      steps,
      produced: settleUnpairedToolCalls(produced) ?? produced,
      finishReason: lastFinishReason,
      interrupted,
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
  // result, which is the case that used to publish a turn as finished with the
  // work after the tool never done. The SDK's own loop does not continue it: it
  // re-issues a request only while a step ended with tool calls whose outputs all
  // landed, so a length finish with no pending call ends the loop, and the
  // accumulated partial answer was accepted as the turn's.
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

  // If the model produced no text (ended on a tool call), gather from steps
  if (!allText.trim()) {
    for (const step of steps) {
      if (step.text?.trim()) allText += step.text;
    }
  }

  // If still no text, synthesize from tool results
  if (!allText.trim()) {
    const summaries: string[] = [];
    for (const step of steps) {
      for (const tr of step.toolResults) {
        const output = tr.output;
        summaries.push(`[${tr.toolName}] ${evidenceWindow(renderToolResult(output), EVIDENCE_BUDGETS.toolFallbackSummary)}`);
      }
    }
    if (summaries.length > 0) allText = summaries.join('\n');
  }

  await extensions?.emitTurnEnd({ text: allText, responseMessages });
  yield { type: 'done', text: allText, responseMessages };

  // The turn did not finish, and the caller's turn record must say so — but
  // only AFTER `done`, so the history above is durably kept. Being cut is not a
  // failure of the turn's work; losing that work would be.
  if (interrupted) throw new Error(INTERRUPTED_TURN);
}

/** Render a tool result for the observability event stream and the no-text
 *  turn-summary fallback. The model receives the real object through the AI
 *  SDK's message history; this is the trajectory/human-facing rendering, so a
 *  structured result must serialize to its content — never `String({...})`'s
 *  "[object Object]". */
function parseToolArgs<T>(raw: T): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, raw);
  return parsed.success ? parsed.output : {};
}

function renderToolResult<T>(raw: T): string {
  const text = v.safeParse(v.string(), raw);
  if (text.success) return text.output;
  if (raw == null) return '';
  try { return JSON.stringify(raw) ?? String(raw); }
  catch (error) {
    return `unserializable value: ${renderThrownChain({ cause: error })}`;
  }
}
