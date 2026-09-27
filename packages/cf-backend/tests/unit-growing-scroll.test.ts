/**
 * Where a reopened conversation puts its reader, driven through `useGrowingScroll`'s callback ref under React's static
 * renderer. The anchor correction across a prepend is pixels, measured in Chrome by `scripts/chat-scroll.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useGrowingScroll } from '../src/hooks/use-growing-scroll';
import type { ConversationScroll } from '../src/hooks/use-conversation-ui-state';

interface TestScrollHost {
  readonly style: { overflowAnchor: string };
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
  readonly children: readonly never[];
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
function scrollHost(scrollHeight: number, clientHeight: number): TestScrollHost {
  const max = Math.max(0, scrollHeight - clientHeight);
  let top = 0;

  return {
    style: { overflowAnchor: '' },
    scrollHeight,
    clientHeight,
    get scrollTop(): number { return top; },
    set scrollTop(next: number) { top = Math.min(Math.max(0, next), max); },
    children: [],
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener(): void {},
    removeEventListener(): void {},
  };
}

interface Reader {
  attach(host: TestScrollHost): void;
  readonly reported: ConversationScroll[];
  readonly calls: { edge: number };
}

function reader(initialScroll: ConversationScroll | undefined, settled = true): Reader {
  const reported: ConversationScroll[] = [];
  const calls = { edge: 0 };
  const captured: CapturedRef = {};

  function Conversation(): null {
    captured.ref = useGrowingScroll({
      grows: 'up',
      content: 'transcript',
      fetched: 'page',
      settled,
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
    const conversation = reader(500);
    const host = scrollHost(700, 140);

    conversation.attach(host);

    expect(host.scrollTop).toBe(500);
    expect(conversation.reported).toEqual([500]);
    expect(conversation.calls.edge).toBe(0);
  });

  test('a remembered offset past the loaded transcript opens at the newest message and fetches nothing', () => {
    const conversation = reader(900);
    const host = scrollHost(700, 140);

    conversation.attach(host);

    expect(host.scrollTop).toBe(560);
    expect(conversation.reported).toEqual(['pinned']);
    expect(conversation.calls.edge).toBe(0);
  });

  test('before the first content arrives the offset waits instead of giving up', () => {
    const waiting = reader(500, false);
    const empty = scrollHost(140, 140);

    waiting.attach(empty);
    expect(waiting.reported).toEqual([]);

    const arrived = reader(500, true);
    const host = scrollHost(700, 140);
    arrived.attach(host);
    expect(host.scrollTop).toBe(500);
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
