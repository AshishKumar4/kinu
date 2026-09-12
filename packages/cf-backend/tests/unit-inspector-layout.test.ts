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
  /** The hook-call index within its render: two renders register the same
   *  logical effect under the same ordinal, so the harness can dedupe it. */
  readonly ordinal: number;
  readonly cb: () => void | (() => void);
  readonly deps: readonly unknown[] | undefined;
}

const layoutEffects: LayoutEffect[] = [];

let generation = 0;

/* Reset by the mounted component at the top of every render, so each
 * registration carries its hook-call index. */
let effectOrdinal = 0;

await mock.module('react', () => ({
  ...realReact,
  useLayoutEffect: (cb: LayoutEffect['cb'], deps?: readonly unknown[]) => {
    layoutEffects.push({ generation, ordinal: effectOrdinal++, cb, deps });
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
  /** The workspace the column belongs to — what the per-workspace open/close
   *  choice keys on. Defaults to `ws-1` so a row that never names one still
   *  exercises the workspace-scoped key. */
  workspace?: string;
  /** Raw value seeded at `kinu.inspector.<account>` — the account's width. */
  storedWidth?: string;
  /** Raw value seeded at `kinu.inspector.open.<account>.<workspace>` — this
   *  workspace's stored open/close choice. */
  storedChoice?: string;
  /** What the page computes for the hook: the workspace holds something the
   *  inspector exists to show. Only consulted while no choice is stored. */
  worthShowing?: boolean;
  steps?: readonly ((layout: InspectorLayout, controls: Controls) => void)[];
}): Mounted {
  const passes: Pass[] = [];
  const gen = ++generation;
  // Effects are tracked by REGISTRATION SLOT: the hook mounts more than one
  // layout effect, and a commit cancels and re-runs each only when ITS OWN
  // deps change — one shared slot would have the second registration cancel
  // the first effect's pending frame on every flush.
  const slots: { deps: readonly unknown[] | undefined; cancel: (() => void) | undefined }[] = [];
  const ws = input.workspace ?? 'ws-1';

  if (input.account !== null) {
    localStorage.setItem('kinu.inspector.account', input.account);

    if (input.storedWidth !== undefined) localStorage.setItem(`kinu.inspector.${input.account}`, input.storedWidth);

    if (input.storedChoice !== undefined) localStorage.setItem(`kinu.inspector.open.${input.account}.${ws}`, input.storedChoice);
  }

  const controls: Controls = {
    flush() {
      for (const effect of layoutEffects.splice(0)) {
        if (effect.generation !== gen) { layoutEffects.push(effect); continue; }

        const state = slots[effect.ordinal] ??= { deps: undefined, cancel: undefined };

        if (depsEqual(effect.deps, state.deps)) continue;
        state.cancel?.();
        state.cancel = undefined;
        state.deps = effect.deps;
        const cleanup = effect.cb();

        if (cleanup !== undefined) state.cancel = cleanup;
      }
    },
    cancelEffects() {
      for (const state of slots) {
        state.cancel?.();
        state.cancel = undefined;
      }
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
    effectOrdinal = 0;
    const layout = useInspectorLayout({ desktopPanels: true, mobileDefault: '0%', workspace: ws, worthShowing: input.worthShowing ?? false });

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
    // the column falls under the first-visit policy: it settles collapsed
    // and writes nothing back.
    const malformedStub = panelStub(340);

    const malformed = mount({
      account: 'a@b',
      storedWidth: 'not-a-width',
      steps: [(layout, controls) => {
        layout.panelRef.current = malformedStub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(malformed.html).toContain('data-default-size="340px"');
    expect(malformed.html).toContain('data-collapsed="true"');
    expect(malformed.html).toContain('data-ready="true"');
    expect(malformedStub.state.collapsed).toBe(true);
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
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('0');

    // A fresh mount reads the workspace's choice back: the collapse restores
    // through the panel and into the hook's own state.
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

    // The account key is real isolation, not a suffix nobody reads. The other
    // account has nothing stored, so it lands under the first-visit policy:
    // collapsed, with nothing written for it either.
    const otherStub = panelStub(340);

    const other = mount({
      account: 'other@b',
      steps: [(layout, controls) => {
        layout.panelRef.current = otherStub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(other.html).toContain('data-collapsed="true"');
    expect(other.html).toContain('data-default-size="340px"');
    expect(other.html).toContain('data-ready="true"');
    expect(store['kinu.inspector.other@b']).toBeUndefined();
  });

  test('the pixel floor clamps what a stored width reads back as', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '120',
      storedChoice: '1',
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
      storedWidth: '300',
      storedChoice: '1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        controls.frames(3);
        // The loop is still waiting on the first measured pass: rescheduling,
        // not resizing blind into a layout the group's first pass owns.
        expect(stub.resizes).toEqual([]);

        layout.onResize(px(340), 'inspector', undefined);
        // The announcement carries no intent: the stored size is untouched.
        expect(store['kinu.inspector.a@b']).toBe('300');
        controls.frames();
      }],
    });

    // And it vetoed nothing — the pending restore still applied.
    expect(stub.resizes).toEqual([300]);
    expect(store['kinu.inspector.a@b']).toBe('300');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a real report clamps at the floor and reads sub-pixel as collapsed', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      // Stored prefs keep this row out of the first-visit policy: the column
      // restores open at 300 and the scripted reports decide from there.
      storedWidth: '300',
      storedChoice: '1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    const layout = mounted.layout;

    // Each report arrives after the group's own pass settled on that size.
    stub.state.sizePx = 412;
    layout.onResize(px(412), 'inspector', px(340));
    expect(store['kinu.inspector.a@b']).toBe('412');

    stub.state.sizePx = 120;
    layout.onResize(px(120), 'inspector', px(412));
    expect(store['kinu.inspector.a@b']).toBe('280');

    stub.state.sizePx = 0.4;
    stub.state.collapsed = true;
    // The column's own collapse affordance flipped it: the next report keeps
    // the collapsed flag instead of reviving the column at 300px.
    layout.collapseControl?.();
    stub.state.sizePx = 300;
    stub.state.collapsed = true;
    layout.onResize(px(300), 'inspector', px(280));
    expect(store['kinu.inspector.a@b']).toBe('300');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('0');
  });
});

describe('the apply loop, through the page hook', () => {
  test('a stored width applies only once the first measured report has landed', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
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
      storedWidth: '300',
      storedChoice: '1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        controls.frames(2);
        layout.onResize(px(412), 'inspector', px(340));
        controls.frames(5);
      }],
    });

    expect(stub.resizes).toEqual([]);
    expect(store['kinu.inspector.a@b']).toBe('412');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a read-back that misses re-asserts, and the 30-frame bound still settles', () => {
    const stub = panelStub(340);
    // The panel ignores the imperative resize: every read-back misses.
    const deaf: PanelImperativeHandle = { ...stub.handle, resize: () => { stub.resizes.push(-1); } };

    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
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
      storedWidth: '300',
      storedChoice: '1',
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
      storedWidth: '300',
      storedChoice: '0',
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
    const mounted = mount({ account: 'a@b', storedWidth: '300', storedChoice: '1' });

    // The effect ran, found no panel yet, and is parked on one frame.
    mounted.controls.flush();
    expect(mounted.controls.pendingFrames()).toBe(1);
    mounted.controls.cancelEffects();
    expect(mounted.controls.pendingFrames()).toBe(0);
    expect(mounted.controls.frames(10)).toBe(0);
    expect(mounted.html).toContain('data-ready="false"');
  });
});

  test('a panel that never registers still settles — and cancel stops it mid-wait', () => {
    // panelRef stays null the whole run: no element ever hands the loop a
    // handle. The wait for one shares the same 30-frame bound as the measured
    // report wait, so the column reports ready instead of spinning.
    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
      steps: [(_layout, controls) => {
        controls.flush();
        controls.frames(40);
      }],
    });

    expect(mounted.html).toContain('data-ready="true"');

    // Cancellation mid-wait is the other termination: the pending frame goes
    // away and stays away.
    const pending = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
    });

    pending.controls.flush();
    expect(pending.controls.pendingFrames()).toBe(1);
    pending.controls.cancelEffects();
    expect(pending.controls.pendingFrames()).toBe(0);
    expect(pending.controls.frames(10)).toBe(0);
    expect(pending.html).toContain('data-ready="false"');
  });

describe('the first-visit policy, through the page hook', () => {
  test('nothing stored collapses the column — and the collapse writes nothing', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
        // The policy collapse's own report arrives next and is consumed:
        // a size the hook chose is not the user's choice, so nothing stores.
        layout.onResize(px(0), 'inspector', px(340));
        controls.frames();
      }],
    });

    expect(stub.state.collapsed).toBe(true);
    expect(mounted.html).toContain('data-collapsed="true"');
    expect(mounted.html).toContain('data-expand-visible="true"');
    expect(mounted.html).toContain('data-ready="true"');
    expect(store).toEqual({ 'kinu.inspector.account': 'a@b' });
  });

  test('a workspace already holding something worth seeing stays open — and writes nothing', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      worthShowing: true,
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(stub.state.collapsed).toBe(false);
    expect(mounted.html).toContain('data-collapsed="false"');
    expect(mounted.html).toContain('data-ready="true"');
    expect(store).toEqual({ 'kinu.inspector.account': 'a@b' });
  });

  test('a stored collapse is the user\'s: a signal does not reopen it', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '280',
      storedChoice: '0',
      worthShowing: true,
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    expect(stub.state.collapsed).toBe(true);
    expect(mounted.html).toContain('data-collapsed="true"');
    expect(mounted.html).toContain('data-ready="true"');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('0');
  });

  test('a stored width opens the column even with a signal present', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '340',
      storedChoice: '1',
      worthShowing: true,
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
      }],
    });

    // The stored width already holds at mount size, so the loop issues nothing.
    expect(stub.resizes).toEqual([]);
    expect(mounted.html).toContain('data-collapsed="false"');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a gesture that drags the policy-collapsed column open is the user\'s, and persists', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        layout.onResize(px(340), 'inspector', undefined);
        controls.frames();
        layout.onResize(px(0), 'inspector', px(340));
        // The drag open reports a real width: the column is the user's now.
        stub.state.collapsed = false;
        stub.state.sizePx = 320;
        layout.onResize(px(320), 'inspector', px(0));
        controls.frames();
      }],
    });

    expect(store['kinu.inspector.a@b']).toBe('320');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('1');
    expect(mounted.html).toContain('data-collapsed="false"');
  });
 });
