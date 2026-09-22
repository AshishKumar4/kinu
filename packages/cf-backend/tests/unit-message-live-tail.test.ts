// A live turn's one indicator is derived from each part's stream state, never part order; nothing
// animates on a clock: a closed part reports `thinking`, an open one reports itself.
import './helpers/ui-module-globals';
import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai';
import { threadLiveTail, turnLiveness, type TurnLiveness } from '@kinu.run/core';
import { ChatLiveTail, MessageView } from '../src/components/MessageView';
import { Composer } from '../src/components/Composer';

function composerMarkup(liveness: TurnLiveness): string {
  return renderToStaticMarkup(createElement(Composer, {
    value: '', onValueChange: () => {}, onSend: () => {}, placeholder: 'Send a message...',
    disabled: false, liveness, onStop: () => {}, onRecover: () => Promise.resolve(null),
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
  test('an admitted claim is live even before the client sees a token', () => {
    expect(turnLiveness({ claim: { kind: 'admitted', turnId: 't1', claimedAt: 10 }, streaming: false }))
      .toEqual({ kind: 'live', turnId: 't1' });
  });

  test('a client streaming ahead of the next snapshot is live', () => {
    expect(turnLiveness({ claim: { kind: 'settled' }, streaming: true })).toEqual({ kind: 'live', turnId: null });
  });

  test('a stranded claim is not live — Stop would never land', () => {
    // The admitting isolate is gone: nothing settles the claim or answers an interrupt, so offer none.
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
    // `isLast && streaming && !isUser` is false before the first assistant row.
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
