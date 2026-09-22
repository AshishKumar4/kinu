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
import './helpers/ui-module-globals';
import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai';
import { liveTail, threadLiveTail, turnLiveness, type TurnLiveness } from '@kinu.run/core';
import { ChatLiveTail, MessageView } from '../src/components/MessageView';
import { Composer } from '../src/components/Composer';

/** The composer as WorkspacePage mounts it: one liveness value, nothing else
 *  that decides which action row it draws. */
function composerMarkup(liveness: TurnLiveness): string {
  return renderToStaticMarkup(createElement(Composer, {
    value: '', onValueChange: () => {}, onSend: () => {}, placeholder: 'Send a message...',
    disabled: false, liveness, onStop: () => {}, onRecover: () => Promise.resolve(),
  }));
}

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
    // The reported misplacement: a caret rendered after the last TEXT part sits
    // above the tool rows that followed it. There is no text being written here
    // at all — the model is between steps.
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

describe('turnLiveness', () => {
  test('an admitted claim is live even before the client sees a token', () => {
    expect(turnLiveness({ claim: { kind: 'admitted', turnId: 't1', claimedAt: 10 }, streaming: false }))
      .toEqual({ kind: 'live', turnId: 't1' });
  });

  test('a client streaming ahead of the next snapshot is live', () => {
    expect(turnLiveness({ claim: { kind: 'settled' }, streaming: true })).toEqual({ kind: 'live', turnId: null });
  });

  test('a stranded claim is not live — Stop would never land', () => {
    // The isolate that admitted this turn is gone. Nothing will settle the
    // claim and nothing will answer an interrupt, so the surface must not
    // offer one.
    expect(turnLiveness({ claim: { kind: 'stranded', turnId: 't9', claimedAt: 4 }, streaming: true }))
      .toEqual({ kind: 'stranded', turnId: 't9', claimedAt: 4 });
  });

  test('nothing claimed and nothing streaming is idle', () => {
    expect(turnLiveness({ claim: null, streaming: false })).toEqual({ kind: 'idle' });
  });
});

describe('the thread the page paints', () => {
  const userTurn: UIMessage = { id: 'u1', role: 'user', parts: [text('build the chess app')] };

  test("a live turn whose last row is the user's still has a tail", () => {
    // The reported wedge: Stop offered, no Thinking row. `isLast && streaming
    // && !isUser` is false for every turn before its first assistant row.
    const liveness = turnLiveness({ claim: { kind: 'admitted', turnId: 't1', claimedAt: 1 }, streaming: true });
    expect(threadLiveTail({ last: userTurn, liveness })).toEqual({ kind: 'thinking' });
  });

  test('an idle thread has no tail at all', () => {
    expect(threadLiveTail({ last: userTurn, liveness: { kind: 'idle' } })).toBeNull();
  });

  test('a stranded turn paints no live tail — it is not working', () => {
    expect(threadLiveTail({ last: userTurn, liveness: { kind: 'stranded', turnId: 't9', claimedAt: 4 } })).toBeNull();
  });

  test('a live assistant row reads its own parts', () => {
    const part = text('half a sen', 'streaming');
    const last: UIMessage = { id: 'a1', role: 'assistant', parts: [part] };
    expect(threadLiveTail({ last, liveness: { kind: 'live', turnId: 't1' } })).toEqual({ kind: 'text', part });
  });
});

describe('WorkspacePage paints exactly one live indicator', () => {
  /** The page's thread block, assembled the way WorkspacePage assembles it:
   *  every message through MessageView, then the tail the page owns. */
  function thread(messages: readonly UIMessage[], liveness: TurnLiveness): string {
    const tail = threadLiveTail({ last: messages.at(-1), liveness });

    return renderToStaticMarkup(createElement('div', null,
      messages.map((message) => createElement(MessageView, {
        key: message.id, message, liveTail: message === messages.at(-1) ? tail : null,
      })),
      createElement(ChatLiveTail, { tail }),
    ));
  }

  const indicators = (markup: string) => markup.split('data-live-indicator').length - 1;

  test("a user-last transcript on a live turn paints one indicator and offers Stop", () => {
    const liveness = turnLiveness({ claim: { kind: 'admitted', turnId: 't1', claimedAt: 1 }, streaming: true });
    const markup = thread([{ id: 'u1', role: 'user', parts: [text('build the chess app')] }], liveness);

    expect(indicators(markup)).toBe(1);
    expect(composerMarkup(liveness)).toContain('Stop this turn');
  });

  test('a streaming assistant row carries the indicator itself — the page adds none', () => {
    const liveness = turnLiveness({ claim: { kind: 'admitted', turnId: 't1', claimedAt: 1 }, streaming: true });

    const markup = thread([
      { id: 'u1', role: 'user', parts: [text('go')] },
      { id: 'a1', role: 'assistant', parts: [text('Reading the han', 'streaming')] },
    ], liveness);

    expect(indicators(markup)).toBe(1);
  });

  test('an idle thread paints none', () => {
    const markup = thread([
      { id: 'u1', role: 'user', parts: [text('go')] },
      { id: 'a1', role: 'assistant', parts: [text('Done.', 'done')] },
    ], { kind: 'idle' });

    expect(indicators(markup)).toBe(0);
  });

  test('a stranded turn offers recovery, never Stop', () => {
    const liveness = turnLiveness({ claim: { kind: 'stranded', turnId: 't9', claimedAt: 4 }, streaming: true });
    const markup = thread([{ id: 'u1', role: 'user', parts: [text('go')] }], liveness);

    expect(indicators(markup)).toBe(0);

    const composer = composerMarkup(liveness);
    expect(composer).not.toContain('Stop this turn');
    expect(composer).toContain('Recover this turn');
  });
});
