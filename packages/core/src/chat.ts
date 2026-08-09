/**
 * Shared chat engine — one implementation used by both the server and CLI.
 *
 * Yields streaming events (text deltas, tool calls, tool results) and
 * returns the FULL ModelMessage array including tool call/result messages.
 * Callers store these messages in history so the model sees tool context
 * on subsequent turns.
 */

import { streamText, stepCountIs, type ModelMessage, type ToolSet, type LanguageModel } from 'ai';
import { combineAbortSignals } from '@proteus/agent-utils';
import { resolveMaxSteps } from './config.js';
import {
  assertToolsSupportedByModel,
  type PromptModelContext,
} from './prompting/model-profile.js';
import { applyCacheBreakpoints, hasCacheMarkers, type CacheRetention } from './prompting/cache-breakpoints.js';
import { composePrepareStep } from './prompting/prepare-step.js';
import type { MissionGovernor } from './mission-budget.js';
import type { AttachmentPolicy } from './prompting/attachment-sanitizer.js';
import { assembleTurnMessages } from './orchestrator/turn-context.js';
import { contextWindowForModel } from './context-window.js';
import type { EphemeralContextLedger, SystemStateContext } from './prompting/volatile-context.js';
import type { ExtensionHost } from './extension.js';
import { mergeProviderOptions } from './strategy/effort.js';
import { describeProviderError } from './providers/util.js';

export type ChatEvent =
  | { type: 'text-delta'; delta: string }
  /** `toolCallId` is the provider's own id for the call — the key that pairs
   *  this event with its 'tool-result'. Surfaces that report calls out of band
   *  (ACP's tool_call/tool_call_update) need it; name alone cannot pair
   *  concurrent calls to the same tool. */
  | { type: 'tool-call'; toolName: string; toolCallId: string; args: Record<string, unknown> }
  /** A tool call settled. `result` is the stringified output on success or the
   *  error text on failure; `success`/`error` carry the discriminator the
   *  evolution signal reads (hadError, outcome review) — matching the cf
   *  backend's afterToolCall. */
  | { type: 'tool-result'; toolName: string; toolCallId: string; result: string; success: boolean; error?: string }
  /** `inputTokens`/`outputTokens`/`cachedInputTokens` = the step request's
   *  provider-reported totals, when reported — inputTokens doubles as the
   *  caller's measured compaction signal, cachedInputTokens feeds cache
   *  telemetry. */
  | { type: 'step-finish'; stepIndex: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
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
  /** Per-activation ephemeral system-state ledger + this turn's state
   *  snapshot — woven into the (transformed) durable history at the blocks'
   *  frozen positions, AFTER transformContext so a compaction plugin never
   *  sees or persists a block. */
  systemState?: { ledger: EphemeralContextLedger; context: SystemStateContext };
  /** Turn-local context (skill activation reasons, device notice) — spliced
   *  after the ledger weave for THIS turn only; never visible to a transform
   *  and never treated as durable history. */
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
   *  `inputTokens`. */
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
}

/** Abort the turn when NOTHING flows for this long — no provider chunk, no
 *  tool result. A provider stream that stalls mid-step otherwise hangs the
 *  turn forever: the AI SDK's own chunk timeout only arms once a first chunk
 *  has arrived, so a request that goes silent from the start is unguarded.
 *  Generously above every legitimate gap: inline tool calls detach to the
 *  background at 30s, and even cold-route reasoning models first-chunk well
 *  under five minutes. */
export const STALL_TIMEOUT_MS = 300_000;

/**
 * Run one chat turn. Yields streaming events and finishes with a 'done'
 * event containing the full text and the SDK's response messages.
 *
 * The response messages include assistant messages (with tool_call parts)
 * and tool messages (with tool_result parts). Callers MUST append these
 * to the conversation history — not just the flat text.
 */
export async function* runChat(opts: ChatOptions): AsyncGenerator<ChatEvent> {
  const maxSteps = opts.maxSteps ?? resolveMaxSteps();
  const extensions = opts.extensions;

  // One ToolSet: the caller's tools plus every extension's contributed tools.
  // Extension tools never shadow a caller (built-in) tool of the same name.
  const tools: ToolSet = extensions ? { ...extensions.tools(), ...opts.tools } : opts.tools;
  assertToolsSupportedByModel(opts.modelContext, Object.keys(tools));

  // Channel step-finish events from the onStepFinish callback to the generator.
  // We use a simple array that the generator checks after each stream chunk.
  const pendingStepEvents: Array<{ stepIndex: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }> = [];
  let stepCount = 0;

  // The shared turn-context assembly (orchestrator/turn-context.ts): attachment
  // sanitize → extension onTurnStart → awaited transformContext (compaction) →
  // ledger weave → turn-local tail. The cf backend's beforeTurn runs the SAME
  // function, so the ordering cannot drift per backend.
  const contextWindow = opts.modelContext?.contextWindow
    ?? contextWindowForModel(opts.modelContext?.id ?? '');
  const turnMessages = await assembleTurnMessages({
    system: opts.system,
    history: opts.history,
    ...(opts.attachments ? { attachments: opts.attachments } : {}),
    ...(extensions ? { extensions } : {}),
    ...(opts.systemState ? { systemState: opts.systemState } : {}),
    ...(opts.turnLocal ? { turnLocal: opts.turnLocal } : {}),
    sessionKey: opts.cache?.sessionKey ?? '',
    contextWindow,
    ...(opts.providerReportedTokens !== undefined
      ? { providerReportedTokens: opts.providerReportedTokens }
      : {}),
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
    ...(opts.cache?.retention ? { retention: opts.cache.retention } : {}),
  });
  const rollTail = hasCacheMarkers(cache.strategy);
  const providerOptions = mergeProviderOptions(cache.providerOptions, opts.providerOptions);

  // streamText routes provider failures into the stream as an in-band error
  // chunk instead of throwing — captured here and rethrown VERBATIM after the
  // loop, so callers' failure handling (the overflow-recovery classifier)
  // sees the provider's actual error text, never the opaque
  // AI_NoOutputGeneratedError that awaiting result.response would raise.
  let streamError: unknown;

  // Stream-inactivity watchdog: a provider stream that goes silent mid-turn
  // (no chunk, no tool result) is aborted after stallTimeoutMs and surfaced
  // as a turn failure — otherwise the turn hangs until whatever supervises
  // the process kills it, with no error recorded anywhere.
  const stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const watchdog = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      watchdog.abort();
    }, stallTimeoutMs);
  };
  const clearStallTimer = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const stallError = () => new Error(
    `Model stream stalled: no data from the provider for ${Math.round(stallTimeoutMs / 1000)}s — the turn was aborted.`,
  );

  const result = streamText({
    model: opts.model,
    system: cache.system,
    messages: cache.messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal: opts.signal ? combineAbortSignals([opts.signal, watchdog.signal]) : watchdog.signal,
    // The SDK's default onError is `console.error(error)`, which dumped the
    // raw provider payload to the terminal alongside our own rendering of it.
    // Capture instead: the error still reaches callers through the rethrow
    // below, so there is exactly one place that decides how a failure reads.
    onError: ({ error }) => { streamError = error; },
    ...(providerOptions ? { providerOptions } : {}),
    // The shared step pipeline (prompting/prepare-step.ts): extension rewrites
    // first, then step-boundary tool-output pruning against the window budget,
    // cache tail markers LAST onto the final array. The cf orchestrator's
    // beforeStep runs the identical composition.
    prepareStep: ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) =>
      composePrepareStep(extensions, { stepNumber, messages },
        rollTail ? { strategy: cache.strategy } : null,
        { contextWindow }, opts.budget),
    onStepFinish: (step) => {
      stepCount++;
      const inputTokens = step.usage?.inputTokens;
      const outputTokens = step.usage?.outputTokens;
      // Cached prefix tokens: the OpenAI/Workers-AI family reports them on
      // usage.cachedInputTokens, Anthropic in providerMetadata — combine both
      // into the one flat number the ChatEvent carries (the accumulator reads
      // both sources too, so a CLI consumer passing only cachedInputTokens is
      // faithful and never double-counts).
      const anthropicCacheRead = step.providerMetadata?.anthropic?.cacheReadInputTokens;
      const cachedInputTokens = (step.usage?.cachedInputTokens ?? 0)
        + (typeof anthropicCacheRead === 'number' ? anthropicCacheRead : 0);
      pendingStepEvents.push({
        stepIndex: stepCount,
        ...(typeof inputTokens === 'number' && inputTokens > 0 ? { inputTokens } : {}),
        ...(typeof outputTokens === 'number' && outputTokens > 0 ? { outputTokens } : {}),
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      });
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

  armStallTimer();
  try {
    for await (const chunk of result.fullStream) {
      armStallTimer();
      if (opts.signal?.aborted) break;

      switch (chunk.type) {
        case 'text-delta': {
          const delta = (chunk as any).textDelta ?? (chunk as any).text ?? '';
          if (delta) {
            stepHadOutput = true;
            allText += delta;
            yield { type: 'text-delta', delta };
          }
          break;
        }
        case 'tool-call': {
          stepHadOutput = true;
          const args = ((chunk as any).input ?? (chunk as any).args ?? {}) as Record<string, unknown>;
          await extensions?.emitToolCall({ toolName: chunk.toolName, args });
          yield { type: 'tool-call', toolName: chunk.toolName, toolCallId: chunk.toolCallId, args };
          break;
        }
        case 'tool-result': {
          const raw = (chunk as any).output ?? (chunk as any).result ?? '';
          const result = renderToolResult(raw).slice(0, 1000);
          await extensions?.emitToolResult({ toolName: chunk.toolName, result, success: true });
          yield { type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result, success: true };
          break;
        }
        case 'tool-error': {
          // A tool threw: the error is the durable outcome the evolution signal
          // reads. The extension seam sees the error text as the result (same as
          // the cf afterToolCall), and the discriminator rides success/error.
          const error = describeProviderError((chunk as any).error);
          const result = error.slice(0, 1000);
          await extensions?.emitToolResult({ toolName: chunk.toolName, result, success: false });
          yield { type: 'tool-result', toolName: chunk.toolName, toolCallId: chunk.toolCallId, result, success: false, error };
          break;
        }
        case 'finish-step': {
          // A finished step with no mapped finish reason and no output is a
          // provider stream that died (closed early, empty SSE, dropped route):
          // the model never chose to stop. Reasoning-only steps count as dead
          // too — a turn cannot proceed from thinking that never landed.
          const reason = String((chunk as { finishReason?: unknown }).finishReason ?? '');
          deadFinalStep = !stepHadOutput && (reason === 'other' || reason === 'unknown' || reason === '');
          stepHadOutput = false;
          break;
        }
        case 'error': {
          streamError = (chunk as { error: unknown }).error;
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
    // The watchdog abort usually surfaces as an opaque AbortError from the
    // stream — name the stall instead of leaking the mechanism.
    if (stalled) throw stallError();
    throw err;
  } finally {
    clearStallTimer();
  }

  if (stalled) throw stallError();
  if (streamError !== undefined) {
    throw streamError instanceof Error ? streamError : new Error(describeProviderError(streamError));
  }
  if (deadFinalStep && !opts.signal?.aborted) {
    throw new Error(
      'Model stream ended without output: the provider stream terminated prematurely ' +
      '(no finish reason, no content). The turn did not complete.',
    );
  }

  // Await the full result to get response messages
  const response = await result.response;
  const steps = await result.steps;
  const responseMessages = response.messages as ModelMessage[];

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
        const output = (tr as any).output ?? (tr as any).result ?? '';
        summaries.push(`[${tr.toolName}] ${renderToolResult(output).slice(0, 200)}`);
      }
    }
    if (summaries.length > 0) allText = summaries.join('\n');
  }

  await extensions?.emitTurnEnd({ text: allText, responseMessages });
  yield { type: 'done', text: allText, responseMessages };
}

/** Render a tool result for the observability event stream and the no-text
 *  turn-summary fallback. The model receives the real object through the AI
 *  SDK's message history; this is the trajectory/human-facing rendering, so a
 *  structured result must serialize to its content — never `String({...})`'s
 *  "[object Object]". */
function renderToolResult(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw == null) return '';
  try { return JSON.stringify(raw); } catch { return String(raw); }
}
