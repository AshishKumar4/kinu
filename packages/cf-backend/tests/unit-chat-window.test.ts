/**
 * A steer read from the store before its answer's page has arrived. The sliding window, paging, the live copy and a
 * clear are proved in the browser (tests/browser/chat-sparse-pages.test.ts); this case needs a page boundary to land
 * exactly between a steer and its answer, which the page's adaptive page sizes do not let a browser flow place.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import type { UIMessage } from 'ai';
import { createRoot } from 'react-dom/client';
import * as v from 'valibot';
import { PositionCursorSchema, type ChatHistoryEntry, type ChatHistoryPage, type Rpc } from '@kinu.run/core';

import { useChatThread, type ChatThread } from '../src/hooks/use-chat-thread';

/** The page walk runs in effects, so this mounts under React's client reconciler; the pane returns no element. */
describe('a steer before an unloaded gap', () => {
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
});
