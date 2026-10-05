/**
 * React tracks the promise a transition's callback returns (an async transition): `isPending` holds until it
 * settles. So a transition's runner is `settle(…)` returned as the callback's result; `detach` returns nothing to
 * track, and the pending state is dropped while the work still runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement, useTransition, type TransitionStartFunction } from 'react';
import { createRoot } from 'react-dom/client';
import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';

describe('a transition edge', () => {
  const KEYS = ['window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = KEYS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));

  beforeAll(() => {
    Object.assign(globalThis, { window: { HTMLIFrameElement: class {}, document: { activeElement: null } }, IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterAll(() => {
    for (const [index, key] of KEYS.entries()) {
      const descriptor = saved[index];

      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  interface TransitionSeen {
    pending: boolean;
    start: TransitionStartFunction | null;
  }

  async function mountTransition() {
    const listens = { addEventListener() {}, removeEventListener() {} };
    const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
    const root = createRoot(container);
    const seen: TransitionSeen = { pending: false, start: null };

    function Probe(): null {
      const [pending, start] = useTransition();
      seen.pending = pending;
      seen.start = start;

      return null;
    }

    await act(async () => { root.render(createElement(Probe)); });

    return { seen, close: async () => { await act(async () => { root.unmount(); }); } };
  }

  function deferred() {
    let release = (): void => {};

    const done = new Promise<void>((resolve) => { release = resolve; });

    return { effect: Effect.promise(() => done), release };
  }

  test('a returned settle keeps the transition pending until its effect settles, then clears it', async () => {
    const { seen, close } = await mountTransition();
    const work = deferred();

    await act(async () => { seen.start?.(() => settle(work.effect)); });
    expect(seen.pending).toBe(true);

    await act(async () => { work.release(); });
    expect(seen.pending).toBe(false);
    await close();
  });
});
