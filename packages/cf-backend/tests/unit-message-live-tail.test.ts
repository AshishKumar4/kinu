// Where a live turn's one indicator goes, and what it says.
//
// The property that carries the feature: the affordance is derived from the
// stream's own part STATE, never from part order. Both reported defects were
// order-inference — a caret hung off the last text part even when tool rows
// came after it, and a "Thinking" row that existed only while a message had no
// parts at all, so a turn that went quiet between steps showed nothing.
//
// These are also the honesty tests. Nothing here animates on a clock: a part
// the stream closed reports `thinking` (the request is open, nothing is
// arriving) and a part the stream is still writing reports itself.
import { describe, test, expect } from 'bun:test';
import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai';
import { liveTail } from '../src/components/message-live-tail';

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

describe('liveTail', () => {
  test('the caret rides the text part the stream is still writing', () => {
    const part = text('half a sen', 'streaming');
    expect(liveTail([part])).toEqual({ kind: 'text', part });
  });

  test('a turn whose prose is finished and whose calls are done is thinking, not writing', () => {
    // The reported misplacement: the caret used to render after the last TEXT
    // part, which is above the tool rows that followed it. There is no text
    // being written here at all — the model is between steps.
    const parts: Part[] = [
      text('Reading the handler.', 'done'),
      tool('a', 'output-available'),
      tool('b', 'output-available'),
    ];
    expect(liveTail(parts)).toEqual({ kind: 'thinking' });
  });

  test('a call in flight owns the indicator — nothing is added after it', () => {
    // Its own row already carries a live dot. A second indicator below it
    // would claim two things are happening.
    for (const state of ['input-streaming', 'input-available'] as const) {
      expect(liveTail([text('Running the suite.', 'done'), tool('a', state)]))
        .toEqual({ kind: 'tool' });
    }
  });

  test('streaming reasoning points at its own block rather than adding a row', () => {
    const part = reasoning('SAVE20 fails and SAVE10 does not, so', 'streaming');
    expect(liveTail([part])).toEqual({ kind: 'reasoning', part });
  });

  test('closed reasoning with nothing after it is thinking', () => {
    expect(liveTail([reasoning('Settled on the guard.', 'done')])).toEqual({ kind: 'thinking' });
  });

  test('a turn with no parts yet is thinking — the pre-first-token window', () => {
    expect(liveTail([])).toEqual({ kind: 'thinking' });
  });

  test('a part the stream never closed is treated as the one being written', () => {
    // `state` is optional on both text and reasoning parts. Undefined means
    // the stream never said, and this is only ever asked of an OPEN stream, so
    // the honest reading is "still arriving" — never a caret that vanishes.
    const part = text('no state field');
    expect(liveTail([part])).toEqual({ kind: 'text', part });
  });

  test('a file part does not claim the tail — it is not a stream position', () => {
    const part = text('Here is the chart', 'streaming');
    const parts: Part[] = [part, { type: 'file', mediaType: 'image/png', url: 'data:,' }];
    expect(liveTail(parts)).toEqual({ kind: 'text', part });
  });
});
