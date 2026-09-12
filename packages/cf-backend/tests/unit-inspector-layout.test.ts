/**
 * The inspector layout policy, exercised through the hook the page mounts:
 * stored prefs round-trip through the account and workspace keys, the group's
 * committed-layout emission is what persists a gesture, and a decided layout
 * parked behind the first measured pass applies when it lands — never twice,
 * never on its own.
 *
 * React's static renderer runs the hook for real — `useState`,
 * `useCallback`, every ref — and skips effects. The decision lives inside a
 * layout effect, so `useLayoutEffect` is collected and the harness flushes
 * it, then reports a committed layout through `onLayoutChanged` exactly the
 * way the group's own emission arrives. The browser rows in
 * scripts/chat-and-files-ux.test.ts cover the pixels.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realReact from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useInspectorLayout, type InspectorLayout } from '../src/hooks/use-inspector-layout';
import type { Layout, PanelImperativeHandle } from 'react-resizable-panels';

let store: Record<string, string> = {};

/* `window` and `localStorage` arrive as REAL globals: another cf-backend unit
 * file installs a read-only `localStorage`, so a bare assignment would throw
 * whenever this file runs after it. Define them configurable per test and
 * hand the previous descriptor back afterward. */

let previousLocalStorage: PropertyDescriptor | undefined;

let previousWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  store = {};
  layoutEffects.length = 0;
  previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
  });
  // A wide display: the media query the hook reads answers "desktop".
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) },
  });
});

afterEach(() => {
  if (previousLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage');
  } else {
    Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
  }

  if (previousWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
  } else {
    Object.defineProperty(globalThis, 'window', previousWindow);
  }
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

const depsEqual = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

interface PanelStub {
  readonly handle: PanelImperativeHandle;
  /** Every imperative resize the hook issued. */
  readonly resizes: number[];
  /** Every imperative collapse the hook issued. */
  collapses: number;
  /** What `isCollapsed`/`getSize` read back — set it to the layout the group
   *  committed before reporting it through `onLayoutChanged`. */
  readonly state: { collapsed: boolean; sizePx: number };
}


function panelStub(sizePx: number): PanelStub {
  const state = { collapsed: false, sizePx };
  const resizes: number[] = [];

  const stub: PanelStub = {
    resizes,
    collapses: 0,
    state,
    handle: {
      collapse: () => { state.collapsed = true; stub.collapses += 1; },
      expand: () => { state.collapsed = false; },
      getSize: () => ({ asPercentage: 0, inPixels: state.collapsed ? 0 : state.sizePx }),
      isCollapsed: () => state.collapsed,
      resize: (size: number | string) => { resizes.push(Number(size)); state.sizePx = Number(size); state.collapsed = false; },
    },
  };

  return stub;
}

/* A committed layout report, as the group's `onLayoutChanged` emits one: the
 * stub's state is already the committed size, and the flex map carries the
 * same answer for the panel that is absent. */
function emit(layout: InspectorLayout, stub: PanelStub, inPixels: number): void {
  stub.state.collapsed = inPixels < 1;
  stub.state.sizePx = Math.max(0, inPixels);
  const map: Layout = { chat: 1, inspector: inPixels < 1 ? 0 : 1 };
  layout.onLayoutChanged(map);
}

interface Pass {
  readonly attrs: string;
  readonly layout: InspectorLayout;
}

interface Controls {
  /** Runs this mount's collected layout effects, once per deps change. */
  flush(): void;
  /** The effects' own cancellation, as an unmount would run it. */
  cancelEffects(): void;
}

interface Mounted {
  readonly html: string;
  readonly passes: readonly Pass[];
  readonly layout: InspectorLayout;
  readonly controls: Controls;
}

/** The inspector column as the page's hook hands it over. `account` seeds the
 *  account key the way a returning session's profile write did; `storedWidth`
 *  and `storedChoice` seed the split persisted keys. Steps run inside the
 *  render pass — a same-component state update re-renders immediately, so
 *  emissions reported there see the same ordering a commit stream would.
 *  The hook's return rides the column element as data-* attributes. */
function mount(input: {
  account: string | null;
  /** The workspace the column belongs to — what the per-workspace open/close
   *  choice keys on. Defaults to `ws-1` so a row that never names one still
   *   exercises the workspace-scoped key. */
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
  // deps change.
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
  layoutEffects.length = 0;
});

describe('the persisted layout, through the page hook', () => {
  test('an account with nothing stored reads as absent, never a default', () => {
    // No account key at all: the decision effect never gets an account to
    // read for, so nothing persists — while the policy default still stands
    // the column up collapsed.

    const anonymousStub = panelStub(340);

    const anonymous = mount({
      account: null,
      steps: [(layout, controls) => {
        layout.panelRef.current = anonymousStub.handle;
        controls.flush();
        emit(layout, anonymousStub, 0);
      }],
    });

    expect(anonymous.html).toContain('data-default-size="340px"');
    expect(anonymous.html).toContain('data-collapsed="true"');
    // The policy decision landed; nothing persists because there is no
    // account key to write under.
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
        emit(layout, malformedStub, 0);
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
    // Seeded open so the column's own affordance is on screen: the collapse
    // control is the user's own close — the write under test.
    const first = mount({ account: 'a@b', storedChoice: '1' });
    const stub = panelStub(340);

    first.layout.panelRef.current = stub.handle;
    stub.state.collapsed = false;
    stub.state.sizePx = 340;
    first.layout.collapseControl?.();
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('0');
    expect(store['kinu.inspector.a@b']).toBe('340');

    // A fresh mount reads the workspace's choice back: the group lays it out
    // collapsed and the hook's own state agrees.
    const second = mount({
      account: 'a@b',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        emit(layout, stub, 0);
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
        emit(layout, otherStub, 0);
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
        emit(layout, stub, 280);
      }],
    });

    expect(mounted.html).toContain('data-width="280"');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('the default opening stays inside the design band above the floor', () => {
    const mounted = mount({ account: 'a@b' });

    expect(mounted.html).toContain('data-min-size="280px"');
    expect(mounted.html).toContain('data-default-size="340px"');
  });
});

describe('the committed-layout report, through the page hook', () => {
  test('the mount emission is the group announcing the decided layout: it persists nothing', () => {
    const stub = panelStub(300);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        // The group's first committed pass lands at the decided layout. The
        // announcement carries no intent: the stored size is untouched.
        emit(layout, stub, 300);
        expect(store['kinu.inspector.a@b']).toBe('300');
      }],
    });

    expect(stub.resizes).toEqual([]);
    expect(store['kinu.inspector.a@b']).toBe('300');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a real report clamps at the floor and a collapse keeps the resting width', () => {
    const stub = panelStub(300);

    const mounted = mount({
      account: 'a@b',
      // Stored prefs keep this row out of the first-visit policy: the column
      // restores open at 300 and the scripted reports decide from there.
      storedWidth: '300',
      storedChoice: '1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        emit(layout, stub, 300);
      }],
    });

    const layout = mounted.layout;

    // Each report arrives after the group's own pass settled on that size.
    emit(layout, stub, 412);
    expect(store['kinu.inspector.a@b']).toBe('412');

    emit(layout, stub, 120);
    expect(store['kinu.inspector.a@b']).toBe('280');

    // The column's own collapse affordance captures the live width, then the
    // collapsed report keeps it — the resting width survives the collapse
    // instead of reading back the collapsed pass's own size.
    stub.state.sizePx = 300;
    layout.collapseControl?.();
    expect(store['kinu.inspector.a@b']).toBe('300');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('0');
    emit(layout, stub, 0);
    expect(store['kinu.inspector.a@b']).toBe('300');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('0');
  });
});

describe('the decided layout, through the page hook', () => {
  test('the decided layout is the mount layout: nothing issues blind, ready waits on the pass', () => {
    const stub = panelStub(300);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        // Before the group's first committed pass the hook issues no write
        // and the column is not yet ready — the mount layout IS the decided
        // layout, carried by the group's own defaultLayout/defaultSize.
        expect(stub.resizes).toEqual([]);
        expect(stub.collapses).toBe(0);
        expect(layout.ready).toBe(false);

        // The group's first emission lands the decision and marks it ready.
        emit(layout, stub, 300);
      }],
    });

    expect(stub.resizes).toEqual([]);
    expect(stub.collapses).toBe(0);
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a live gesture wins over a parked decision: the stored layout never applies', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        // The user's drag commits before the decided layout gets its pass:
        // the gesture is the workspace's choice and the parked decision dies.
        emit(layout, stub, 412);
        emit(layout, stub, 412);
      }],
    });

    expect(stub.resizes).toEqual([]);
    expect(store['kinu.inspector.a@b']).toBe('412');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('1');
    expect(mounted.html).toContain('data-ready="true"');
  });

  test('a no-op decision leaves no marker: the next gesture still persists', () => {
    // The group dedupes a write whose layout already stands, so a decision
    // that changes nothing must not park a pending write the next user
    // gesture gets mistaken for.
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      storedChoice: '0',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        // The committed layout already IS the decided collapse: the parked
        // decision drains as a hold, issues nothing, and leaves no marker.
        emit(layout, stub, 0);
      }],
    });

    expect(stub.resizes).toEqual([]);
    expect(stub.collapses).toBe(0);

    // A gesture arriving next is the user's, not an echo: it persists.
    const layout = mounted.layout;
    emit(layout, stub, 320);
    expect(store['kinu.inspector.a@b']).toBe('320');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('1');
  });

  test('a panel that never registers still applies its decision — no loop, nothing armed', () => {
    // panelRef stays null: the mount layout carries the decision, so the
    // effect's read-back simply finds nothing to write to — the decision is
    // applied, marked ready, and nothing is scheduled.
    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
      steps: [(_layout, controls) => {
        controls.flush();
        controls.flush();
      }],
    });

    expect(mounted.html).toContain('data-ready="true"');
    expect(mounted.html).toContain('data-collapsed="false"');

    // Cancellation is the other termination: cleanup runs, nothing is armed.
    const pending = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '1',
    });

    pending.controls.flush();
    pending.controls.cancelEffects();
    // The rendered markup predates the effect run: ready was still false.
    expect(pending.html).toContain('data-ready="false"');
  });

  test('a stored collapse restores through the mount layout and reflects into state', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      storedWidth: '300',
      storedChoice: '0',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        emit(layout, stub, 0);
      }],
    });

    expect(mounted.html).toContain('data-collapsed="true"');
    expect(mounted.html).toContain('data-expand-visible="true"');
    expect(mounted.html).toContain('data-collapse-control=""');
    expect(stub.state.collapsed).toBe(true);
    expect(mounted.html).toContain('data-ready="true"');
  });
});

describe('the first-visit policy, through the page hook', () => {
  test('nothing stored collapses the column — and the collapse writes nothing', () => {
    const stub = panelStub(340);

    const mounted = mount({
      account: 'a@b',
      steps: [(layout, controls) => {
        layout.panelRef.current = stub.handle;
        controls.flush();
        // The group's first pass commits the policy collapse; the emission
        // matches what the hook decided, so nothing stores.
        emit(layout, stub, 0);
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
        emit(layout, stub, 340);
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
        emit(layout, stub, 0);
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
        emit(layout, stub, 340);
      }],
    });

    // The stored width already holds at mount size: nothing is issued.
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
        // The policy collapse commits, then the drag open reports a real
        // width: the column is the user's now.
        emit(layout, stub, 0);
        emit(layout, stub, 320);
      }],
    });

    expect(store['kinu.inspector.a@b']).toBe('320');
    expect(store['kinu.inspector.open.a@b.ws-1']).toBe('1');
    expect(mounted.html).toContain('data-collapsed="false"');
  });
});
