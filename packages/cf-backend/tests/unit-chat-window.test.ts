/**
 * A transcript frame carries only the server's newest window, so each turn slides rows out of it.
 * The pane must keep every row it already showed: a slid row is neither in the window nor on the
 * older pages, which start behind the first row the pane ever held.
 */
import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UIMessage } from 'ai';
import type { Rpc } from '@kinu.run/core';

import { useChatThread } from '../src/hooks/use-chat-thread';

function rows(...ids: string[]): UIMessage[] {
  return ids.map((id) => ({ id, role: 'user', parts: [{ type: 'text', text: id }] }));
}

/** The pages are never asked for here: every frame's rows are ones the pane already has or is handed. */
const rpc: Rpc = async (method: string): Promise<never> => {
  throw new Error(`the pane fetched ${method}`);
};

/** Renders the pane over successive frames and returns the ids it shows after the last one. */
function shownAfter(frames: readonly (readonly UIMessage[])[]): string[] {
  let shown: string[] = [];

  function Probe(): null {
    const [tick, setTick] = useState(0);
    const { transcript } = useChatThread({ rpc, live: frames[tick] ?? [], seeded: false });
    shown = transcript.map((message) => message.id);

    if (tick < frames.length - 1) setTick(tick + 1);

    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  return shown;
}

describe('the chat pane over a sliding transcript window', () => {
  test('a window that moved forward keeps what left its front, oldest first', () => {
    expect(shownAfter([rows('m1', 'm2', 'm3'), rows('m2', 'm3', 'm4'), rows('m4', 'm5', 'm6')]))
      .toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  test('a frame with the same front, a streamed token or a repeated seed, shows nothing twice', () => {
    expect(shownAfter([rows('m1', 'm2'), rows('m2', 'm3'), rows('m2', 'm3'), rows('m2', 'm3', 'm4')]))
      .toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  test('an empty frame is a clear: nothing kept survives it', () => {
    expect(shownAfter([rows('m1', 'm2'), rows('m2', 'm3'), [], rows('n1')])).toEqual(['n1']);
  });

  test('a window sharing no row with the last one leaves a gap: the kept rows go', () => {
    expect(shownAfter([rows('m1', 'm2'), rows('m2', 'm3'), rows('m90', 'm91')])).toEqual(['m90', 'm91']);
  });
});
