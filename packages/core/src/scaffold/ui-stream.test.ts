/**
 * ScaffoldEvent → UI message stream adapter tests. Deterministic: a fake
 * runner emits a scripted event sequence; we assert the resulting chunks.
 */

import { describe, test, expect } from 'bun:test';
import type { UIMessageChunk } from 'ai';
import { scaffoldEventsToUIStream } from './ui-stream';
import type { ScaffoldEvent, ScaffoldRunResult, ScaffoldEmitFn } from './executor';

/** Build a runner that emits the given events then resolves ok. */
function scriptedRunner(
  events: ScaffoldEvent[],
  result: Partial<ScaffoldRunResult> = {},
): (emit: ScaffoldEmitFn) => Promise<ScaffoldRunResult> {
  return async (emit) => {
    for (const ev of events) await emit(ev);
    return {
      ok: true, doneEmitted: events.some(e => e.type === 'done'),
      emitCount: events.length, events, durationMs: 0, ...result,
    };
  };
}

async function collect(gen: AsyncGenerator<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('scaffoldEventsToUIStream', () => {
  test('text_delta sequence → start, text-start, text-delta*, text-end, finish', async () => {
    const chunks = await collect(scaffoldEventsToUIStream(scriptedRunner([
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done' },
    ])));
    const types = chunks.map(c => c.type);
    expect(types).toEqual(['start', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish']);
    expect(chunks[2]).toMatchObject({ type: 'text-delta', delta: 'Hello ' });
    expect(chunks[3]).toMatchObject({ type: 'text-delta', delta: 'world' });
    // text-start / text-delta / text-end share one id.
    const id = chunks.find((chunk) => chunk.type === 'text-start')?.id;
    expect(id).toBeString();
    expect(chunks.find((chunk) => chunk.type === 'text-delta')?.id).toBe(id);
    expect(chunks.find((chunk) => chunk.type === 'text-end')?.id).toBe(id);
  });

  test('ui_chunk events pass through verbatim, inner start/finish stripped', async () => {
    const chunks = await collect(scaffoldEventsToUIStream(scriptedRunner([
      { type: 'ui_chunk', chunk: { type: 'start', messageId: 'inner' } },
      { type: 'ui_chunk', chunk: { type: 'text-start', id: 'x' } },
      { type: 'ui_chunk', chunk: { type: 'text-delta', id: 'x', delta: 'hi' } },
      { type: 'ui_chunk', chunk: { type: 'text-end', id: 'x' } },
      { type: 'ui_chunk', chunk: { type: 'finish' } },
      { type: 'done' },
    ])));
    const types = chunks.map(c => c.type);
    // Exactly one outer start + one finish; inner start/finish stripped.
    expect(types).toEqual(['start', 'text-start', 'text-delta', 'text-end', 'finish']);
    expect(types.filter(t => t === 'start').length).toBe(1);
    expect(types.filter(t => t === 'finish').length).toBe(1);
    // Passed-through chunk keeps its real id.
    expect(chunks[1]).toMatchObject({ type: 'text-start', id: 'x' });
  });

  test('tool_call + tool_result → tool-input-available + tool-output-available, closing open text', async () => {
    const chunks = await collect(scaffoldEventsToUIStream(scriptedRunner([
      { type: 'text_delta', text: 'thinking' },
      { type: 'tool_call', name: 'run', args: { command: 'ls' }, toolCallId: 'tc1' },
      { type: 'tool_result', toolCallId: 'tc1', result: { stdout: 'a\nb' } },
      { type: 'done' },
    ])));
    const types = chunks.map(c => c.type);
    expect(types).toEqual([
      'start', 'text-start', 'text-delta', 'text-end',
      'tool-input-available', 'tool-output-available', 'finish',
    ]);
    expect(chunks.find(c => c.type === 'tool-input-available')).toMatchObject({
      toolCallId: 'tc1', toolName: 'run', input: { command: 'ls' },
    });
    expect(chunks.find(c => c.type === 'tool-output-available')).toMatchObject({
      toolCallId: 'tc1', output: { stdout: 'a\nb' },
    });
  });

  test('error event → error chunk', async () => {
    const chunks = await collect(scaffoldEventsToUIStream(scriptedRunner([
      { type: 'error', message: 'boom' },
      { type: 'done' },
    ])));
    expect(chunks.find(c => c.type === 'error')).toMatchObject({ errorText: 'boom' });
  });

  test('scaffold that settles without done still terminates with one finish', async () => {
    const chunks = await collect(scaffoldEventsToUIStream(scriptedRunner([
      { type: 'text_delta', text: 'partial' },
    ], { ok: true, doneEmitted: false })));
    const types = chunks.map(c => c.type);
    expect(types[0]).toBe('start');
    expect(types[types.length - 1]).toBe('finish');
    expect(types.filter(t => t === 'finish').length).toBe(1);
  });

  test('runner failure surfaces as an error chunk before finish', async () => {
    const chunks = await collect(scaffoldEventsToUIStream(async () => ({
      ok: false, doneEmitted: false, emitCount: 0, events: [], durationMs: 0,
      error: 'scaffold timeout',
    })));
    const types = chunks.map(c => c.type);
    expect(types).toContain('error');
    expect(chunks.find(c => c.type === 'error')).toMatchObject({ errorText: 'scaffold timeout' });
    expect(types[types.length - 1]).toBe('finish');
  });

  test('passes messageId onto the start chunk', async () => {
    const chunks = await collect(scaffoldEventsToUIStream(
      scriptedRunner([{ type: 'done' }]),
      { messageId: 'msg-42' },
    ));
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: 'msg-42' });
  });
});
