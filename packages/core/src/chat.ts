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
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
  type TextPart,
  type ToolCallPart,
  type StepResult,
  type StopCondition,
} from 'ai';
import { combineAbortSignals } from '@kinu.run/agent-utils';
import { LLM_CALL_MAX_RETRIES, LLM_CALL_TIMEOUT_MS } from './config';
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
import { providerPacer, type ProviderPacer } from './providers/pacing';
import { PROVIDER_SDK_RETRIES, PROVIDER_WAIT_BUDGET_MS } from './providers/rate-limit-retry';
import { diagnostics, KinuError, renderThrownChain } from './obs/index';

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
   * The per-call silence window override, in ms (tests and node loops). Default
   * {@link LLM_CALL_TIMEOUT_MS}. A call where NOTHING flows — no provider chunk,
   * no tool result — for this long is dead: it is aborted and re-issued up to
   * {@link LLM_CALL_MAX_RETRIES} times before the failure surfaces as a turn
   * error. What a caller overrides is the MAGNITUDE, never the mechanism.
   */
  callTimeoutMs?: number;
  /**
   * The provider pacer this turn's watchdog reads declared waits from.
   *
   * Defaults to the isolate's shared {@link providerPacer}, which is also what
   * every provider fetch declares into — so production wires itself and nothing
   * sets this. A suite injects one to drive a mandated wait without waiting out a
   * real `Retry-After`, the same seam and the same reason as `callTimeoutMs`.
   */
  pacer?: ProviderPacer;
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
 * the per-call silence window with its retries below, and whatever extra
 * condition a fork's driver passes as {@link ChatOptions.stopWhen}.
 */
export const UNBOUNDED_STEPS: StopCondition<ToolSet> = () => false;

/**
 * THE TWO REASONS A SILENT TURN ENDS, as the prefixes their messages open with.
 *
 * A turn that ends in silence is durable prose: it lands on
 * `head_journal.error_message`, on `SwarmCandidate.incomplete`, and in the
 * `swarm.branch_failed` event a surface renders. That prose is the ONLY place the
 * two causes were ever distinguished, and they need different answers — a wedge
 * is a fault to investigate, a rate limit is capacity to wait for or pace
 * against. So the two openings are declared here, once, beside the code that
 * builds them, and a reader asks {@link isRateLimitedTurnError} instead of
 * carrying a regex that a reworded sentence silently breaks. That classifier is
 * the whole public surface: the prefixes stay module-scoped so no second reader
 * can grow its own copy of the vocabulary.
 */
const STALLED_TURN_PREFIX = 'Turn stalled:';
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
  //
  // A MANDATED WAIT IS NOT SILENCE, and telling them apart is the whole of the
  // second mechanism below. `withRateLimitRetry` sleeps INSIDE `fetch`, inside
  // `model.doStream()`, upstream of every chunk this watchdog waits for — so a
  // provider that answered "wait 60s" and a provider that died produced the
  // identical observation here, and the turn was ended with "nothing flowed" in
  // both. Measured on the owner's live workspace: two heads of one `ideate` run
  // errored with that text while `wrangler tail` carried `provider.rate_limited`
  // for the same window. The queue was never a wedge.
  //
  // So the retry layer DECLARES its waits (`providers/pacing.ts`) and this timer
  // asks. THE RULE IS ONE LINE: the deadline is `stallTimeoutMs` after the later
  // of the last thing that flowed and the end of the last mandated wait. A wait
  // therefore PUSHES the deadline rather than being deducted from an allowance,
  // and the retried request the wait was taken for gets a full window of its own
  // — it has only just been issued when the wait ends, so ending the turn there
  // would cut it at the exact moment it became able to answer. The waiting one
  // silence may absorb is bounded by PROVIDER_WAIT_BUDGET_MS, derived from the
  // retry policy rather than guessed. And a turn ended after a mandated wait says
  // SO: "the provider rate-limited us" and "this turn is wedged" are different
  // facts, only one is the turn's fault, and they need different answers from
  // whoever reads the row.
  const callTimeoutMs = opts.callTimeoutMs ?? LLM_CALL_TIMEOUT_MS;
  const pacer = opts.pacer ?? providerPacer;
  let watchdog = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let { promise: stallReached, resolve: reportStall } = Promise.withResolvers<typeof STALLED>();
  /** When the current silence began — the last time ANYTHING flowed. The turn's
   *  own clock, so a mandated wait is measured against the same origin the stall
   *  window is. */
  let lastFlowAt = Date.now();
  /** The pacer's declared-wait count when this silence began, so a wait that
   *  opened AND elapsed inside the window is still attributable. Without it a
   *  turn ended just after a short mandated wait reads as unexplained silence
   *  while the cause sits in the log. */
  let declaredAtSilenceStart = 0;
  /** The longest mandated wait observed in this silence, for the turn's own error
   *  text. A quantity nobody could previously state about a rate-limited turn. */
  let mandatedMs = 0;
  /** Whether the silence being timed was mandated by a provider. */
  let rateLimited = false;
  /** Retries the CURRENT call has consumed. Reset the moment any chunk flows —
   *  a call that answers has spent its budget, and the next silent call gets a
   *  fresh one — so the count is per call, never per turn. */
  let callRetries = 0;
  /** Attempts the LAST exhausted call consumed — read by the error text. */
  let retryAttempts = 0;
  const armAt = (ms: number) => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(onDeadline, ms);
  };
  const onDeadline = () => {
    const now = Date.now();
    const waits = pacer.waits();
    if (waits.untilMs > now || waits.declared > declaredAtSilenceStart) rateLimited = true;
    // Honoured only while the waiting asked of THIS silence stays inside the
    // budget. Past it nothing is holding off under instruction any more, so the
    // silence stops being explained and the turn ends.
    const mandated = waits.untilMs - lastFlowAt;
    const honoured = mandated <= PROVIDER_WAIT_BUDGET_MS ? waits.untilMs : 0;
    if (mandated > mandatedMs) mandatedMs = Math.min(mandated, PROVIDER_WAIT_BUDGET_MS);
    const deadline = Math.max(lastFlowAt, honoured) + callTimeoutMs;
    if (deadline > now) {
      if (honoured > now) {
        diagnostics.event('provider.wait_honoured', {
          waiting_ms: honoured - now, mandated_ms: mandated, budget_ms: PROVIDER_WAIT_BUDGET_MS,
        });
      }
      armAt(deadline - now);
      return;
    }
    if (rateLimited) {
      diagnostics.failure(
        'provider.wait_budget_spent',
        new KinuError('unavailable',
          'the provider rate-limited this turn and nothing flowed once its waits elapsed'),
        { mandated_ms: mandatedMs, budget_ms: PROVIDER_WAIT_BUDGET_MS },
      );
    }
    stalled = true;
    watchdog.abort();
    reportStall(STALLED);
  };
  const armStallTimer = () => {
    lastFlowAt = Date.now();
    mandatedMs = 0;
    rateLimited = false;
    declaredAtSilenceStart = pacer.waits().declared;
    armAt(callTimeoutMs);
  };
  const clearStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  // What the caller records. Names what was MEASURED — nothing flowed — rather
  // than only the provider, because a tool call that never returns stalls the
  // same turn through the same silence and used to read as a provider fault.
  //
  // CLASSIFIED, because a swarm node whose row said "stalled" sent its reader
  // looking for a wedge while the log held a rate limit. Both texts open with a
  // declared prefix so a reader classifies through {@link isRateLimitedTurnError}
  // rather than through a regex of its own — the classification exists in one
  // place, where it is built.
  const stallError = () => new Error(rateLimited
    ? `${RATE_LIMITED_TURN_PREFIX} the provider asked this turn to wait `
      + `${Math.round(mandatedMs / 1000)}s against a `
      + `${Math.round(PROVIDER_WAIT_BUDGET_MS / 1000)}s budget, that wait was taken, and still `
      + 'nothing flowed — no provider chunk and no tool result. That is a rate limit rather '
      + 'than a wedged turn.'
    : `${STALLED_TURN_PREFIX} nothing flowed for ${Math.round(callTimeoutMs / 1000)}s — `
      + 'no provider chunk and no tool result — so the turn was ended'
      + (retryAttempts > 0
        ? ` after ${String(retryAttempts + 1)} attempts of the timed-out call.`
        : '.'),
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

  /** One attempt: one model request driven to a terminal. `stalled` means the
   *  silence window killed the request — the caller decides whether the call
   *  retries. Every other terminal either resolves with the finished run's
   *  steps or throws. */
  type DrainedCall =
    | { outcome: 'completed'; steps: PromiseLike<readonly StepResult<ToolSet>[]> }
    | { outcome: 'stalled' };

  /** Issue ONE request and drain it. Everything per-attempt is reset here: a
   *  retried attempt starts clean, because the timed-out call never finished —
   *  its partial content was streamed to the surfaces but no step ever
   *  completed, and a half-step is not history — and a stale error or dead-step
   *  verdict from the killed attempt must not outlive it. */
  const drive = async function* (messages: ModelMessage[]): AsyncGenerator<ChatEvent, DrainedCall> {
    watchdog = new AbortController();
    ({ promise: stallReached, resolve: reportStall } = Promise.withResolvers<typeof STALLED>());
    stalled = false;
    streamError = undefined;
    stepHadOutput = false;
    deadFinalStep = false;
    stepContent = [];
    // The SDK's `step.response.messages` carries THIS request's full array —
    // its input prefix plus everything generated, cumulative across the call's
    // steps — so the capture stays an assignment. A retried attempt is handed
    // the turn's messages so far as its input, so its own arrays continue the
    // same sequence rather than restarting it.

    const result = streamText({
      model: opts.model,
      system: cache.system,
      // OURS, not the vendor's default, and the reason is arithmetic rather than
      // taste: the watchdog's patience is derived from how many times this request
      // may re-enter the rate-limit layer, so that count has to be one we set.
      // See PROVIDER_SDK_RETRIES.
      maxRetries: PROVIDER_SDK_RETRIES,
      messages,
      tools,
      // NO STEP CAP. The agentic loop runs until the model stops calling tools;
      // what bounds it lives entirely inside this file and the budget governor —
      // see UNBOUNDED_STEPS.
      stopWhen: opts.stopWhen ?? UNBOUNDED_STEPS,
      abortSignal: opts.signal ? combineAbortSignals([opts.signal, watchdog.signal]) : watchdog.signal,
      // The SDK's default onError is `console.error(error)`, which dumped the
      // raw provider payload to the terminal alongside our own rendering of it.
      // Capture instead: the error still reaches callers through the rethrow
      // below, so there is exactly one place that decides how a failure reads.
      onError: ({ error }) => { streamError = error; },
      onAbort: ({ steps }) => {
        // THE CALLER'S abort interrupts the TURN; the watchdog's abort ends a
        // CALL, which the retry loop owns. Both hand over steps here (it is the
        // only terminal callback), but only a caller abort sets the flag.
        recordedSteps = steps;
        interrupted = opts.signal?.aborted ?? false;
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
        if (arrival === STALLED) return { outcome: 'stalled' };
        if (arrival.done) break;
        const chunk = arrival.value;
        armStallTimer();
        // Flow. Whatever call this attempt was issuing is answering now, so its
        // retry budget is spent and the NEXT silent call gets a fresh one. An
        // error chunk is not flow — it is the failure being reported.
        if (chunk.type !== 'error') callRetries = 0;

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
      if (!interrupted || !opts.signal?.aborted) {
        if (stalled) return { outcome: 'stalled' };
        if (!interrupted) throw err;
        return { outcome: 'stalled' };
      }
    } finally {
      clearStallTimer();
    }
    return { outcome: 'completed', steps: result.steps };
  };

  // THE RETRY LOOP — the sanctioned bound, applied per call. A request the
  // silence window killed is re-issued from the last FINISHED step boundary,
  // up to LLM_CALL_MAX_RETRIES times; past them the stall surfaces as the
  // turn error it always was. There is deliberately NO other attempt-shaped
  // bound here: no wall clock over the turn, no cap on steps (owner ruling,
  // 2026-08-21).
  let attemptMessages: ModelMessage[] = cache.messages;
  let drained = yield* drive(attemptMessages);
  // The loop owns the attempt count; `callRetries` is the per-call budget the
  // error text reports and the chunk flow resets. Bounding the LOOP on its own
  // counter is what makes exhaustion terminate even if a killed request's
  // teardown spuriously re-arms the silence sentinel.
  while (drained.outcome === 'stalled'
    && !rateLimited
    && retryAttempts < LLM_CALL_MAX_RETRIES
    && !opts.signal?.aborted) {
    retryAttempts++;
    callRetries = retryAttempts;
    diagnostics.event('llm_call.retried', {
      attempt: retryAttempts, max_retries: LLM_CALL_MAX_RETRIES,
    });
    attemptMessages = settleUnpairedToolCalls([...responseSoFar]) ?? [...responseSoFar];
    drained = yield* drive(attemptMessages);
  }

  // A STALLED turn reports the stall even when the killed request's abort
  // surfaced as a late transport error chunk: the silence is the cause; the
  // error is its shadow.
  if (streamError !== undefined && !stalled) {
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
  const steps = cut || drained.outcome === 'stalled'
    ? recordedSteps
    : await drained.steps;
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
  try { return JSON.stringify(raw) ?? String(raw); }
  catch (error) {
    return `unserializable value: ${renderThrownChain({ cause: error })}`;
  }
}
