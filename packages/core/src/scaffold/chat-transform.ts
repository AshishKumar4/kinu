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

import type { ModelMessage } from 'ai';
import type { ChatEvent } from '../chat.js';
import { runScaffold, type ScaffoldRunOptions } from './executor.js';
import { pumpScaffoldEvents } from './event-pump.js';

/** A `host.callTool` result is the tool's own output, or `{ error }` when the
 *  dispatch threw — the shape `buildHostProvider` guarantees. */
function toolOutcome(result: unknown): { result: string; success: boolean; error?: string } {
  const error = (result && typeof result === 'object' && 'error' in result)
    ? (result as { error: unknown }).error
    : undefined;
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  return typeof error === 'string'
    ? { result: text, success: false, error }
    : { result: text, success: true };
}

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
    runScaffold({ ...run, emit, defaultInference: () => chat }));

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
        const inner = ev.chunk as ChatEvent | undefined;
        if (!inner || typeof inner !== 'object' || !('type' in inner)) break;
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
        yield { type: 'tool-call', toolName: ev.name, args: ev.args };
        break;
      case 'tool_result':
        yield {
          type: 'tool-result',
          toolName: toolNames.get(ev.toolCallId) ?? 'unknown',
          ...toolOutcome(ev.result),
        };
        break;
      case 'step_finish':
        yield { type: 'step-finish', stepIndex: ev.stepIndex };
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
