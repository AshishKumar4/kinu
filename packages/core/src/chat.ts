/**
 * Shared chat engine — one implementation used by both the server and CLI.
 *
 * Yields streaming events (text deltas, tool calls, tool results) and
 * returns the FULL ModelMessage array including tool call/result messages.
 * Callers store these messages in history so the model sees tool context
 * on subsequent turns.
 */

import { streamText, stepCountIs, type ModelMessage, type ToolSet, type LanguageModel } from 'ai';
import { resolveMaxSteps } from './config.js';
import {
  assertToolsSupportedByModel,
  type PromptModelContext,
} from './prompting/model-profile.js';
import { applyCacheBreakpoints, hasCacheMarkers } from './prompting/cache-breakpoints.js';
import { composePrepareStep } from './prompting/prepare-step.js';
import { sanitizeAttachmentsForModel, type AttachmentPolicy } from './prompting/attachment-sanitizer.js';
import { contextWindowForModel } from './context-window.js';
import type { EphemeralContextLedger, SystemStateContext } from './prompting/volatile-context.js';
import type { ExtensionHost } from './extension.js';

export type ChatEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown> }
  /** A tool call settled. `result` is the stringified output on success or the
   *  error text on failure; `success`/`error` carry the discriminator the
   *  evolution signal reads (hadError, outcome review) — matching the cf
   *  backend's afterToolCall. */
  | { type: 'tool-result'; toolName: string; result: string; success: boolean; error?: string }
  /** `inputTokens`/`outputTokens`/`cachedInputTokens` = the step request's
   *  provider-reported totals, when reported — inputTokens doubles as the
   *  caller's measured compaction signal, cachedInputTokens feeds cache
   *  telemetry. */
  | { type: 'step-finish'; stepIndex: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
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
   *  OpenAI-compatible family. See prompting/cache-breakpoints.ts. */
  cache?: { providerId?: string; modelId?: string; sessionKey: string };
}

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

  // Model-capability attachment sanitization runs FIRST, on the whole
  // model-visible history — the same ordering the cf backend's beforeTurn
  // applies — so the transform seam (compaction) and the ledger weave both
  // operate over sanitized messages. Never mutates the caller's history.
  const history = opts.attachments
    ? await sanitizeAttachmentsForModel(opts.history, opts.attachments)
    : opts.history;

  await extensions?.emitTurnStart({ system: opts.system, history });

  // Awaited context-transform seam (the compaction-plugin hook): fires once
  // per turn assembly, on the DURABLE history only — the ephemeral ledger
  // blocks and the turn-local tail are woven/spliced after, so a transform
  // never sees or persists them.
  const transformed = await extensions?.runTransformContext({
    sessionKey: opts.cache?.sessionKey ?? '',
    messages: history,
    system: opts.system,
    contextWindow: opts.modelContext?.contextWindow
      ?? contextWindowForModel(opts.modelContext?.id ?? ''),
    ...(opts.providerReportedTokens !== undefined
      ? { providerReportedTokens: opts.providerReportedTokens }
      : {}),
    trigger: 'auto',
  });
  const durable = transformed ?? history;
  const woven = opts.systemState
    ? opts.systemState.ledger.weave(durable, opts.systemState.context)
    : durable;
  const turnMessages = [...woven, ...(opts.turnLocal ?? [])];

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
  });
  const rollTail = hasCacheMarkers(cache.strategy);

  const result = streamText({
    model: opts.model,
    system: cache.system,
    messages: cache.messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal: opts.signal,
    ...(cache.providerOptions ? { providerOptions: cache.providerOptions } : {}),
    ...(extensions || rollTail ? {
      // The shared step pipeline (prompting/prepare-step.ts): extension
      // rewrites first, cache tail markers LAST onto the final array. The cf
      // orchestrator's beforeStep runs the identical composition.
      prepareStep: ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) =>
        composePrepareStep(extensions, { stepNumber, messages },
          rollTail ? { strategy: cache.strategy } : null),
    } : {}),
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

  for await (const chunk of result.fullStream) {
    if (opts.signal?.aborted) break;

    switch (chunk.type) {
      case 'text-delta': {
        const delta = (chunk as any).textDelta ?? (chunk as any).text ?? '';
        if (delta) {
          allText += delta;
          yield { type: 'text-delta', delta };
        }
        break;
      }
      case 'tool-call': {
        const args = ((chunk as any).input ?? (chunk as any).args ?? {}) as Record<string, unknown>;
        await extensions?.emitToolCall({ toolName: chunk.toolName, args });
        yield { type: 'tool-call', toolName: chunk.toolName, args };
        break;
      }
      case 'tool-result': {
        const raw = (chunk as any).output ?? (chunk as any).result ?? '';
        const result = String(raw).slice(0, 1000);
        await extensions?.emitToolResult({ toolName: chunk.toolName, result });
        yield { type: 'tool-result', toolName: chunk.toolName, result, success: true };
        break;
      }
      case 'tool-error': {
        // A tool threw: the error is the durable outcome the evolution signal
        // reads. The extension seam sees the error text as the result (same as
        // the cf afterToolCall), and the discriminator rides success/error.
        const error = errorText((chunk as any).error);
        const result = error.slice(0, 1000);
        await extensions?.emitToolResult({ toolName: chunk.toolName, result });
        yield { type: 'tool-result', toolName: chunk.toolName, result, success: false, error };
        break;
      }
    }

    // Yield any step-finish events that fired via onStepFinish callback
    while (pendingStepEvents.length > 0) {
      const ev = pendingStepEvents.shift();
      if (ev) yield { type: 'step-finish' as const, ...ev };
    }
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
        summaries.push(`[${tr.toolName}] ${String(output).slice(0, 200)}`);
      }
    }
    if (summaries.length > 0) allText = summaries.join('\n');
  }

  await extensions?.emitTurnEnd({ text: allText, responseMessages });
  yield { type: 'done', text: allText, responseMessages };
}

/** The message of a thrown tool error, from whatever shape the SDK carries. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
