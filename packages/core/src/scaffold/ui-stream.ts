/**
 * ScaffoldEvent → AI-SDK UI message stream adapter.
 *
 * `runScaffold` reports progress through an `emit(ScaffoldEvent)` callback.
 * The Think chat path consumes an AI-SDK UI message stream
 * (`toUIMessageStream()` chunks). This adapter bridges the two: it runs a
 * scaffold and yields a well-formed `UIMessageChunk` stream.
 *
 * Envelope discipline — the adapter owns exactly one `start` + one `finish`:
 *   - It emits `{type:'start'}` before any content.
 *   - For `ui_chunk` events (produced by `host.defaultInference()`, which runs
 *     the real `streamText().toUIMessageStream()`), it passes the inner chunk
 *     through verbatim EXCEPT the inner `start`/`finish` (the envelope is
 *     ours), so a default scaffold's output is byte-identical to standard
 *     inference apart from the single outer envelope.
 *   - For `text_delta` events (from `host.llmStream`), it synthesises a text
 *     block (`text-start` / `text-delta…` / `text-end`).
 *   - `tool_call` → `tool-input-available`; `tool_result` → `tool-output-available`.
 *   - `error` → `error`; `done` closes any open text block then `finish`.
 *
 * No live model needed to test it — feed a fake run function that emits a
 * scripted event sequence and assert the chunk stream.
 */

import { uiMessageChunkSchema, type UIMessageChunk, type ModelMessage } from 'ai';
import { renderToolResult } from '../prompts/evidence-window';
import type { ScaffoldRunResult, ScaffoldEmitFn } from './executor';
import { pumpScaffoldEvents } from './event-pump';
import type { JsonValue } from '../utils/json';

/**
 * What one `ui_chunk` event contributes to the outer stream — the chunk to
 * forward, or `undefined` when it contributes nothing.
 *
 * Three shapes contribute nothing: a chunk the UI schema does not recognise,
 * the inner stream's own `start`/`finish` (the envelope belongs to the
 * adapter), and a reasoning part when the caller asked not to send reasoning.
 * Everything else passes through verbatim.
 */
async function forwardedUIChunk(
  raw: JsonValue,
  sendReasoning: boolean | undefined,
): Promise<UIMessageChunk | undefined> {
  const validation = await uiMessageChunkSchema().validate?.(raw);
  if (validation === undefined || !validation.success) return undefined;
  const chunk = validation.value;
  if (chunk.type === 'start' || chunk.type === 'finish') return undefined;
  const reasoning = chunk.type === 'reasoning-start' || chunk.type === 'reasoning-delta'
    || chunk.type === 'reasoning-end';
  if (reasoning && sendReasoning === false) return undefined;
  return chunk;
}

/** Run a scaffold (via the supplied runner) and yield a UI message stream. */
export async function* scaffoldEventsToUIStream(
  run: (emit: ScaffoldEmitFn) => Promise<ScaffoldRunResult>,
  opts: { messageId?: string; idPrefix?: string; sendReasoning?: boolean } = {},
): AsyncGenerator<UIMessageChunk> {
  const pump = pumpScaffoldEvents(run);
  const idPrefix = opts.idPrefix ?? 'sc';
  let part: { kind: 'text' | 'reasoning'; id: string } | null = null;
  let partSeq = 0;
  const responseCursors = new Map<string, number>();

  function* closePart(): Generator<UIMessageChunk> {
    if (part === null) return;
    const closing = part;
    part = null;
    yield closing.kind === 'text'
      ? { type: 'text-end', id: closing.id }
      : { type: 'reasoning-end', id: closing.id };
  }

  function* delta(kind: 'text' | 'reasoning', text: string): Generator<UIMessageChunk> {
    const current = part?.kind === kind ? part : { kind, id: `${idPrefix}-${kind}-${partSeq++}` };
    if (current !== part) {
      yield* closePart();
      part = current;
      yield kind === 'text' ? { type: 'text-start', id: current.id } : { type: 'reasoning-start', id: current.id };
    }
    yield kind === 'text'
      ? { type: 'text-delta', id: current.id, delta: text }
      : { type: 'reasoning-delta', id: current.id, delta: text };
  }

  function* modelOutputs(streamId: string, messages: readonly ModelMessage[]): Generator<UIMessageChunk> {
    const start = responseCursors.get(streamId) ?? 0;
    for (let index = start; index < messages.length; index++) {
      const message = messages[index];
      if (message?.role !== 'tool') continue;
      for (const content of message.content) {
        if (content.type !== 'tool-result') continue;
        const toolCallId = streamId + '/' + content.toolCallId;
        const output = content.output;
        switch (output.type) {
          case 'error-text': yield { type: 'tool-output-error', toolCallId, errorText: output.value }; break;
          case 'error-json': yield { type: 'tool-output-error', toolCallId, errorText: renderToolResult(output.value) }; break;
          case 'execution-denied': yield { type: 'tool-output-denied', toolCallId }; break;
          default: yield { type: 'tool-output-available', toolCallId, output: output.value }; break;
        }
      }
    }
    responseCursors.set(streamId, messages.length);
  }

  if (opts.messageId) yield { type: 'start', messageId: opts.messageId };
  else yield { type: 'start' };
  let result: ScaffoldRunResult;
  for (;;) {
    const next = await pump.next();
    if (next.done) { result = next.value; break; }
    const ev = next.value;
    switch (ev.type) {
      case 'model_output':
        yield { ...ev.output, toolCallId: ev.streamId + '/' + ev.output.toolCallId };
        break;
      case 'model_chunk':
      case 'chat_chunk': {
        const chunk = ev.chunk;
        switch (chunk.type) {
          case 'text-delta': yield* delta('text', chunk.delta); break;
          case 'reasoning-delta': if (opts.sendReasoning !== false) yield* delta('reasoning', chunk.delta); break;
          case 'tool-call':
            yield* closePart();
            yield { type: 'tool-input-available', toolCallId: ev.streamId + '/' + chunk.toolCallId, toolName: chunk.toolName, input: chunk.args };
            break;
          case 'tool-result':
            // The rendered ChatEvent result is not the SDK's model output.
            // The actual response messages below carry the typed value/error.
            break;
          case 'step-finish':
            if (ev.type === 'chat_chunk') yield* modelOutputs(ev.streamId, chunk.responseMessages);
            yield* closePart();
            yield { type: 'finish-step' };
            break;
          case 'done':
            if (ev.type === 'chat_chunk') yield* modelOutputs(ev.streamId, chunk.responseMessages);
            responseCursors.delete(ev.streamId);
            break;
          case 'error': yield { type: 'error', errorText: chunk.message }; break;
        }
        break;
      }
      case 'ui_chunk': {
        const chunk = await forwardedUIChunk(ev.chunk, opts.sendReasoning);
        if (chunk !== undefined) yield chunk;
        break;
      }
      case 'text_delta': yield* delta('text', ev.text); break;
      case 'tool_call':
        yield* closePart();
        yield { type: 'tool-input-available', toolCallId: ev.toolCallId, toolName: ev.name, input: ev.args };
        break;
      case 'tool_result':
        yield ev.outcome.success
          ? { type: 'tool-output-available', toolCallId: ev.toolCallId, output: ev.result }
          : { type: 'tool-output-error', toolCallId: ev.toolCallId, errorText: ev.error ?? 'the tool reported failure without an error' };
        break;
      case 'step_finish':
        yield* closePart();
        yield { type: 'finish-step' };
        break;
      case 'error': yield { type: 'error', errorText: ev.message }; break;
      case 'done': break;
    }
  }
  if (!result.ok && result.error) yield { type: 'error', errorText: result.error };
  yield* closePart();
  yield { type: 'finish' };
}
