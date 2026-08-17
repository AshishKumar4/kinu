/**
 * Scaffold-as-inference-loop on the LOCAL turn seam.
 *
 * The peer of `inference-transform.ts`. Both answer the same question — "does
 * this agent have an evolved scaffold, and if so does the scaffold, not the
 * default loop, drive this turn?" — and both delegate to `runScaffold` with
 * `host.defaultInference()` bound to the stream the backend already prepared.
 * They differ only in the stream vocabulary the backend speaks: the DO renders
 * an AI-SDK UI message stream, a local turn consumes `runChat`'s `ChatEvent`s.
 *
 * Semantics (identical to the DO seam):
 * - Un-evolved agent (current scaffold version <= 0): the default stream is
 *   returned UNTOUCHED — same object, zero overhead.
 * - Evolved scaffold: `runScaffold` becomes the turn's inference loop, and
 *   `host.defaultInference()` hands it THE `runChat` stream the caller
 *   assembled (full context, tools, extensions), so a delegating scaffold is
 *   byte-faithful to the default turn by construction.
 * - `runChat` is a lazy generator, so a scaffold that never delegates simply
 *   never starts it — no model request is made, and nothing needs cancelling
 *   (the DO seam must cancel, because `streamText` fires eagerly).
 *
 * Envelope discipline: this transform owns the turn's single `done` event. The
 * delegated stream's `done` is absorbed — its `responseMessages` are what the
 * caller must persist — and text the scaffold produced itself (via
 * `host.llmStream`, outside any delegation) is carried back as one trailing
 * assistant message, so the durable history never loses the reply the user saw.
 */

import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat.js';
import { JsonObjectSchema, projectJsonValue, type JsonValue } from '../utils/json.js';
import {
  runScaffold,
  type ScaffoldDefaultInferenceChunk,
  type ScaffoldRunOptions,
} from './executor.js';
import { pumpScaffoldEvents } from './event-pump.js';

/** A `host.callTool` result is the tool's own output, or `{ error }` when the
 *  dispatch threw — the shape `buildHostProvider` guarantees. */
const ToolErrorSchema = v.object({ error: v.string() });
const StringResultSchema = v.string();

function toolOutcome(result: JsonValue | undefined): { result: string; success: boolean; error?: string } {
  const error = v.safeParse(ToolErrorSchema, result);
  const stringResult = v.safeParse(StringResultSchema, result);
  const text = stringResult.success ? stringResult.output : JSON.stringify(result ?? null) ?? 'null';
  return error.success
    ? { result: text, success: false, error: error.output.error }
    : { result: text, success: true };
}

const ModelMessagesSchema = v.custom<ModelMessage[]>((input) =>
  modelMessageSchema.array().safeParse(input).success,
);

const ChatEventSchema: v.GenericSchema<ChatEvent> = v.variant('type', [
  v.object({ type: v.literal('text-delta'), delta: v.string() }),
  v.object({
    type: v.literal('tool-call'),
    toolName: v.string(),
    toolCallId: v.string(),
    args: JsonObjectSchema,
  }),
  v.object({
    type: v.literal('tool-result'),
    toolName: v.string(),
    toolCallId: v.string(),
    result: v.string(),
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('step-finish'),
    stepIndex: v.number(),
    responseMessages: ModelMessagesSchema,
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
  }),
  v.object({ type: v.literal('error'), message: v.string() }),
  v.object({
    type: v.literal('done'),
    text: v.string(),
    responseMessages: ModelMessagesSchema,
  }),
]);

/**
 * Route a prepared default-turn stream through the agent's evolved scaffold.
 * `run` carries everything `runScaffold` needs except `emit` and
 * `defaultInference`, which this seam owns.
 */
export function scaffoldChatTransform(opts: {
  /** The agent's current scaffold version; <= 0 means un-evolved (bootstrap). */
  currentVersion: number;
  /** The default turn the caller assembled — not yet started. */
  chat: AsyncIterable<ChatEvent>;
  run: Omit<ScaffoldRunOptions, 'emit' | 'defaultInference'>;
}): AsyncIterable<ChatEvent> {
  if (opts.currentVersion <= 0) return opts.chat;
  return scaffoldTurn(opts.chat, opts.run);
}

async function* scaffoldTurn(
  chat: AsyncIterable<ChatEvent>,
  run: Omit<ScaffoldRunOptions, 'emit' | 'defaultInference'>,
): AsyncGenerator<ChatEvent> {
  const pump = pumpScaffoldEvents((emit) =>
    runScaffold({ ...run, emit, defaultInference: () => wrapDefaultChat(chat) }));

  const toolNames = new Map<string, string>();
  let text = '';
  let nativeText = '';
  let delegated: ModelMessage[] = [];

  for (;;) {
    const next = await pump.next();
    if (next.done) {
      if (!next.value.ok && next.value.error) {
        yield { type: 'error', message: next.value.error };
      }
      break;
    }
    const ev = next.value;
    switch (ev.type) {
      case 'ui_chunk': {
        // The delegated `runChat` stream, verbatim — except its `done`, whose
        // response messages become ours (this seam owns the envelope).
        const parsed = v.safeParse(ChatEventSchema, ev.chunk);
        if (!parsed.success) break;
        const inner = parsed.output;
        if (inner.type === 'done') {
          delegated = inner.responseMessages;
          if (!text.trim()) text = inner.text;
          break;
        }
        if (inner.type === 'text-delta') text += inner.delta;
        yield inner;
        break;
      }
      case 'text_delta':
        text += ev.text;
        nativeText += ev.text;
        yield { type: 'text-delta', delta: ev.text };
        break;
      case 'tool_call':
        toolNames.set(ev.toolCallId, ev.name);
        yield { type: 'tool-call', toolName: ev.name, toolCallId: ev.toolCallId, args: ev.args };
        break;
      case 'tool_result':
        yield {
          type: 'tool-result',
          toolName: toolNames.get(ev.toolCallId) ?? 'unknown',
          toolCallId: ev.toolCallId,
          ...toolOutcome(ev.result),
        };
        break;
      case 'step_finish':
        // A scaffold-authored step: the scaffold IS the loop here, so there is
        // no SDK response array behind this boundary. Empty rather than
        // fabricated — the model output the scaffold produced itself rides
        // `text_delta` and lands in the turn's `done` below. Steps of a
        // DELEGATED runChat pass through the `ui_chunk` branch above with their
        // real cumulative array, so per-step durability survives delegation.
        yield { type: 'step-finish', stepIndex: ev.stepIndex, responseMessages: [] };
        break;
      case 'error':
        yield { type: 'error', message: ev.message };
        break;
      case 'done':
        break;
    }
  }

  yield {
    type: 'done',
    text,
    responseMessages: nativeText.trim()
      ? [...delegated, { role: 'assistant', content: nativeText }]
      : delegated,
  };
}

async function* wrapDefaultChat(
  chat: AsyncIterable<ChatEvent>,
): AsyncGenerator<ScaffoldDefaultInferenceChunk> {
  for await (const event of chat) yield { value: projectJsonValue({ value: event }) };
}
