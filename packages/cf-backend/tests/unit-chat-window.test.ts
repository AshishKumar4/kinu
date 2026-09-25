/**
 * A transcript frame carries only the server's newest window, so each turn slides rows out of it.
 * The pane must keep every row it already showed: a slid row is neither in the window nor on the
 * older pages, which start behind the first row the pane ever held.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import type { ChatHistoryEntry, Page, Rpc } from '@kinu.run/core';

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


  test('a window sharing no row with the last one leaves a gap: the kept rows go', () => {
    expect(shownAfter([rows('m1', 'm2'), rows('m2', 'm3'), rows('m90', 'm91')])).toEqual(['m90', 'm91']);
  });
});

/**
 * The older-page walk runs in effects, which static rendering skips, so these mount under React's client
 * reconciler. The pane returns no element, so the container and window are the few fields React reads.
 */
describe('the older pages under a sliding window', () => {
  const KEYS = ['window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  beforeAll(() => {
    Object.assign(globalThis, { window: { HTMLIFrameElement: class {}, document: { activeElement: null } }, IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterAll(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });

  function entry(id: string): ChatHistoryEntry {
    return { id, role: 'user', content: id, createdAt: 0 };
  }

  const Query = v.tuple([v.object({ cursor: v.optional(v.unknown()) })]);

  /** The store: forty rows older than `m41`, and nothing older than anything else. Sent as JSON, as the socket does. */
  const stored: Rpc = async (_method, args) => {
    const [{ cursor }] = v.parse(Query, args);

    const page: Page<ChatHistoryEntry> = JSON.stringify(cursor ?? null).includes('m41')
      ? { status: 'end', items: Array.from({ length: 40 }, (_, index) => entry(`m${String(index + 1)}`)) }
      : { status: 'end', items: [] };

    return JSON.parse(JSON.stringify(page));
  };

  async function shownThrough(frames: readonly (readonly UIMessage[])[]): Promise<string[][]> {
    const listens = { addEventListener() {}, removeEventListener() {} };
    const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
    const root = createRoot(container);
    const seen: string[][] = [];
    let shown: string[] = [];

    function Pane({ frame }: { frame: readonly UIMessage[] }): null {
      shown = useChatThread({ rpc: stored, live: frame, seeded: true }).transcript.map((message) => message.id);

      return null;
    }

    for (const frame of frames) {
      await act(async () => { root.render(createElement(Pane, { frame })); });
      seen.push(shown);
    }

    await act(async () => { root.unmount(); });

    return seen;
  }

  test('the walk loads the rows older than the window', async () => {
    const [first] = await shownThrough([rows('m41', 'm42')]);

    expect(first?.length).toBe(42);
  });

  test('a clear from another tab drops the older pages with the kept rows', async () => {
    const seen = await shownThrough([rows('m41', 'm42'), [], rows('n1')]);

    expect(seen.slice(1)).toEqual([[], ['n1']]);
  });
});
