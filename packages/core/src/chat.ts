/**
 * Shared chat engine — one implementation used by both the server and CLI.
 *
 * Yields streaming events (text deltas, tool calls, tool results) and
 * returns the FULL ModelMessage array including tool call/result messages.
 * Callers store these messages in history so the model sees tool context
 * on subsequent turns.
 */

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
  type TextPart,
  type ToolCallPart,
  type StepResult,
  type StopCondition,
} from 'ai';
import { combineAbortSignals } from '@kinu.run/agent-utils';
import { DEFAULT_MAX_STEPS } from './config';
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
import type { ExtensionHost } from './extension';
import { mergeProviderOptions } from './strategy/effort';
import { describeProviderError } from './providers/util';
import { EVIDENCE_BUDGETS, evidenceWindow } from './prompts/evidence-window';
import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from './utils/json';
import { normalizeUsage, usageReported, type Usage } from './usage';

export type ChatEvent =
  | { type: 'text-delta'; delta: string }
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
  maxSteps?: number;
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
  /** Stream-inactivity watchdog override (tests). Default STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
  /**
   * One more reason this turn may stop, ORed with the step cap.
   *
   * A fork's turn stops for things a chat's does not: the abort flag its
   * spawner polls, the wall clock the search granted it, and an ASYNC mission
   * guard — a hosted head charges its parent's ledger over an RPC, which the
   * synchronous {@link ChatOptions.budget} governor cannot express. One extra
   * condition rather than a second loop; the SDK ORs an array of them.
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
   * to another Durable Object and the next request must not be issued while
   * the trace of the previous step is still in flight.
   *
   * Errors are the sink's own: a throw here rejects the turn, exactly as a
   * throw from `prepareStep` does, so a sink that must survive its own
   * failures handles them (heads/head-inference.ts does).
   */
  onStep?: (step: StepResult<ToolSet>) => Promise<void> | void;
}

/** Abort the turn when NOTHING flows for this long — no provider chunk, no
 *  tool result. A provider stream that stalls mid-step otherwise hangs the
 *  turn forever: the AI SDK's own chunk timeout only arms once a first chunk
 *  has arrived, so a request that goes silent from the start is unguarded.
 *  Generously above every legitimate gap: inline tool calls detach to the
 *  background at 30s, and even cold-route reasoning models first-chunk well
 *  under five minutes. */
export const STALL_TIMEOUT_MS = 300_000;

/** The watchdog's own arrival value, distinguishable from every iterator result
 *  because it is a unique symbol and an iterator result is an object. */
const STALLED = Symbol('turn-stalled');

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
 * A CUT turn — the caller's abort, or the stall watchdog firing — yields `done`
 * and THEN throws ({@link INTERRUPTED_TURN}, or the named stall). The history it
 * produced is the record of what the turn did: every completed step, plus the
 * step the cut landed in, with a terminal result for the call that never
 * returned. The throw is how the caller records that the turn did not finish.
 * Both are true, and a caller that persists on `done` and flags the turn on a
 * throw already does the right thing with both. A dead provider stream is the
 * one terminal that still throws WITHOUT a `done` — see its site for why.
 */
export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
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
  const pendingStepEvents: PendingStepEvent[] = [];
  let stepCount = 0;
  /** The SDK's cumulative response array as of the last step that FINISHED —
   *  the one source for the turn's produced messages, on both the natural and
   *  the cut path. `result.response` says the same thing but only settles on a
   *  natural finish, and every step's array is cumulative, so reading it here
   *  costs one assignment and removes the branch. */
  let responseSoFar: readonly ModelMessage[] = [];

  // The shared turn-context assembly (orchestrator/turn-context.ts): attachment
  // sanitize → extension onTurnStart → awaited transformContext (compaction) →
  // turn-local tail. The cf backend's beforeTurn runs the SAME function, so the
  // ordering cannot drift per backend.
  const contextWindow = opts.modelContext?.contextWindow
    ?? contextWindowForModel(opts.modelContext?.id ?? '');
  const turnMessages = await assembleTurnMessages({
    system: opts.system,
    history: opts.history,
    attachments: opts.attachments,
    extensions,
    turnLocal: opts.turnLocal,
    sessionKey: opts.cache?.sessionKey ?? '',
    contextWindow,
    providerReportedTokens: opts.providerReportedTokens,
    trigger: opts.transformTrigger ?? 'auto',
  });

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

  // streamText routes provider failures into the stream as an in-band error
  // chunk instead of throwing — captured here and rethrown VERBATIM after the
  // loop, so callers' failure handling (the overflow-recovery classifier)
  // sees the provider's actual error text, never the opaque
  // AI_NoOutputGeneratedError that awaiting result.response would raise.
  let streamError: unknown;

  // Stream-inactivity watchdog: a turn where NOTHING flows — no provider chunk,
  // no tool result — is ended after stallTimeoutMs and surfaced as a turn
  // failure. Otherwise the turn hangs until whatever supervises the process
  // kills it, with no error recorded anywhere; a swarm node had no supervisor at
  // all and held one measured run for sixty-three minutes.
  //
  // IT CANNOT BE THE ABORT SIGNAL ALONE, and that is measured rather than
  // assumed: the SDK awaits `model.doStream(...)` before it has a stream to
  // abort, so a request that never answers leaves the signal with nothing to
  // interrupt — the exact case whose 5,000 ms test timeout proved it. So the
  // watchdog resolves a SENTINEL that the drain races each iterator step
  // against, and the abort is what stops the provider afterwards rather than
  // what ends the wait.
  const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const watchdog = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const { promise: stallReached, resolve: reportStall } = Promise.withResolvers<typeof STALLED>();
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      watchdog.abort();
      reportStall(STALLED);
    }, stallTimeoutMs);
  };
  const clearStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  // What the caller records. Names what was MEASURED — nothing flowed — rather
  // than only the provider, because a tool call that never returns stalls the
  // same turn through the same silence and used to read as a provider fault.
  const stallError = () => new Error(
    `Turn stalled: nothing flowed for ${Math.round(stallTimeoutMs / 1000)}s — no provider chunk `
    + 'and no tool result — so the turn was ended.',
  );

  // The turn's constants for the per-step breakdown: the cache-eligible system
  // is the text that actually rides the request, and the merged ToolSet is the
  // schema payload that rides it every step.
  opts.meter?.openTurn({ system: cache.system, tools });

  // The turn was cancelled from outside (the owner pressing stop, a supervisor)
  // rather than failing. An aborted run NEVER settles `result.response` or
  // `result.steps` — they resolve only on a natural finish — so this callback is
  // the only place the SDK hands over the STEPS it did record (the tail's text
  // fallbacks read them). The messages those steps produced are already held by
  // `responseSoFar`, captured per step as each one finished.
  let interrupted = false;
  let recordedSteps: readonly StepResult<ToolSet>[] = [];

  const result = streamText({
    model: opts.model,
    system: cache.system,
    messages: cache.messages,
    tools,
    // The step cap always applies; a fork's driver ORs its own reasons onto it
    // (abort flag, granted wall clock, async mission guard) rather than running
    // a second loop that would have to re-derive everything below.
    stopWhen: opts.stopWhen ? [stepCountIs(maxSteps), opts.stopWhen] : stepCountIs(maxSteps),
    abortSignal: opts.signal ? combineAbortSignals([opts.signal, watchdog.signal]) : watchdog.signal,
    // The SDK's default onError is `console.error(error)`, which dumped the
    // raw provider payload to the terminal alongside our own rendering of it.
    // Capture instead: the error still reaches callers through the rethrow
    // below, so there is exactly one place that decides how a failure reads.
    onError: ({ error }) => { streamError = error; },
    onAbort: ({ steps }) => { interrupted = true; recordedSteps = steps; },
    providerOptions,
    // The shared step pipeline (prompting/prepare-step.ts): extension rewrites
    // first, then step-boundary tool-output pruning against the window budget,
    // then the dynamic-context weave, cache tail markers LAST onto the final
    // array. The cf orchestrator's beforeStep runs the identical composition.
    prepareStep: ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) =>
      composePrepareStep({
        extensions,
        cache: rollTail ? { strategy: cache.strategy } : null,
        prune: { contextWindow },
        budget: opts.budget,
        dynamic: opts.dynamicContext,
        meter: opts.meter,
      }, { stepNumber, messages }),
    onStepFinish: async (step) => {
      stepCount++;
      const usage = normalizeUsage(step.usage);
      responseSoFar = step.response.messages;
      const event: PendingStepEvent = { stepIndex: stepCount, responseMessages: responseSoFar };
      if (usageReported(usage)) event.usage = usage;
      pendingStepEvents.push(event);
      await opts.onStep?.(step);
    },
  });

  let allText = '';

  // Dead-stream detection state: a step that finishes with no mapped finish
  // reason ('other'/'unknown') AND produced nothing is a provider stream that
  // died mid-request — the SDK records it as a normal empty step and ends the
  // turn as if the model chose to stop (observed: a bench turn "completed"
  // cleanly, hadError:false, after its second request returned a dead SSE).
  let stepHadOutput = false;
  let deadFinalStep = false;

  // The in-flight step's assistant content, as it streams.
  //
  // An abort ends the SDK's loop mid-step, and the SDK records only steps that
  // FINISHED — so everything the model produced in the step the interrupt
  // landed in is absent from `result.response`, including the tool call the
  // caller has already been handed (and rendered, and recorded). Kept here so
  // an interrupted turn's history says what the turn actually did. Cleared at
  // every step boundary: from there the step is the SDK's to report.
  let stepContent: Array<TextPart | ToolCallPart> = [];

  armStallTimer();
  try {
    // Drained to the SDK's own `abort` part rather than broken out of on
    // `opts.signal.aborted`. Costs nothing — the abort check would sit AFTER
    // this `await`, so both shapes wait for exactly one more chunk — and buys
    // two things: `onAbort` is guaranteed to have run by the time the tail
    // below reads `recordedSteps`, and a tool result that lands after the
    // abort still reaches the surfaces and the turn's tool ledger instead of
    // leaving the call rendered as never having returned.
    //
    // Stepped by hand rather than `for await`, and RACED against the watchdog,
    // because the wait this has to bound is a wait the SDK is inside: the first
    // `next()` does not resolve until `model.doStream(...)` does, and a request
    // that never answers therefore ignores the abort signal entirely. Racing is
    // the only place the silence is observable.
    const arrivals = result.fullStream[Symbol.asyncIterator]();
    for (;;) {
      const arrival = await Promise.race([arrivals.next(), stallReached]);
      if (arrival === STALLED) break;
      if (arrival.done) break;
      const chunk = arrival.value;
      armStallTimer();

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
          const result = renderToolResult(raw);
          const input = parseToolArgs(chunk.input);
          await extensions?.emitToolResult({ toolName: chunk.toolName, args: input, result, success: true });
          yield { type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result, success: true };
          break;
        }
        case 'tool-error': {
          // A tool threw: the error is the durable outcome the evolution signal
          // reads. The extension seam sees the error text as the result (same as
          // the cf afterToolCall), and the discriminator rides success/error.
          const error = describeProviderError(chunk.error);
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
    // A cut turn falls through to the tail so the steps it DID finish are still
    // recorded, and its throw moves to after `done`. Only when `onAbort` made
    // the handover: without recorded steps there is nothing to carry, and the
    // watchdog abort's opaque AbortError still has to be named as a stall
    // rather than leaking the mechanism.
    if (!interrupted) {
      if (stalled) throw stallError();
      throw err;
    }
  } finally {
    clearStallTimer();
  }

  if (streamError !== undefined) {
    throw streamError instanceof Error ? streamError : new Error(describeProviderError(streamError));
  }
  if (deadFinalStep && !interrupted) {
    // Deliberately still a bare throw, unlike the stall and the interrupt: this
    // turn was never cut. It ran to a natural end and what is being rejected is
    // the RESULT, so there is no "work the cancellation discarded" to rescue —
    // and the empty dead step would ride into the durable history with nothing
    // established about what an empty assistant message does on replay.
    throw new Error(
      'Model stream ended without output: the provider stream terminated prematurely ' +
      '(no finish reason, no content). The turn did not complete.',
    );
  }

  // The turn's steps, and the messages they produced. A CUT run — the caller's
  // abort, or the watchdog observing that nothing flowed — leaves
  // `result.response`/`result.steps` unsettled; they resolve only on a natural
  // finish, and a cut before the first step never settles them at all. So a cut
  // turn reads what `onAbort` handed over, and a STALL is cut whether or not
  // `onAbort` ran: the drain stopped racing a `next()` that the SDK is still
  // inside, so awaiting `result.steps` here would hang on the very wait the
  // watchdog just ended.
  //
  // The MESSAGES need no such branch: `responseSoFar` is the cumulative array
  // of the last step that finished, captured as it finished, and that is the
  // whole turn on either path. It is also, message for message, what the per-step
  // durable rows hold — the history the caller persists and the durable record
  // are one construction, so neither can say something the other does not.
  const cut = interrupted || stalled;
  const steps = cut ? recordedSteps : await result.steps;
  const finished = [...responseSoFar];
  // Then what the cut interrupted: the step the SDK will never report, and the
  // pairing invariant over the whole turn, so the caller persists a history a
  // follow-up turn can be built from. Without it a tool call the caller has
  // already recorded has no result anywhere, and `streamText` refuses to
  // assemble EVERY later request from that history.
  const produced = cut && stepContent.length > 0
    ? [...finished, { role: 'assistant' as const, content: stepContent }]
    : finished;
  const responseMessages = settleUnpairedToolCalls(produced) ?? produced;

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

  // The turn did not finish, and the caller's turn record must say so — but only
  // AFTER `done`, so the history above is durably kept. Being cut is not a
  // failure of the turn's work; losing that work would be. The stall is checked
  // first because a watchdog abort sets both flags, and "the provider went
  // silent" is the more specific truth.
  if (stalled) throw stallError();
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
  try { return JSON.stringify(raw) ?? String(raw); } catch { return String(raw); }
}
