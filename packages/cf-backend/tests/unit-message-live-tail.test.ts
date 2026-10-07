// A live turn's one indicator is derived from each part's stream state, never part order; nothing
// animates on a clock: a closed part, or an open one with nothing to draw yet, reports `thinking`. What the page
// offers for an admitted, stranded or settled claim is proven on the page (tests/browser/chat-and-files-ux.test.ts).
import { describe, test, expect } from 'bun:test';
import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai';
import { threadLiveTail, turnLiveness } from '@kinu.run/core';

type Part = UIMessage['parts'][number];

function tool(id: string, state: ToolUIPart['state']): ToolUIPart {
  const type: `tool-${string}` = 'tool-file';

  if (state === 'output-available') return { type, toolCallId: id, state, input: {}, output: null };

  if (state === 'output-error') return { type, toolCallId: id, state, input: {}, errorText: 'boom' };

  if (state === 'input-available') return { type, toolCallId: id, state, input: {} };

  return { type, toolCallId: id, state: 'input-streaming', input: undefined };
}

const text = (content: string, state?: TextUIPart['state']): TextUIPart =>
  state === undefined ? { type: 'text', text: content } : { type: 'text', text: content, state };

const reasoning = (content: string, state?: ReasoningUIPart['state']): ReasoningUIPart =>
  state === undefined ? { type: 'reasoning', text: content } : { type: 'reasoning', text: content, state };

const tailOf = (parts: readonly Part[]) =>
  threadLiveTail({ last: { role: 'assistant', parts: [...parts] }, liveness: { kind: 'live', turnId: 't1' } });

describe('the tail of a live assistant row', () => {
  test('the caret rides the text part the stream is still writing', () => {
    const part = text('half a sen', 'streaming');
    expect(tailOf([part])).toEqual({ kind: 'text', part });
  });

  test('a turn whose prose is finished and whose calls are done is thinking, not writing', () => {
    // A caret after the last text part would sit above later tool rows; the model is between steps.
    const parts: Part[] = [
      text('Reading the handler.', 'done'),
      tool('a', 'output-available'),
      tool('b', 'output-available'),
    ];

    expect(tailOf(parts)).toEqual({ kind: 'thinking' });
  });

  test('a call in flight owns the indicator — nothing is added after it', () => {
    // Its row already carries a live dot; a second indicator would claim two things are happening.
    for (const state of ['input-streaming', 'input-available'] as const) {
      expect(tailOf([text('Running the suite.', 'done'), tool('a', state)]))
        .toEqual({ kind: 'tool' });
    }
  });

  test('streaming reasoning points at its own block rather than adding a row', () => {
    const part = reasoning('SAVE20 fails and SAVE10 does not, so', 'streaming');
    expect(tailOf([part])).toEqual({ kind: 'reasoning', part });
  });

  test('closed reasoning with nothing after it is thinking', () => {
    expect(tailOf([reasoning('Settled on the guard.', 'done')])).toEqual({ kind: 'thinking' });
  });

  test('a turn with no parts yet is thinking — the pre-first-token window', () => {
    expect(tailOf([])).toEqual({ kind: 'thinking' });
  });

  test('a part the stream never closed is treated as the one being written', () => {
    // `state` is optional; asked only of an open stream, undefined reads as still arriving.
    const part = text('no state field');
    expect(tailOf([part])).toEqual({ kind: 'text', part });
  });

  test('a file part does not claim the tail — it is not a stream position', () => {
    const part = text('Here is the chart', 'streaming');
    const parts: Part[] = [part, { type: 'file', mediaType: 'image/png', url: 'data:,' }];
    expect(tailOf(parts)).toEqual({ kind: 'text', part });
  });
});

describe('turnLiveness', () => {

  test('a client streaming ahead of the next snapshot is live', () => {
    expect(turnLiveness({ claim: { kind: 'settled' }, streaming: true })).toEqual({ kind: 'live', turnId: null });
  });

});

describe('the thread the page paints', () => {
  const userTurn: UIMessage = { id: 'u1', role: 'user', parts: [text('build the chess app')] };

  test("a live turn whose last row is the user's still has a tail", () => {
    // `isLast && streaming && !isUser` is false before the first assistant row.
    const liveness = turnLiveness({ claim: { kind: 'admitted', turnId: 't1', claimedAt: 1 }, streaming: true });
    expect(threadLiveTail({ last: userTurn, liveness })).toEqual({ kind: 'thinking' });
  });

  test('a live assistant row reads its own parts', () => {
    const part = text('half a sen', 'streaming');
    const last: UIMessage = { id: 'a1', role: 'assistant', parts: [part] };
    expect(threadLiveTail({ last, liveness: { kind: 'live', turnId: 't1' } })).toEqual({ kind: 'text', part });
  });
});
