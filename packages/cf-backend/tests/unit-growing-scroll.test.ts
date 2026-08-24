/**
 * Where a reopened conversation puts its reader.
 *
 * `useGrowingScroll` returns a callback ref, and the whole saved-offset
 * decision runs inside it: an "up" scroller mounts at the newest edge, arms the
 * remembered offset, and then either applies it or asks for older pages. So the
 * hook's public surface is drivable directly — render it once, hand its ref a
 * scroll host, and read what it did to that host. React's static renderer is
 * what runs the hook here because it needs no DOM, and the effects it skips are
 * not where this decision lives.
 *
 * What that leaves to a browser rather than to this file: the anchor correction
 * across a prepend arriving through a React commit. That one is a claim about
 * pixels and is measured in Chrome by `scripts/chat-scroll.test.ts` ("a prepend
 * does not move what the reader is reading").
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
  addEventListener(
    type: 'scroll', listener: () => void, options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: 'scroll', listener: () => void): void;
}

interface CapturedRef {
  ref?: (node: TestScrollHost | null) => void;
}

/** One scroller of a fixed size, whose `scrollTop` clamps to `scrollHeight -
 *  clientHeight` exactly as an element's does. That clamp is load-bearing
 *  rather than decorative: the hook mounts by writing the newest edge and then
 *  reads the value back to decide whether to prefetch, so a host that accepted
 *  any number would be measuring a scroller that cannot exist. */
function scrollHost(scrollHeight: number, clientHeight: number): TestScrollHost {
  const max = Math.max(0, scrollHeight - clientHeight);
  let top = 0;
  return {
    style: { overflowAnchor: '' },
    scrollHeight,
    clientHeight,
    get scrollTop(): number { return top; },
    set scrollTop(next: number) { top = Math.min(Math.max(0, next), max); },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
}

interface Reader {
  /** Give the hook a container, as React's commit does. */
  attach(host: TestScrollHost): void;
  /** Every position this reader's place was reported at, in order. */
  readonly reported: ConversationScroll[];
  /** How many times older history has been asked for. */
  readonly calls: { edge: number };
}

/** One mounted conversation column, remembering `initialScroll`. */
function reader(initialScroll: ConversationScroll | undefined, exhausted: boolean): Reader {
  const reported: ConversationScroll[] = [];
  const calls = { edge: 0 };
  const captured: CapturedRef = {};

  function Conversation(): null {
    captured.ref = useGrowingScroll<TestScrollHost>({
      grows: 'up',
      content: 'transcript',
      fetched: 'page',
      exhausted,
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
  test('a remembered offset waits for a transcript tall enough to hold it', () => {
    const conversation = reader(900, false);

    // 560px of travel is all the loaded pages can represent, so the remembered
    // 900 is not reachable yet and older history is exactly what is missing.
    // The reader's place is neither declared reached nor quietly clamped.
    conversation.attach(scrollHost(700, 140));
    expect(conversation.reported).toEqual([]);
    expect(conversation.calls.edge).toBe(1);

    // Over a transcript that can hold it, the same remembered offset is
    // applied exactly, and nothing further is asked for.
    const grown = scrollHost(1080, 140);
    conversation.attach(grown);
    expect(grown.scrollTop).toBe(900);
    expect(conversation.reported).toEqual([900]);
    expect(conversation.calls.edge).toBe(1);
  });

  test('a store with no older page settles at the oldest offset it can reach', () => {
    const conversation = reader(900, true);
    const host = scrollHost(700, 140);

    conversation.attach(host);

    // Exhaustion is what makes the clamp terminal: 900 is unreachable and no
    // page can make it reachable, so 560 is an answer rather than a wait.
    expect(host.scrollTop).toBe(560);
    expect(conversation.reported).toEqual(['pinned']);
    expect(conversation.calls.edge).toBe(0);
  });

  test('a reader who left at the live edge is returned to the live edge', () => {
    // 'pinned' and absence mean the same thing and arm no restore: new turns
    // arrived while they were away, and yesterday's offset sits above them.
    for (const saved of ['pinned', undefined] as const) {
      const conversation = reader(saved, false);
      const host = scrollHost(700, 140);

      conversation.attach(host);

      expect(host.scrollTop).toBe(560);
      expect(conversation.reported).toEqual([]);
      expect(conversation.calls.edge).toBe(0);
    }
  });
});
