/**
 * Inspector column layout machine (no React, no DOM); effects live in `cf-backend/src/hooks/use-inspector-layout.ts`.
 * Commits are classified by input mark, never by comparing layouts: only marked commits persist.
 */

export const INSPECTOR_DEFAULT_PX = 340;

export const INSPECTOR_MIN_PX = 280;

export const INSPECTOR_WIDE_QUERY = "(min-width: 900px)";

export interface InspectorTarget { readonly collapsed: boolean; readonly widthPx: number }

export interface InspectorState {
  readonly collapsed: boolean;
  readonly widthPx: number;
  readonly ready: boolean;
  /** The workspace the user has gestured on: no policy transition crosses it. */
  readonly userDecided: string | null;
  /** The workspace the one automatic open already served. */
  readonly autoOpened: string | null;
  /** A decision made before the group's first commit, applied once by that commit. */
  readonly pending: InspectorTarget | null;
  readonly measured: boolean;
}

/** `write`: imperative panel resize/collapse; `persist`: the user's own layout to store. */
export interface InspectorEffects {
  readonly write?: InspectorTarget;
  readonly persist?: InspectorTarget;
}

export interface InspectorStep { readonly state: InspectorState; readonly effects: InspectorEffects }

export function initialInspectorState(decision: InspectorTarget | null): InspectorState {
  return {
    collapsed: decision?.collapsed ?? false,
    widthPx: decision?.widthPx ?? INSPECTOR_DEFAULT_PX,
    ready: false,
    userDecided: null,
    autoOpened: null,
    pending: null,
    measured: false,
  };
}

/** New group element: previous measurement and parked decision are dropped. */
export function newInspectorGroup(state: InspectorState): InspectorState {
  return { ...state, measured: false, pending: null };
}

/** `choice`: `true` opened here, `false` closed here, null means the first-visit policy decides. */
export interface StoredInspectorLayout { readonly width: number | null; readonly choice: boolean | null }

function readInspectorWidth(account: string): number | null {
  const raw = localStorage.getItem(`kinu.inspector.${account}`);
  const width = raw === null ? NaN : Number(raw);

  return Number.isFinite(width) ? Math.max(INSPECTOR_MIN_PX, Math.round(width)) : null;
}

/** Open/closed choice is per workspace: `"1"` opened, `"0"` closed, absent defers to first-visit policy. */
function readInspectorChoice(account: string, workspace: string | undefined): boolean | null {
  const raw = workspace === undefined
    ? null
    : localStorage.getItem(`kinu.inspector.open.${account}.${workspace}`);

  if (raw === "1") return true;

  if (raw === "0") return false;

  return null;
}

/** Only `known` (profile with email) reads or writes storage; `unreadable` is not collapsed into `none`. */
export type InspectorAccount =
  | { readonly kind: "known"; readonly email: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

export const UNKEYED_INSPECTOR_LAYOUT: StoredInspectorLayout = { width: null, choice: null };

/** Null only while the account is unresolved; an unkeyed session still gets a layout the policy decides. */
export function readStoredInspector(account: InspectorAccount | null, workspace: string | undefined): StoredInspectorLayout | null {
  if (account === null) return null;

  if (account.kind !== "known") return UNKEYED_INSPECTOR_LAYOUT;

  return { width: readInspectorWidth(account.email), choice: readInspectorChoice(account.email, workspace) };
}


/** Stored choice, else collapsed unless the person is needed or the auto-open already served this workspace. */
export function decideInspector(stored: StoredInspectorLayout | null, needsUser: boolean): InspectorTarget {
  const width = stored?.width ?? INSPECTOR_DEFAULT_PX;
  const choice = stored?.choice ?? null;

  return { collapsed: choice === null ? !needsUser : !choice, widthPx: width };
}

/** Decides and applies the layout. A user gesture wins; the signal open is a once-per-workspace latch;
 *  a stored choice ends the policy's say. `stored` null parks the decision. */
export function applyInspectorDecision(state: InspectorState, input: {
  readonly workspace: string | undefined;
  readonly stored: StoredInspectorLayout | null;
  readonly needsUser: boolean;
  readonly panelPresent: boolean;
}): InspectorStep {
  if (input.stored === null || state.userDecided === (input.workspace ?? null)) return { state, effects: {} };

  const target = decideInspector(input.stored, input.needsUser || state.autoOpened === (input.workspace ?? null));
  const autoOpened = input.needsUser && input.stored.choice === null ? input.workspace ?? null : state.autoOpened;

  if (state.collapsed === target.collapsed && (target.collapsed || state.widthPx === target.widthPx)) {
    return { state: { ...state, autoOpened, ready: true }, effects: {} };
  }

  // A write into an unmeasured group is lost against a zero-size box, so the decision parks until the first commit.
  if (!state.measured || !input.panelPresent) {
    return { state: { ...state, autoOpened, pending: target }, effects: {} };
  }

  return {
    state: { ...state, autoOpened, collapsed: target.collapsed, widthPx: target.widthPx, ready: true },
    effects: { write: target },
  };
}

/** Control action (collapse/expand/reset): claims its target as the user's and writes the panel unmarked. */
export function claimInspectorTarget(state: InspectorState, target: InspectorTarget, workspace: string | undefined): InspectorStep {
  return {
    state: { ...state, userDecided: workspace ?? null, collapsed: target.collapsed, widthPx: target.widthPx },
    effects: { persist: target, write: target },
  };
}

/** A committed layout, reported once. A collapsed `now` carries the remembered expansion width, never zero.
 *  The first commit applies a parked decision, unmarked. */
export function commitInspectorLayout(state: InspectorState, input: {
  readonly now: InspectorTarget;
  readonly marked: boolean;
  readonly workspace: string | undefined;
  readonly panelPresent: boolean;
}): InspectorStep {
  const { now } = input;

  if (!state.measured) {
    const adopted: InspectorState = {
      ...state, measured: true, ready: true, collapsed: now.collapsed,
      widthPx: now.collapsed ? state.widthPx : now.widthPx,
    };

    const pending = state.pending;

    if (pending === null) return { state: adopted, effects: {} };

    return {
      state: { ...adopted, pending: null, collapsed: pending.collapsed, widthPx: pending.widthPx },
      effects: input.panelPresent ? { write: pending } : {},
    };
  }

  if (input.marked) {
    return {
      state: { ...state, pending: null, ready: true, userDecided: input.workspace ?? null, collapsed: now.collapsed, widthPx: now.widthPx },
      effects: { persist: now },
    };
  }

  // Environment or own commit: adopt, persist nothing.
  return {
    state: { ...state, collapsed: now.collapsed, widthPx: now.collapsed ? state.widthPx : now.widthPx },
    effects: {},
  };
}

/** Keys the library's separator keydown acts on; their marks drive commit classification. */
const INSPECTOR_INPUT_KEYS = {
  ArrowLeft: true, ArrowRight: true, Home: true, End: true, Enter: true,
} satisfies Record<string, true>;

export function isInspectorInputKey(key: string): boolean {
  return Object.hasOwn(INSPECTOR_INPUT_KEYS, key);
}
