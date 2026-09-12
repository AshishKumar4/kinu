/**
 * The inspector layout policy without the React shell: stored prefs round-trip
 * through the account key, a mount report persists nothing, and the apply
 * loop's 30-frame bound holds in both phases. The seams are pure — the hook's
 * wiring is what the browser rows in scripts/chat-and-files-ux.test.ts cover.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  INSPECTOR_DEFAULT_PX, INSPECTOR_MIN_PX,
  readInspectorPrefs, writeInspectorPrefs, resizePrefsOf, restoreInspectorLayout,
  type InspectorRestoreCtx,
} from '../src/hooks/use-inspector-layout';
import type { PanelImperativeHandle } from 'react-resizable-panels';

let store: Record<string, string> = {};

if (!('localStorage' in globalThis)) {
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
  });
}

const px = (inPixels: number) => ({ asPercentage: 0, inPixels });

beforeEach(() => { store = {}; });

describe('inspector prefs', () => {
  test('an account with nothing stored reads as absent, never a default', () => {
    expect(readInspectorPrefs('nobody@kinu.run')).toBeNull();
    expect(readInspectorPrefs(null)).toBeNull();
    store['kinu.inspector.a@b'] = 'not-a-width';
    expect(readInspectorPrefs('a@b')).toBeNull();
  });

  test('a write reads back: width and collapsed survive the string form', () => {
    writeInspectorPrefs('a@b', { widthPx: 412, collapsed: true });
    expect(readInspectorPrefs('a@b')).toEqual({ widthPx: 412, collapsed: true });

    writeInspectorPrefs('a@b', { widthPx: 300, collapsed: false });
    expect(readInspectorPrefs('a@b')).toEqual({ widthPx: 300, collapsed: false });
    // The account key is real isolation, not a suffix nobody reads.
    expect(readInspectorPrefs('other@b')).toBeNull();
  });

  test('the pixel floor clamps what a stored width reads back as', () => {
    store['kinu.inspector.a@b'] = '120:0';
    expect(readInspectorPrefs('a@b')?.widthPx).toBe(INSPECTOR_MIN_PX);
  });

  test('the default opening stays inside the design band above the floor', () => {
    expect(INSPECTOR_DEFAULT_PX).toBeGreaterThan(INSPECTOR_MIN_PX);
  });
});

describe('the resize decision', () => {
  test('the mount report is the default layout announcing itself: it persists nothing', () => {
    expect(resizePrefsOf(px(340), undefined, false)).toBeNull();
  });

  test('a real report clamps at the floor and reads sub-pixel as collapsed', () => {
    expect(resizePrefsOf(px(412), px(340), false)).toEqual({ widthPx: 412, collapsed: false });
    expect(resizePrefsOf(px(120), px(340), false)).toEqual({ widthPx: INSPECTOR_MIN_PX, collapsed: false });
    expect(resizePrefsOf(px(0.4), px(340), false)).toEqual({ widthPx: INSPECTOR_MIN_PX, collapsed: true });
    expect(resizePrefsOf(px(300), px(340), true)).toEqual({ widthPx: 300, collapsed: true });
  });
});

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

/** The apply loop over a manual frame queue: `drain` plays back every frame
 *  the loop scheduled, in order, so the test sees exactly the steps a rAF
 *  stream would have run. */
function restoreCtx(panel: PanelImperativeHandle | null) {
  const queue: Array<() => void> = [];
  const touched = { current: false };
  const measured = { current: false };
  let settled = false;
  let collapsed = false;

  const ctx: InspectorRestoreCtx = {
    touched,
    measured,
    panel: { current: panel },
    schedule: (step) => {
      queue.push(step);

      return () => { queue.splice(queue.indexOf(step), 1); };
    },
    applyCollapsed: () => { collapsed = true; },
    markSettled: () => { settled = true; },
  };

  const drain = () => {
    for (;;) {
      const step = queue.shift();

      if (step === undefined) return;

      step();
    }
  };

  return {
    ctx, queue, touched, measured, drain,
    isSettled: () => settled,
    isCollapsed: () => collapsed,
  };
}

describe('restoreInspectorLayout', () => {
  test('a stored width applies only once the first measured report has landed', () => {
    const { handle, resizes } = panelStub(340);
    const rig = restoreCtx(handle);

    restoreInspectorLayout({ widthPx: 300, collapsed: false }, rig.ctx);
    // The mount report has not arrived: the loop reschedules rather than
    // issuing a resize the group's own first pass would overwrite.
    expect(resizes).toEqual([]);
    expect(rig.queue).toHaveLength(1);

    rig.measured.current = true;
    rig.drain();
    expect(resizes).toEqual([300]);
    expect(rig.isSettled()).toBe(true);
  });

  test('a live drag wins mid-loop: touched ends the restore without applying', () => {
    const { handle, resizes } = panelStub(340);
    const rig = restoreCtx(handle);

    restoreInspectorLayout({ widthPx: 300, collapsed: false }, rig.ctx);
    rig.touched.current = true;
    rig.drain();
    expect(resizes).toEqual([]);
    expect(rig.isSettled()).toBe(true);
  });

  test('a read-back that misses re-asserts, and the 30-frame bound still settles', () => {
    const { handle, resizes } = panelStub(340);
    // The panel ignores the imperative resize: every read-back misses.
    const deaf: PanelImperativeHandle = { ...handle, resize: () => { resizes.push(-1); } };
    const rig = restoreCtx(deaf);
    rig.measured.current = true;

    restoreInspectorLayout({ widthPx: 300, collapsed: false }, rig.ctx);
    rig.drain();
    expect(rig.isSettled()).toBe(true);
    expect(resizes.length).toBeLessThanOrEqual(30);
  });

  test('a panel that never reports still settles inside the same bound', () => {
    const { handle, resizes } = panelStub(340);
    const rig = restoreCtx(handle);

    restoreInspectorLayout({ widthPx: 300, collapsed: false }, rig.ctx);
    rig.drain();
    // Thirty frames spent waiting, then the bound lets one apply through and
    // settles rather than spin forever on a panel that reports nothing.
    expect(rig.isSettled()).toBe(true);
    expect(resizes).toEqual([300]);
  });

  test('a stored collapse restores through the panel and reflects into state', () => {
    const { handle, state } = panelStub(340);
    const rig = restoreCtx(handle);
    rig.measured.current = true;

    restoreInspectorLayout({ widthPx: 300, collapsed: true }, rig.ctx);
    expect(rig.isCollapsed()).toBe(true);
    expect(state.collapsed).toBe(true);
    expect(rig.isSettled()).toBe(true);
  });

  test('cancellation stops the pending frame', () => {
    const rig = restoreCtx(null);
    const cancel = restoreInspectorLayout({ widthPx: 300, collapsed: false }, rig.ctx);
    expect(rig.queue).toHaveLength(1);
    cancel();
    rig.drain();
    expect(rig.isSettled()).toBe(false);
  });
});
