// Defends: a landed step painted twice (durable step plus live tail). The journal is the authority;
// part states are asserted because `MessageView` places its live caret by part state.
import { describe, expect, test } from 'bun:test';
import type { HeadStep } from '@kinu.run/core';
import {
  appendHeadDelta, deltaAsMessage, retireHeadDelta, stepAsMessage,
  type HeadDelta,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

const NOTHING: ReadonlyMap<string, HeadDelta> = new Map();

function frames(
  ...sent: readonly [string, 'text' | 'reasoning', string][]
): ReadonlyMap<string, HeadDelta> {
  let map = NOTHING;

  for (const [headId, kind, delta] of sent) map = appendHeadDelta(map, headId, kind, delta);

  return map;
}

describe('the accumulator', () => {
  test('text frames concatenate verbatim, in arrival order', () => {
    const map = frames(['h1', 'text', 'Reading '], ['h1', 'text', 'the handler.']);
    expect(map.get('h1')).toEqual({ text: 'Reading the handler.', reasoning: '' });
  });

  test('reasoning is its own stream, and both halves are held at once', () => {
    const map = frames(
      ['h1', 'reasoning', 'The route bounds '],
      ['h1', 'reasoning', 'the body.'],
      ['h1', 'text', 'It does.'],
    );

    expect(map.get('h1')).toEqual({ text: 'It does.', reasoning: 'The route bounds the body.' });
  });

  test('deltas never cross heads', () => {
    const map = frames(['h1', 'text', 'one'], ['h2', 'text', 'two'], ['h2', 'reasoning', 'why']);
    expect(map.get('h1')).toEqual({ text: 'one', reasoning: '' });
    expect(map.get('h2')).toEqual({ text: 'two', reasoning: 'why' });
  });

  test('whitespace and newlines are the provider\'s, not ours', () => {
    const map = frames(['h1', 'text', '- one\n'], ['h1', 'text', '- two\n']);
    expect(map.get('h1')?.text).toBe('- one\n- two\n');
  });
});

describe('retirement — the journal caught up', () => {
  test('retiring a head drops its delta and leaves every other head alone', () => {
    const map = frames(['h1', 'text', 'one'], ['h2', 'text', 'two']);
    const after = retireHeadDelta(map, 'h1');
    expect(after.has('h1')).toBe(false);
    expect(after.get('h2')).toEqual({ text: 'two', reasoning: '' });
  });

  test('retiring a head that holds nothing changes nothing, identity included', () => {
    // Most retirements are for unwatched heads; a new Map would re-render every reader for nothing.
    const map = frames(['h1', 'text', 'one']);
    expect(retireHeadDelta(map, 'h9')).toBe(map);
  });

  test('retirement is idempotent', () => {
    const once = retireHeadDelta(frames(['h1', 'text', 'one']), 'h1');
    expect(retireHeadDelta(once, 'h1')).toBe(once);
  });

  test('a retired head starts clean when it writes again', () => {
    // Resuming the old buffer would replay the durable step's words under the new one.
    const landed = retireHeadDelta(frames(['h1', 'text', 'first step.']), 'h1');
    expect(appendHeadDelta(landed, 'h1', 'text', 'second').get('h1'))
      .toEqual({ text: 'second', reasoning: '' });
  });
});

describe('the arriving step, as the chat draws it', () => {
  test('nothing arriving is no message — the same as a head that emits no deltas', () => {
    expect(deltaAsMessage(undefined, 'h1')).toBeNull();
    expect(deltaAsMessage({ text: '', reasoning: '' }, 'h1')).toBeNull();
  });

  test('reasoning alone is a live reasoning block, so thinking is visible before prose', () => {
    const message = deltaAsMessage({ text: '', reasoning: 'Two rails need it.' }, 'h1');
    expect(message?.role).toBe('assistant');
    expect(message?.parts).toEqual([
      { type: 'reasoning', text: 'Two rails need it.', state: 'streaming' },
    ]);
  });

  test('prose closes the reasoning: a model that has begun answering has stopped thinking', () => {
    const message = deltaAsMessage({ text: 'The bound is a count.', reasoning: 'Counting bytes.' }, 'h1');
    expect(message?.parts).toEqual([
      { type: 'reasoning', text: 'Counting bytes.', state: 'done' },
      { type: 'text', text: 'The bound is a count.', state: 'streaming' },
    ]);
  });

  test('prose with no reasoning is one open text part — the caret lands in it', () => {
    expect(deltaAsMessage({ text: 'half a sen', reasoning: '' }, 'h1')?.parts).toEqual([
      { type: 'text', text: 'half a sen', state: 'streaming' },
    ]);
  });

  test('the arriving message keeps one id per head, so React reuses the row', () => {
    const first = present(deltaAsMessage({ text: 'a', reasoning: '' }, 'h1'), 'the first head delta message');
    const second = present(deltaAsMessage({ text: 'ab', reasoning: '' }, 'h1'), 'the second head delta message');

    expect(first.id).toBe(second.id);
    expect(deltaAsMessage({ text: 'a', reasoning: '' }, 'h2')?.id).not.toBe(first.id);
  });
});

describe('the journalled step, as the chat draws it', () => {
  const step = (over: Partial<HeadStep> = {}): HeadStep =>
    ({ text: 'Bounded the body.', toolCalls: [], ...over });

  test('every part of a recorded step is CLOSED — a landed step is never live', () => {
    const message = stepAsMessage(step({ reasoning: 'The header lies.' }), 0, 'h1');
    expect(message.parts).toEqual([
      { type: 'reasoning', text: 'The header lies.', state: 'done' },
      { type: 'text', text: 'Bounded the body.', state: 'done' },
    ]);
  });

  test('a call with no recorded output still reads as running', () => {
    const message = stepAsMessage(
      step({ toolCalls: [{ name: 'read', input: { path: '/x' } }] }),
      2, 'h1',
    );

    expect(message.parts.at(-1)).toEqual({
      type: 'dynamic-tool', toolName: 'read', toolCallId: 'h1-s2-t0',
      state: 'input-available', input: { path: '/x' },
    });
  });

  test('a settled call carries its output', () => {
    const message = stepAsMessage(
      step({ toolCalls: [{ name: 'read', input: { path: '/x' }, output: 'ok' }] }),
      1, 'h1',
    );

    expect(message.parts.at(-1)).toEqual({
      type: 'dynamic-tool', toolName: 'read', toolCallId: 'h1-s1-t0',
      state: 'output-available', input: { path: '/x' }, output: 'ok',
    });
  });

  test('step ids are per step, so the trace is stable while it grows', () => {
    expect(stepAsMessage(step(), 0, 'h1').id).toBe('h1-s0');
    expect(stepAsMessage(step(), 1, 'h1').id).toBe('h1-s1');
  });
});
