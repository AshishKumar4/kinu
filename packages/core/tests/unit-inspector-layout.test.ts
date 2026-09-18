// The inspector column's layout machine: every decision the hook's effects
// used to make, proved here with no React and no DOM. These are the
// properties the hook-level suite held before it was retired for mocking
// React; the machine is where they live now, so a rendered tree is not
// needed to prove that a constraint adopts, a gesture persists, a parked
// decision applies once, and a control action always lands.
import { describe, expect, test } from 'bun:test';
import {
  INSPECTOR_DEFAULT_PX, INSPECTOR_MIN_PX, applyInspectorDecision, claimInspectorTarget, commitInspectorLayout,
  decideInspector, initialInspectorState, newInspectorGroup, readStoredInspector,
  type InspectorState, type StoredInspectorLayout,
} from '../src/web/inspector-layout';

const WS = 'ws-1';

/** A measured group whose first commit already landed at the stored layout. */
function measured(stored: StoredInspectorLayout): InspectorState {
  const decision = decideInspector(stored, false);

  const first = commitInspectorLayout(initialInspectorState(decision), {
    now: decision, marked: false, workspace: WS, panelPresent: true,
  });

  return first.state;
}

describe('the mount', () => {
  test('a constrained mount adopts the actual layout without persisting it', () => {
    // The group's first pass could not fit the decided width: the report
    // carries the constrained size. It is the mount announcing itself, not
    // a gesture — nothing persists, and the column is ready at what landed.
    const step = commitInspectorLayout(initialInspectorState(decideInspector({ width: 300, choice: true }, false)), {
      now: { collapsed: false, widthPx: INSPECTOR_MIN_PX }, marked: false, workspace: WS, panelPresent: true,
    });

    expect(step.effects).toEqual({});
    expect(step.state).toMatchObject({ widthPx: INSPECTOR_MIN_PX, collapsed: false, ready: true, measured: true });
  });

  test('a panel that never registers still applies its decision — once, and nothing is armed', () => {
    // Decided before the group measured: the write parks. The first commit
    // applies it exactly once and the slot is empty after — no loop.
    const decided = applyInspectorDecision(initialInspectorState(null), {
      workspace: WS, stored: { width: 300, choice: true }, worthShowing: false, panelPresent: false,
    });

    expect(decided.effects).toEqual({});
    expect(decided.state.pending).toEqual({ collapsed: false, widthPx: 300 });

    const first = commitInspectorLayout(decided.state, {
      now: { collapsed: true, widthPx: INSPECTOR_DEFAULT_PX }, marked: false, workspace: WS, panelPresent: true,
    });

    expect(first.effects).toEqual({ write: { collapsed: false, widthPx: 300 } });
    expect(first.state).toMatchObject({ pending: null, collapsed: false, widthPx: 300, ready: true });

    const second = commitInspectorLayout(first.state, {
      now: { collapsed: false, widthPx: 300 }, marked: false, workspace: WS, panelPresent: true,
    });

    expect(second.effects).toEqual({});
  });

  test('a stored collapse restores through the mount layout and reflects into state', () => {
    const decision = decideInspector({ width: 300, choice: false }, true);

    expect(decision).toEqual({ collapsed: true, widthPx: 300 });
    const state = initialInspectorState(decision);
    expect(state.collapsed).toBe(true);

    // The group's first pass committed the collapsed default layout: the
    // remembered expansion width survives a collapsed report.
    const first = commitInspectorLayout(state, {
      now: { collapsed: true, widthPx: 300 }, marked: false, workspace: WS, panelPresent: true,
    });

    expect(first.state).toMatchObject({ collapsed: true, widthPx: 300, ready: true });
    expect(first.effects).toEqual({});
  });

  test('a no-op decision writes nothing and leaves the next control action free', () => {
    const state = measured({ width: 300, choice: true });

    const step = applyInspectorDecision(state, {
      workspace: WS, stored: { width: 300, choice: true }, worthShowing: false, panelPresent: true,
    });

    expect(step.effects).toEqual({});
    expect(step.state.ready).toBe(true);

    const toggled = claimInspectorTarget(step.state, { collapsed: true, widthPx: 300 }, WS);
    expect(toggled.effects).toEqual({ persist: { collapsed: true, widthPx: 300 }, write: { collapsed: true, widthPx: 300 } });
    expect(toggled.state.userDecided).toBe(WS);
  });

  test('an unmarked report after the mount adopts without overwriting the stored layout', () => {
    const state = measured({ width: 300, choice: true });

    const step = commitInspectorLayout(state, {
      now: { collapsed: false, widthPx: 310 }, marked: false, workspace: WS, panelPresent: true,
    });

    expect(step.effects).toEqual({});
    expect(step.state.widthPx).toBe(310);
    expect(step.state.userDecided).toBeNull();
  });
});

describe('control actions and gestures', () => {
  test('a constrained write echo keeps the preferred width and the next control action still lands', () => {
    const state = measured({ width: 300, choice: true });

    // The reset claims 340 at call time; the group fits only 310, and its
    // report — no input mark — adopts without touching the stored intent.
    const reset = claimInspectorTarget(state, { collapsed: false, widthPx: INSPECTOR_DEFAULT_PX }, WS);
    expect(reset.effects.persist).toEqual({ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX });
    expect(reset.effects.write).toEqual({ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX });

    const echo = commitInspectorLayout(reset.state, {
      now: { collapsed: false, widthPx: 310 }, marked: false, workspace: WS, panelPresent: true,
    });

    expect(echo.effects).toEqual({});
    expect(echo.state.widthPx).toBe(310);

    // A later control action is still the user's own act.
    const toggle = claimInspectorTarget(echo.state, { collapsed: true, widthPx: 310 }, WS);
    expect(toggle.effects.persist).toEqual({ collapsed: true, widthPx: 310 });
  });

  test('a collapse affordance issued while a reset is in flight still claims its target', () => {
    const state = measured({ width: 300, choice: true });
    const reset = claimInspectorTarget(state, { collapsed: false, widthPx: INSPECTOR_DEFAULT_PX }, WS);
    // Before the reset's commit reports, the user collapses.
    const collapse = claimInspectorTarget(reset.state, { collapsed: true, widthPx: INSPECTOR_DEFAULT_PX }, WS);

    expect(collapse.effects).toEqual({
      persist: { collapsed: true, widthPx: INSPECTOR_DEFAULT_PX }, write: { collapsed: true, widthPx: INSPECTOR_DEFAULT_PX },
    });
    expect(collapse.state).toMatchObject({ collapsed: true, userDecided: WS });

    // The two echoes that follow are unmarked and adopt; neither persists.
    let current = collapse.state;

    for (const now of [{ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX }, { collapsed: true, widthPx: INSPECTOR_DEFAULT_PX }]) {
      const step = commitInspectorLayout(current, { now, marked: false, workspace: WS, panelPresent: true });
      expect(step.effects).toEqual({});
      current = step.state;
    }

    expect(current.collapsed).toBe(true);
  });

  test('a marked commit is the user\'s: it persists, and kills a parked decision', () => {
    const parked: InspectorState = { ...measured({ width: 300, choice: true }), pending: { collapsed: true, widthPx: 300 } };

    const step = commitInspectorLayout(parked, {
      now: { collapsed: false, widthPx: 420 }, marked: true, workspace: WS, panelPresent: true,
    });

    expect(step.effects).toEqual({ persist: { collapsed: false, widthPx: 420 } });
    expect(step.state).toMatchObject({ pending: null, widthPx: 420, userDecided: WS, ready: true });
  });

  test('a gesture latches the workspace: no later decision crosses it there, and another workspace is its own', () => {
    const gestured = commitInspectorLayout(measured({ width: 300, choice: true }), {
      now: { collapsed: false, widthPx: 420 }, marked: true, workspace: WS, panelPresent: true,
    }).state;

    const same = applyInspectorDecision(gestured, {
      workspace: WS, stored: { width: 300, choice: false }, worthShowing: true, panelPresent: true,
    });

    expect(same.effects).toEqual({});
    expect(same.state).toBe(gestured);

    const other = applyInspectorDecision(gestured, {
      workspace: 'ws-2', stored: { width: 300, choice: false }, worthShowing: true, panelPresent: true,
    });

    expect(other.effects).toEqual({ write: { collapsed: true, widthPx: 300 } });
  });
});

describe('the first-visit policy', () => {
  test('a workspace with outputs but no decision waiting stays closed until something is worth seeing', () => {
    expect(decideInspector({ width: null, choice: null }, false)).toEqual({ collapsed: true, widthPx: INSPECTOR_DEFAULT_PX });
    expect(decideInspector({ width: null, choice: null }, true)).toEqual({ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX });
  });

  test('the signal opens once per workspace and a second decision keeps it open without a second write', () => {
    const state = measured({ width: 300, choice: true });
    const closed: InspectorState = { ...state, collapsed: true };

    const opened = applyInspectorDecision(closed, {
      workspace: WS, stored: { width: 300, choice: null }, worthShowing: true, panelPresent: true,
    });

    expect(opened.effects).toEqual({ write: { collapsed: false, widthPx: 300 } });
    expect(opened.state.autoOpened).toBe(WS);

    // The signal is gone; the latch keeps the column open, nothing writes.
    const again = applyInspectorDecision(opened.state, {
      workspace: WS, stored: { width: 300, choice: null }, worthShowing: false, panelPresent: true,
    });

    expect(again.effects).toEqual({});
    expect(again.state.collapsed).toBe(false);
  });

  test('a new group element forgets the measurement and the parked decision', () => {
    const parked: InspectorState = { ...measured({ width: 300, choice: true }), pending: { collapsed: true, widthPx: 300 } };
    const fresh = newInspectorGroup(parked);

    expect(fresh).toMatchObject({ measured: false, pending: null });
  });
});

describe('the account that keys the layout', () => {
  // The distinction the hook lost: "no account yet" and "no account" are not
  // one value. A session that will never have one must still be DECIDED —
  // it reads nothing and writes nothing, and the policy answers for it. Read
  // as "nothing keys this layout, so nothing is decided", an anonymous
  // session's column sat behind its expand handle for the page's life however
  // much the workspace had to show.
  test('a resolved session with no account is decided by the policy, and reads nothing', () => {
    // There is no `localStorage` in this environment at all, so a read
    // against one throws here: a layout coming back is proof nothing read.
    for (const account of [{ kind: 'none' }, { kind: 'unreadable' }] as const) {
      expect(readStoredInspector(account, WS)).toEqual({ width: null, choice: null });

      const step = applyInspectorDecision(measured({ width: null, choice: null }), {
        workspace: WS, stored: readStoredInspector(account, WS), worthShowing: true, panelPresent: true,
      });

      expect(step.effects).toEqual({ write: { collapsed: false, widthPx: INSPECTOR_DEFAULT_PX } });
      expect(step.state.ready).toBe(true);
    }
  });

  test('an account not yet resolved decides nothing, and the decision still lands when it arrives', () => {
    const state = measured({ width: null, choice: null });

    expect(readStoredInspector(null, WS)).toBeNull();

    const parked = applyInspectorDecision(state, {
      workspace: WS, stored: readStoredInspector(null, WS), worthShowing: true, panelPresent: true,
    });

    expect(parked.effects).toEqual({});
    expect(parked.state).toEqual(state);

    const landed = applyInspectorDecision(parked.state, {
      workspace: WS, stored: readStoredInspector({ kind: 'none' }, WS), worthShowing: true, panelPresent: true,
    });

    expect(landed.effects).toEqual({ write: { collapsed: false, widthPx: INSPECTOR_DEFAULT_PX } });
  });
});
