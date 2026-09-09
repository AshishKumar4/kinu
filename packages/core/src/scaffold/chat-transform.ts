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
 * default and custom model streams retain their actual SDK responseMessages.
 * Extra scaffold-authored text is carried as a trailing assistant message;
 * model text is not reconstructed into a second, lossy conversation.
 */

import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import type { ActorTurnProgram } from '../orchestrator/actor-program';
import { currentWorkMode } from '../execution/work-mode';
import { JsonObjectSchema } from '../utils/json';
import { ToolOutcomeSchema } from '../tools/outcome';
import { renderToolResult } from '../prompts/evidence-window';
import { FAILURE_WITHOUT_ERROR } from '../events/types';
import { UsageSchema } from '../usage';
import {
  runScaffold,
  type ScaffoldDefaultInferenceChunk,
  type ScaffoldRunOptions,
} from './executor';
import { pumpScaffoldEvents } from './event-pump';


const ModelMessagesSchema = v.custom<ModelMessage[]>((input) =>
  modelMessageSchema.array().safeParse(input).success,
);

const ChatEventSchema: v.GenericSchema<ChatEvent> = v.variant('type', [
  v.object({ type: v.literal('text-delta'), delta: v.string() }),
  v.object({ type: v.literal('reasoning-delta'), delta: v.string() }),
  v.object({
    type: v.literal('tool-call'),
    toolName: v.string(),
    toolCallId: v.string(),
    args: JsonObjectSchema,
  }),
  v.variant('success', [
    v.object({ type: v.literal('tool-result'), toolName: v.string(), toolCallId: v.string(),
      result: v.string(), error: v.optional(v.string()), ...ToolOutcomeSchema.options[0].entries }),
    v.object({ type: v.literal('tool-result'), toolName: v.string(), toolCallId: v.string(),
      result: v.string(), error: v.optional(v.string()), ...ToolOutcomeSchema.options[1].entries }),
  ]),
  v.object({
    type: v.literal('step-finish'),
    stepIndex: v.number(),
    responseMessages: ModelMessagesSchema,
    usage: v.optional(UsageSchema),
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
  /** Prepared by the shared selected-source policy before this synchronous seam. */
  program: ActorTurnProgram;
  /** The default turn the caller assembled — not yet started. */
  chat: AsyncIterable<ChatEvent>;
  run: Omit<ScaffoldRunOptions, 'emit' | 'defaultInference' | 'scaffoldCodeOverride'>;
}): AsyncIterable<ChatEvent> {
  if (opts.program.kind === 'builtin' || (opts.run.workMode ?? currentWorkMode()) === 'plan') return opts.chat;
  return scaffoldTurn(opts.chat, { ...opts.run, scaffoldCodeOverride: opts.program.source });
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
  const responses: ModelMessage[] = [];

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
      case 'model_chunk':
      case 'chat_chunk': {
        const inner = ev.chunk;
        // Custom model calls retain their own onStep/spend owner; do not price
        // their steps again as default-turn step_finish records.
        if (ev.type === 'model_chunk' && inner.type === 'step-finish') break;
        if (inner.type === 'done') {
          responses.push(...inner.responseMessages);
          if (!text.trim()) text = inner.text;
        } else {
          if (inner.type === 'text-delta') text += inner.delta;
          yield inner;
        }
        break;
      }
      case 'ui_chunk': {
        // Authored JSON UI chunks retain the wire schema boundary; native
        // default/model events above never pass through this codec.
        const parsed = v.safeParse(ChatEventSchema, ev.chunk);
        if (!parsed.success) break;
        const inner = parsed.output;
        if (inner.type === 'done') {
          responses.push(...inner.responseMessages);
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
          result: ev.outcome.success ? renderToolResult(ev.result) : ev.error ?? FAILURE_WITHOUT_ERROR,
          error: ev.error,
          ...ev.outcome,
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
      ? [...responses, { role: 'assistant', content: nativeText }]
      : responses,
  };
}

async function* wrapDefaultChat(
  chat: AsyncIterable<ChatEvent>,
): AsyncGenerator<ScaffoldDefaultInferenceChunk> {
  for await (const event of chat) yield { event };
}
