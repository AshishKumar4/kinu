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

import { uiMessageChunkSchema, type UIMessageChunk } from 'ai';
import type { ScaffoldRunResult, ScaffoldEmitFn } from './executor';
import { pumpScaffoldEvents } from './event-pump';

/** Run a scaffold (via the supplied runner) and yield a UI message stream. */
export async function* scaffoldEventsToUIStream(
  run: (emit: ScaffoldEmitFn) => Promise<ScaffoldRunResult>,
  opts: { messageId?: string; idPrefix?: string } = {},
): AsyncGenerator<UIMessageChunk> {
  const pump = pumpScaffoldEvents(run);

  const idPrefix = opts.idPrefix ?? 'sc';
  let textId: string | null = null;
  let textSeq = 0;

  function* openTextIfNeeded(): Generator<UIMessageChunk> {
    if (textId == null) {
      textId = `${idPrefix}-text-${textSeq++}`;
      yield { type: 'text-start', id: textId };
    }
  }
  function* closeTextIfOpen(): Generator<UIMessageChunk> {
    if (textId != null) {
      yield { type: 'text-end', id: textId };
      textId = null;
    }
  }

  if (opts.messageId) yield { type: 'start', messageId: opts.messageId };
  else yield { type: 'start' };

  let result: ScaffoldRunResult;
  for (;;) {
    const next = await pump.next();
    if (next.done) { result = next.value; break; }
    const ev = next.value;
    switch (ev.type) {
      case 'ui_chunk': {
        const validation = await uiMessageChunkSchema().validate?.(ev.chunk);
        if (validation?.success) {
          const chunk = validation.value;
          // Strip the inner envelope — we own start/finish.
          if (chunk.type !== 'start' && chunk.type !== 'finish') yield chunk;
        }
        break;
      }
      case 'text_delta':
        yield* openTextIfNeeded();
        yield { type: 'text-delta', id: textId!, delta: ev.text };
        break;
      case 'tool_call':
        yield* closeTextIfOpen();
        yield { type: 'tool-input-available', toolCallId: ev.toolCallId, toolName: ev.name, input: ev.args };
        break;
      case 'tool_result':
        yield { type: 'tool-output-available', toolCallId: ev.toolCallId, output: ev.result };
        break;
      case 'step_finish':
        yield* closeTextIfOpen();
        yield { type: 'finish-step' };
        break;
      case 'error':
        yield { type: 'error', errorText: ev.message };
        break;
      case 'done':
        break;
    }
  }

  // Close out: emit any failure the runner surfaced, then a single finish.
  if (!result.ok && result.error) {
    yield { type: 'error', errorText: result.error };
  }
  yield* closeTextIfOpen();
  yield { type: 'finish' };
}
