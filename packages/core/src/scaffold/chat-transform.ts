/**
 * Evolved scaffold as the turn's inference loop, for every backend.
 *
 * - Current version <= 0: the default stream is returned untouched.
 * - Otherwise `runScaffold` drives the turn; `host.defaultInference()` hands it
 *   the caller's lazy `runChat` stream, which never starts if not delegated.
 * - This transform owns the turn's single `done` event.
 */

import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import type { ChatEvent } from '../chat';
import type { ActorTurnProgram } from '../orchestrator/actor-program';
import { currentWorkMode } from '../execution/work-mode';
import { JsonObjectSchema, JsonValueSchema } from '../utils/json';
import { ToolOutcomeSchema } from '../tools/outcome';
import { renderToolResult } from '../utils/evidence-window';
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
      result: v.string(), output: v.optional(JsonValueSchema), error: v.optional(v.string()), durationMs: v.optional(v.number()),
      ...ToolOutcomeSchema.options[0].entries }),
    v.object({ type: v.literal('tool-result'), toolName: v.string(), toolCallId: v.string(),
      result: v.string(), output: v.optional(JsonValueSchema), error: v.optional(v.string()), durationMs: v.optional(v.number()),
      ...ToolOutcomeSchema.options[1].entries }),
  ]),
  v.object({
    type: v.literal('step-finish'),
    stepIndex: v.number(),
    responseMessages: ModelMessagesSchema,
    usage: v.optional(UsageSchema),
    finishReason: v.optional(v.string()),
    text: v.optional(v.string()),
  }),
  v.object({ type: v.literal('error'), message: v.string() }),
  v.object({
    type: v.literal('done'),
    text: v.string(),
    responseMessages: ModelMessagesSchema,
    answer: v.optional(v.string()),
  }),
]);

/** `shell` carries everything `runScaffold` needs except `emit` and `defaultInference`. */
export function scaffoldChatTransform(opts: {
  program: ActorTurnProgram;
  /** The default turn the caller assembled, not yet started. */
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
  let answer: string | undefined;
  let nativeText = '';
  const responses: ModelMessage[] = [];

  for (;;) {
    const next = await pump.next();

    // `runScaffold` already emitted an `error` event for every `ok: false` return.
    if (next.done) break;

    const ev = next.value;

    switch (ev.type) {
      case 'model_chunk':
      case 'chat_chunk': {
        const inner = ev.chunk;

        // Custom model calls own their spend: pass the step boundary but not its usage.
        if (ev.type === 'model_chunk' && inner.type === 'step-finish') {
          const { usage: _usage, ...boundary } = inner;
          yield boundary;
          break;
        }

        if (inner.type === 'done') {
          responses.push(...inner.responseMessages);

          if (inner.text.trim()) text = inner.text;
          answer = inner.answer;
        } else {
          if (inner.type === 'text-delta') text += inner.delta;
          yield inner;
        }

        break;
      }

      case 'ui_chunk': {
        const parsed = v.safeParse(ChatEventSchema, ev.chunk);

        if (!parsed.success) break;
        const inner = parsed.output;

        if (inner.type === 'done') {
          responses.push(...inner.responseMessages);

          if (inner.text.trim()) text = inner.text;
          answer = inner.answer;
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
      case 'tool_result': {
        // Records the tool's returned value, not its rendering.
        const settled: Extract<ChatEvent, { type: 'tool-result' }> = {
          type: 'tool-result',
          toolName: toolNames.get(ev.toolCallId) ?? 'unknown',
          toolCallId: ev.toolCallId,
          result: ev.outcome.success ? renderToolResult(ev.result) : ev.error ?? FAILURE_WITHOUT_ERROR,
          error: ev.error,
          ...ev.outcome,
        };

        if (ev.outcome.success && ev.result !== undefined) settled.output = ev.result;

        yield settled;
        break;
      }

      case 'step_finish':
        // Scaffold-authored step: no SDK response array exists, so it is empty rather than fabricated.
        yield { type: 'step-finish', stepIndex: ev.stepIndex, responseMessages: [] };
        break;
      case 'error':
        yield { type: 'error', message: ev.message };
        break;
      // Native tool raw output has no chat rendering; `model_chunk` already carries it.
      case 'model_output':
      case 'done':
        break;
    }
  }

  const settled = nativeText.trim() ? text : answer;

  yield {
    type: 'done',
    text,
    ...(settled !== undefined && settled.trim() !== '' && { answer: settled }),
    responseMessages: nativeText.trim()
      ? [...responses, { role: 'assistant', content: [{ type: 'text', text: nativeText }] }]
      : responses,
  };
}

async function* wrapDefaultChat(
  chat: AsyncIterable<ChatEvent>,
): AsyncGenerator<ScaffoldDefaultInferenceChunk> {
  for await (const event of chat) yield { event };
}
