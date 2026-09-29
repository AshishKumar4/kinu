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
import { PositionCursorSchema, type ChatHistoryEntry, type ChatHistoryPage, type Rpc } from '@kinu.run/core';

import { useChatThread, type ChatThread } from '../src/hooks/use-chat-thread';

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

  function entries(...ids: string[]): ChatHistoryEntry[] {
    return ids.map((id, position) => ({ id, position, role: 'user', content: id, createdAt: 0 }));
  }

  const Query = v.tuple([v.object({ cursor: v.optional(PositionCursorSchema), limit: v.number() })]);

  /** Answers position pages over `store`, sent as JSON, as the socket does. */
  function storeOf(store: () => readonly ChatHistoryEntry[]): Rpc {
    return async (_method, args) => {
      const [{ cursor, limit }] = v.parse(Query, args);
      const end = Math.min(cursor?.before ?? store().length, store().length);
      const start = Math.max(0, end - limit);
      const items = store().slice(start, end);
      const page: ChatHistoryPage = start === 0 ? { status: 'end', items } : { status: 'more', items, next: { before: start } };

      return JSON.parse(JSON.stringify(page));
    };
  }

  let lastTranscript: readonly UIMessage[] = [];

  const FORTY_TWO = entries(...Array.from({ length: 42 }, (_, index) => `m${String(index + 1)}`));

  /** Each frame rendered in turn over its store; `reachEdge` is the scroller reporting the reader at the top. */
  async function shownThrough(
    frames: readonly (readonly UIMessage[])[], reachEdge = false, stores: readonly (readonly ChatHistoryEntry[])[] = [FORTY_TWO],
  ): Promise<string[][]> {
    let at = 0;
    const stored = storeOf(() => stores[Math.min(at, stores.length - 1)] ?? []);
    const pane = mountThread(stored);
    const seen: string[][] = [];

    for (const [index, frame] of frames.entries()) {
      at = index;
      await pane.render(frame);

      if (reachEdge) await act(async () => { pane.thread().history.loadMore(); });
      lastTranscript = pane.thread().transcript;
      seen.push(lastTranscript.map((message) => message.id));
    }

    await pane.close();

    return seen;
  }

  function mountThread(stored: Rpc) {
    const listens = { addEventListener() {}, removeEventListener() {} };
    const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
    const root = createRoot(container);
    let current: ChatThread | undefined;

    function Pane({ frame }: { frame: readonly UIMessage[] }): null {
      current = useChatThread({ rpc: stored, live: frame, seeded: true });

      return null;
    }

    return {
      async render(frame: readonly UIMessage[]): Promise<void> {
        await act(async () => { root.render(createElement(Pane, { frame })); });
      },
      thread(): ChatThread {
        if (current === undefined) throw new Error('the pane has not rendered');

        return current;
      },
      async close(): Promise<void> {
        await act(async () => { root.unmount(); });
      },
    };
  }

  test('a steer stays before an unloaded gap until its own assistant page arrives', async () => {
    const store: ChatHistoryEntry[] = Array.from({ length: 5000 }, (_, position) => ({
      id: 'm' + String(position), position, role: 'assistant', content: 'reply ' + String(position), createdAt: 0,
    }));

    store[199] = { id: 'steer', position: 199, role: 'user', content: 'old redirect', createdAt: 0, metadata: { kinuSteer: true, kinuSteerAtStep: 1 } };
    const pane = mountThread(storeOf(() => store));

    const readAt = async (from: number): Promise<void> => {
      await act(async () => { pane.thread().history.read({ start: from, end: 4800, from, urgent: true }); });
    };

    try {
      await pane.render([]);
      await act(async () => { pane.thread().history.loadMore(true); });
      await readAt(0);
      const sparse = pane.thread();
      expect(sparse.reserves.before.get('m4800')).toEqual({ start: 200, end: 4800 });
      expect(sparse.thread.entries.find(({ message }) => message.id === 'm4800')?.steers).toEqual([]);
      expect(sparse.thread.entries.find(({ message }) => message.id === 'steer')?.message.parts).toEqual([{ type: 'text', text: 'old redirect' }]);

      await readAt(200);
      const filled = pane.thread().thread.entries;
      expect(filled.find(({ message }) => message.id === 'm200')?.steers.map(({ id }) => id)).toEqual(['steer']);
      expect(filled.some(({ message }) => message.id === 'steer')).toBe(false);
      expect(filled.find(({ message }) => message.id === 'm4800')?.steers).toEqual([]);
    } finally {
      await pane.close();
    }
  });

  test('no older page loads until the reader reaches the top', async () => {
    const [first] = await shownThrough([rows('m41', 'm42')]);

    expect(first).toEqual(['m41', 'm42']);
  });

  test('the walk loads the rows older than the window', async () => {
    const [first] = await shownThrough([rows('m41', 'm42')], true);

    expect(first?.length).toBe(42);
  });

  // A reconnect can re-seed a wider window, so one row legitimately arrives both ways; React drops a duplicate key silently.
  test('a row read from the store and held live renders once, as the live copy', async () => {
    const live: UIMessage[] = [{ id: 'm41', role: 'user', parts: [{ type: 'text', text: 'm41' }], metadata: { kinuSignal: 'live' } }, ...rows('m42')];
    const [first] = await shownThrough([live], true);

    expect(first).toEqual(FORTY_TWO.map((entry) => entry.id));
    expect(lastTranscript.find((message) => message.id === 'm41')?.metadata).toEqual({ kinuSignal: 'live' });
  });

  test('a clear from another tab drops the older pages with the kept rows', async () => {
    const seen = await shownThrough([rows('m41', 'm42'), [], rows('n1')], true, [FORTY_TWO, [], entries('n1')]);

    expect(seen.slice(1)).toEqual([[], ['n1']]);
  });
});
