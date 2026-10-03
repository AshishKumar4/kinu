/**
 * Where a reopened conversation puts its reader, driven through `useGrowingScroll`'s callback ref under React's static
 * renderer. The anchor correction across a prepend is pixels, measured in Chrome by `tests/browser/chat-scroll.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HISTORY_RESERVE_ATTRIBUTE, SCROLL_EDGE_ATTRIBUTE, useGrowingScroll } from '../src/hooks/use-growing-scroll';
import type { ConversationScroll } from '../src/hooks/use-conversation-ui-state';

interface TestScrollRow {
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  readonly isConnected: boolean;
}

interface TestScrollHost {
  readonly style: { overflowAnchor: string };
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
  readonly children: readonly TestScrollRow[];
  dispatchScroll(): void;
  prependReserve(height: number): void;
  getBoundingClientRect(): { readonly top: number };
  addEventListener(
    type: 'scroll', listener: () => void, options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: 'scroll', listener: () => void): void;
}

interface CapturedRef {
  ref?: (node: TestScrollHost | null) => void;
}

/** `scrollTop` clamps like an element's: load-bearing, since the hook reads the value back to decide whether
 *  to prefetch. */
function scrollHost(scrollHeight: number, clientHeight: number, reserved = 0): TestScrollHost {
  let height = scrollHeight;
  let prefix = reserved;
  let top = 0;
  let listener: (() => void) | null = null;

  return {
    style: { overflowAnchor: '' },
    get scrollHeight(): number { return height; },
    clientHeight,
    get scrollTop(): number { return top; },
    set scrollTop(next: number) { top = Math.min(Math.max(0, next), Math.max(0, height - clientHeight)); },
    children: [
      {
        getBoundingClientRect: () => ({ top: -top, bottom: prefix - top }),
        hasAttribute: (name: string) => name === SCROLL_EDGE_ATTRIBUTE || name === HISTORY_RESERVE_ATTRIBUTE,
        getAttribute: () => null,
        isConnected: true,
      },
      {
        getBoundingClientRect: () => ({ top: prefix - top, bottom: height - top }),
        hasAttribute: () => false,
        getAttribute: () => null,
        isConnected: true,
      },
    ],
    getBoundingClientRect: () => ({ top: 0 }),
    dispatchScroll(): void { listener?.(); },
    prependReserve(next): void {
      height += next - prefix;
      prefix = next;
    },
    addEventListener(_type, onScroll): void { listener = onScroll; },
    removeEventListener(): void { listener = null; },
  };
}

interface Reader {
  attach(host: TestScrollHost): void;
  readonly reported: ConversationScroll[];
  readonly calls: { edge: number };
}

function reader(initialScroll: ConversationScroll | undefined): Reader {
  const reported: ConversationScroll[] = [];
  const calls = { edge: 0 };
  const captured: CapturedRef = {};

  function Conversation(): null {
    captured.ref = useGrowingScroll({
      grows: 'up',
      content: 'transcript',
      fetched: 'page',
      initialScroll,
      onReachEdge: () => { calls.edge += 1; },
      onScrollPosition: (position) => { reported.push(position); },
    });

    return null;
  }

  renderToStaticMarkup(createElement(Conversation));

  const ref = captured.ref;

  if (ref === undefined) throw new Error('useGrowingScroll returned no container ref');

  return { attach: ref, reported, calls };
}

describe('a conversation reopened where its reader left it', () => {
  test('a remembered offset inside the loaded transcript is restored without a fetch', () => {
    for (const reserved of [0, 8000]) {
      const conversation = reader(500);
      const host = scrollHost(reserved + 700, 140, reserved);

      conversation.attach(host);

      expect(host.scrollTop).toBe(reserved + 500);
      expect(conversation.reported).toEqual([500]);
      host.scrollTop = reserved + 450;
      host.dispatchScroll();
      expect(conversation.reported).toEqual([500, 450]);
      expect(conversation.calls.edge).toBe(0);
    }
  });

  test('a remembered offset past the loaded transcript opens at the newest message and fetches nothing', () => {
    for (const reserved of [0, 8000]) {
      const conversation = reader(900);
      const host = scrollHost(reserved + 700, 140, reserved);

      conversation.attach(host);

      expect(host.scrollTop).toBe(reserved + 560);
      expect(conversation.reported).toEqual(['pinned']);
      expect(conversation.calls.edge).toBe(0);
    }
  });

  test('a spot in unloaded history returns to the newest message without a fetch', () => {
    const previous = reader('pinned');
    const host = scrollHost(8700, 140, 8000);

    previous.attach(host);
    host.scrollTop = 7400;
    host.dispatchScroll();
    expect(previous.reported).toEqual([-600]);

    const reopened = reader(previous.reported[0]);
    const returned = scrollHost(8700, 140, 8000);

    reopened.attach(returned);
    expect(returned.scrollTop).toBe(8560);
    expect(reopened.reported).toEqual(['pinned']);
    expect(reopened.calls.edge).toBe(0);
  });

  test('the mount and restore scroll events hold their position when unread history arrives before them', () => {
    for (const saved of [undefined, 'pinned', 900, 500] as const) {
      const conversation = reader(saved);
      const host = scrollHost(700, 140);

      conversation.attach(host);
      const before = [...conversation.reported];

      host.prependReserve(8000);
      host.dispatchScroll();

      expect(host.scrollTop).toBe(saved === 500 ? 8500 : 8560);
      expect(conversation.reported).toEqual(before);
      expect(conversation.calls.edge).toBe(0);
    }
  });

  test('a reader who left at the live edge is returned to the live edge', () => {
    // 'pinned' and absence arm no restore: new turns arrived above yesterday's offset.
    for (const saved of ['pinned', undefined] as const) {
      const conversation = reader(saved);
      const host = scrollHost(700, 140);

      conversation.attach(host);

      expect(host.scrollTop).toBe(560);
      expect(conversation.reported).toEqual([]);
      expect(conversation.calls.edge).toBe(0);
    }
  });
});
