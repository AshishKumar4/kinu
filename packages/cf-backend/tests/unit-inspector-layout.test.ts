/**
 * The inspector layout policy, exercised through the hook the page mounts:
 * stored prefs round-trip through the account key, a mount report persists
 * nothing and vetoes nothing, and the apply loop's 30-frame bound holds in
 * both phases.
 *
 * React's static renderer runs the hook for real — `useState`,
 * `useCallback`, every ref — and skips effects. The one decision that lives
 * inside an effect is the apply loop, so `useLayoutEffect` is collected and
 * the harness flushes it against a frame queue, exactly where a browser's
 * commit would run it. The browser rows in scripts/chat-and-files-ux.test.ts
 * cover the pixels.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realReact from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useInspectorLayout, type InspectorLayout } from '../src/hooks/use-inspector-layout';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';

let store: Record<string, string> = {};

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  },
});

/* A wide display: the media query the hook reads answers "desktop". */
Object.assign(globalThis, {
  window: {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  },
});

/* The apply loop's frame stream: a manual queue, drained by the harness, so a
 * test sees exactly the frames a rAF stream would have run. */
const frameQueue: { id: number; cb: () => void }[] = [];

let nextFrameId = 0;

Object.assign(globalThis, {
  requestAnimationFrame: (cb: () => void) => {
    const id = ++nextFrameId;
    frameQueue.push({ id, cb });

    return id;
  },
  cancelAnimationFrame: (id: number) => {
    const at = frameQueue.findIndex((frame) => frame.id === id);

    if (at >= 0) frameQueue.splice(at, 1);
  },
});

/* `useLayoutEffect` is a no-op under the static renderer, so the registrations
 * are collected instead; each mount flushes its own — deps-deduped across a
 * re-render, cleaned up across a deps change, as a commit would. */
interface LayoutEffect {
  readonly generation: number;
  readonly cb: () => void | (() => void);
  readonly deps: readonly unknown[] | undefined;
}

const layoutEffects: LayoutEffect[] = [];

let generation = 0;

await mock.module('react', () => ({
  ...realReact,
  useLayoutEffect: (cb: LayoutEffect['cb'], deps?: readonly unknown[]) => {
    layoutEffects.push({ generation, cb, deps });
  },
}));

afterAll(() => { mock.restore(); });

const px = (inPixels: number): PanelSize => ({ asPercentage: 0, inPixels });

const depsEqual = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

interface PanelStub {
  readonly handle: PanelImperativeHandle;
  /** Every imperative resize the loop issued. */
  readonly resizes: number[];
  /** What `isCollapsed`/`getSize` read back. */
  readonly state: { collapsed: boolean; sizePx: number };
}

function panelStub(sizePx: number): PanelStub {
  const state = { collapsed: false, sizePx };
  const resizes: number[] = [];

  return {
    resizes,
    state,
    handle: {
      collapse: () => { state.collapsed = true; },
      expand: () => { state.collapsed = false; },
      getSize: () => ({ asPercentage: 0, inPixels: state.collapsed ? 0 : state.sizePx }),
      isCollapsed: () => state.collapsed,
      resize: (size: number | string) => { resizes.push(Number(size)); state.sizePx = Number(size); },
    },
  };
}

interface Pass {
  readonly attrs: string;
  readonly layout: InspectorLayout;
}

interface Controls {
  /** Runs this mount's collected layout effects, once per deps change. */
  flush(): void;
  /** The effect's own cancellation, as an unmount/cleanup would run it. */
  cancelEffects(): void;
  /** Plays back queued animation frames, in order, up to `max`. */
  frames(max?: number): number;
  /** Frames the loop has scheduled and not yet run. */
  pendingFrames(): number;
}

interface Mounted {
  readonly html: string;
  readonly passes: readonly Pass[];
  readonly layout: InspectorLayout;
  readonly controls: Controls;
}

/** The inspector column as the page's hook hands it over. `account` seeds the
 *  account key the way a returning session's profile write did; `stored`
 *  seeds that account's persisted prefs. Steps run inside the render pass —
 *  a same-component state update re-renders immediately, so frames drained
 *  and handlers called there see the same ordering a commit stream would.
 *  The hook's return rides the column element as data-* attributes. */
function mount(input: {
  account: string | null;
  stored?: string;
  steps?: readonly ((layout: InspectorLayout, controls: Controls) => void)[];
}): Mounted {
  const passes: Pass[] = [];
  const gen = ++generation;
  let ranDeps: readonly unknown[] | undefined;
  let ran = false;
  let cancel: (() => void) | undefined;

  if (input.account !== null) {
    localStorage.setItem('kinu.inspector.account', input.account);

    if (input.stored !== undefined) localStorage.setItem(`kinu.inspector.${input.account}`, input.stored);
  }

  const controls: Controls = {
    flush() {
      for (const effect of layoutEffects.splice(0)) {
        if (effect.generation !== gen) { layoutEffects.push(effect); continue; }

        if (ran && depsEqual(effect.deps, ranDeps)) continue;
        cancel?.();
        cancel = undefined;
        ran = true;
        ranDeps = effect.deps;
        const cleanup = effect.cb();

        if (cleanup !== undefined) cancel = cleanup;
      }
    },
    cancelEffects() {
      cancel?.();
      cancel = undefined;
    },
    frames(max = 60) {
      let played = 0;

      while (frameQueue.length > 0 && played < max) {
        frameQueue.shift()?.cb();
        played += 1;
      }

      return played;
    },
    pendingFrames: () => frameQueue.length,
  };

  function Column() {
    const layout = useInspectorLayout({ desktopPanels: true, mobileDefault: '0%' });

    const attrs = `data-width="${String(layout.widthPx)}" `
      + `data-collapsed="${String(layout.collapsed)}" `
      + `data-ready="${String(layout.ready)}" `
      + `data-expand-visible="${String(layout.expandVisible)}" `
      + `data-collapse-control="${layout.collapseControl === undefined ? '' : 'yes'}" `
      + `data-min-size="${layout.panelProps.minSize ?? ''}" `
      + `data-default-size="${layout.panelProps.defaultSize ?? ''}"`;

    passes.push({ attrs, layout });
    input.steps?.[passes.length - 1]?.(layout, controls);

    return realReact.createElement('div', {
      'data-width': String(layout.widthPx),
      'data-collapsed': String(layout.collapsed),
      'data-ready': String(layout.ready),
      'data-expand-visible': String(layout.expandVisible),
      'data-collapse-control': layout.collapseControl === undefined ? '' : 'yes',
      'data-min-size': layout.panelProps.minSize ?? '',
      'data-default-size': layout.panelProps.defaultSize ?? '',
    });
  }

  const html = renderToStaticMarkup(realReact.createElement(Column));

  if (input.steps !== undefined && passes.length < input.steps.length) {
    throw new Error(`a scripted step never ran: ${String(passes.length)} pass(es) for ${String(input.steps.length)} step(s)`);
  }

  return { html, passes, layout: passes.at(-1)!.layout, controls };
}

beforeEach(() => {
  store = {};
  frameQueue.length = 0;
  layoutEffects.length = 0;
});

describe('the persisted layout, through the page hook', () => {
  test('an account with nothing stored reads as absent, never a default', () => {
    // No account key at all: the restore never gets an account to read for,
    // so it never settles and never writes.
    const anonymous = mount({
      account: null,
      steps: [(_layout, controls) => { controls.flush(); controls.frames(); }],
    });

    expect(anonymous.html).toContain('data-default-size="340px"');
    expect(anonymous.html).toContain('data-ready="false"');
    expect(store).toEqual({});

    // A stored value in no shape the reader accepts is absent, not a width —
    // the column still settles at the default and writes nothing back.
    const malformed = mount({
      account: 'a@b',
      stored: 'not-a-width',
      steps: [(_layout, controls) => { controls.flush(); controls.frames(); }],
    });

    expect(malformed.html).toContain('data-default-size="340px"');
    expect(malformed.html).toContain('data-ready="true"');
    expect(store).toEqual({
      'kinu.inspector.account': 'a@b',
      'kinu.inspector.a@b': 'not-a-width',
    });
  });

  test('a write reads back: width and collapsed survive the string form', () => {
    const first = mount({ account: 'a@b' });
    const stub = panelStub(340);

    first.layout.panelRef.current = stub.handle;
    first.layout.toggleCollapsed();
    expect(store['kinu.inspector.a@b']).toBe('340:1');

    // A fresh mount reads `340:1` back: the collapse restores through the
    // panel and into the hook's own state.
    const second = mount({
      account: 'a@b',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(second.html).toContain('data-collapsed="true"');
    expect(second.html).toContain('data-expand-visible="true"');
    expect(second.html).toContain('data-ready="true"');
    expect(stub.state.collapsed).toBe(true);

    // The account key is real isolation, not a suffix nobody reads.
    const other = mount({
      account: 'other@b',
      steps: [(_layout, controls) => { controls.flush(); controls.frames(); }],
    });

    expect(other.html).toContain('data-collapsed="false"');
    expect(other.html).toContain('data-default-size="340px"');
    expect(other.html).toContain('data-ready="true"');
  });
  test('the pixel floor clamps what a stored width reads back as', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      stored: '120:0',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(stub.resizes).toEqual([280]);
    expect(mounted.html).toContain('data-width="280"');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('the default opening stays inside the design band above the floor', () => {
    const mounted = mount({ account: 'a@b' });

    expect(mounted.html).toContain('data-min-size="280px"');
    expect(mounted.html).toContain('data-default-size="340px"');
  });
});

describe('the resize decision, through the page hook', () => {
  test('the mount report is the default layout announcing itself: it persists nothing and vetoes nothing', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      stored: '300:0',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        controls.frames(3);
        // The loop is still waiting on the first measured pass: rescheduling,
        // not resizing blind into a layout the group's first pass owns.
        expect(stub.resizes).toEqual([]);

        layout.onResize(px(340), 'inspector', undefined);
        // The announcement carries no intent: the stored size is untouched.
        expect(store['kinu.inspector.a@b']).toBe('300:0');
        controls.frames();
      }],
    });

    // And it vetoed nothing — the pending restore still applied.
    expect(stub.resizes).toEqual([300]);
    expect(store['kinu.inspector.a@b']).toBe('300:0');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a real report clamps at the floor and reads sub-pixel as collapsed', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
      }],
    });

    const layout = mounted.layout;

    // Each report arrives after the group's own pass settled on that size.
    stub.state.sizePx = 412;
    layout.onResize(px(412), 'inspector', px(340));
    expect(store['kinu.inspector.a@b']).toBe('412:0');

    stub.state.sizePx = 120;
    layout.onResize(px(120), 'inspector', px(412));
    expect(store['kinu.inspector.a@b']).toBe('280:0');

    stub.state.sizePx = 0.4;
    stub.state.collapsed = true;
    // The column's own collapse affordance flipped it: the next report keeps
    // the collapsed flag instead of reviving the column at 300px.
    layout.collapseControl?.();
    stub.state.sizePx = 300;
    stub.state.collapsed = true;
    layout.onResize(px(300), 'inspector', px(280));
    expect(store['kinu.inspector.a@b']).toBe('300:1');
  });
});

describe('the apply loop, through the page hook', () => {
  test('a stored width applies only once the first measured report has landed', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      stored: '300:0',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        controls.frames(3);
        expect(stub.resizes).toEqual([]);
        expect(controls.pendingFrames()).toBe(1);

        // The library's first measured report: the first-pass default layout
        // has run, so an imperative resize now holds.
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(stub.resizes).toEqual([300]);
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a live drag wins mid-loop: the pending restore never applies', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      stored: '300:0',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        controls.frames(2);
        layout.onResize(px(412), 'inspector', px(340));
        controls.frames(5);
      }],
    });

    expect(stub.resizes).toEqual([]);
    expect(store['kinu.inspector.a@b']).toBe('412:0');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a read-back that misses re-asserts, and the 30-frame bound still settles', () => {
    const stub = panelStub(340);
    // The panel ignores the imperative resize: every read-back misses.
    const deaf: PanelImperativeHandle = { ...stub.handle, resize: () => { stub.resizes.push(-1); } };

    const mounted = mount({
      account: 'a@b',
      stored: '300:0',
      steps: [(layout, controls) => {
        layout.panelRef.current = deaf;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames(40);
      }],
    });

    expect(mounted.html).toContain('data-ready="true"');
    expect(stub.resizes.length).toBeLessThanOrEqual(30);
  });

  test('a panel that never reports still settles inside the same bound', () => {
    const stub = panelStub(340);
    mount({
      account: 'a@b',
      stored: '300:0',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        // Thirty frames spent waiting, then the bound lets one apply through
        // rather than spin forever on a panel that reports nothing.
        controls.frames(40);
      }],
    });

    expect(stub.resizes).toEqual([300]);
  });

  test('a stored collapse restores through the panel and reflects into state', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      stored: '300:1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(mounted.html).toContain('data-collapsed="true"');
    expect(mounted.html).toContain('data-expand-visible="true"');
    expect(mounted.html).toContain('data-collapse-control=""');
    expect(stub.state.collapsed).toBe(true);
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('cancellation stops the pending frame', () => {
    const mounted = mount({ account: 'a@b', stored: '300:0' });

    // The effect ran, found no panel yet, and is parked on one frame.
    mounted.controls.flush();
    expect(mounted.controls.pendingFrames()).toBe(1);
    mounted.controls.cancelEffects();
    expect(mounted.controls.pendingFrames()).toBe(0);
    expect(mounted.controls.frames(10)).toBe(0);
    expect(mounted.html).toContain('data-ready="false"');
  });
});
