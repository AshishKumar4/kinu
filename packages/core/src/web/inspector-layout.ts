/**
 * The inspector column's layout, as a machine with no React and no DOM.
 *
 * The column has a per-account persisted WIDTH and a per-workspace persisted
 * open/closed CHOICE, and every committed layout is classified by INPUT, not
 * by layout matching: a commit carrying an input mark is the user's and
 * persists; any other commit — the mount, a decision the machine issued, a
 * constraint the group imposed — is adopted into state and persists
 * nothing. Control actions (collapse, expand, reset) claim their target at
 * call time. Nothing ever compares a committed layout to a remembered one,
 * so a write that changes nothing and a constraint that changes everything
 * both classify correctly.
 *
 * The hook (`cf-backend/src/hooks/use-inspector-layout.ts`) owns the
 * effects: it reads storage into a decided target, measures a commit's
 * pixels off the DOM, and turns each step's effects into an imperative
 * panel write and a storage write. Everything the effects DECIDE is here,
 * so the decisions are proved without a rendered tree.
 */

export const INSPECTOR_DEFAULT_PX = 340;

export const INSPECTOR_MIN_PX = 280;

export const INSPECTOR_WIDE_QUERY = "(min-width: 900px)";

export interface InspectorTarget { readonly collapsed: boolean; readonly widthPx: number }

/** What the machine remembers between steps. */
export interface InspectorState {
  readonly collapsed: boolean;
  readonly widthPx: number;
  /** The column's layout is decided and applied (or already stood). */
  readonly ready: boolean;
  /** The workspace the user has gestured on: no policy transition crosses it. */
  readonly userDecided: string | null;
  /** The workspace the one automatic open already served. */
  readonly autoOpened: string | null;
  /** A decision made before the group's first committed pass, applied once
   *  by that pass. Not a loop: the group's own commit is the schedule. */
  readonly pending: InspectorTarget | null;
  /** The group has committed a layout at least once, so writes land. */
  readonly measured: boolean;
}

/** What a step asks the host to do: `write` is an imperative panel resize or
 *  collapse; `persist` is the user's own layout, to store as theirs. */
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

/** A new group element: the previous tree's measurement and parked decision
 *  die with it, before the new tree's first announcement. */
export function newInspectorGroup(state: InspectorState): InspectorState {
  return { ...state, measured: false, pending: null };
}

/** The stored layout the policy reads for a workspace: the account's width
 *  (null when none is stored) and the workspace's choice (`true` opened
 *  here, `false` closed here, null means the first-visit policy decides). */
export interface StoredInspectorLayout { readonly width: number | null; readonly choice: boolean | null }

/** The WIDTH is the account's: a preference about this person's display,
 *  stored as a plain pixel number beside the theme choice. */
function readInspectorWidth(account: string): number | null {
  const raw = localStorage.getItem(`kinu.inspector.${account}`);
  const width = raw === null ? NaN : Number(raw);

  return Number.isFinite(width) ? Math.max(INSPECTOR_MIN_PX, Math.round(width)) : null;
}

/** The OPEN/CLOSED choice is the workspace's: `"1"` opened here, `"0"` closed
 *  here, absent means the first-visit policy decides. A choice made in one
 *  workspace can never leak into another. */
function readInspectorChoice(account: string, workspace: string | undefined): boolean | null {
  const raw = workspace === undefined
    ? null
    : localStorage.getItem(`kinu.inspector.open.${account}.${workspace}`);

  if (raw === "1") return true;

  if (raw === "0") return false;

  return null;
}

/** Who keys a persisted layout, or why nobody does: a signed-in profile with
 *  an email is `known`; a session with no account — anonymous, or a profile
 *  carrying no email — is `none`; a profile the page could not read is
 *  `unreadable`. Only `known` reads or writes storage, and the failure is
 *  classified rather than swallowed into "not yet". */
export type InspectorAccount =
  | { readonly kind: "known"; readonly email: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

/** What a layout nobody keys reads as: no remembered width, no choice — so
 *  the first-visit policy answers for it, every mount. */
export const UNKEYED_INSPECTOR_LAYOUT: StoredInspectorLayout = { width: null, choice: null };

/** What storage holds for this account and workspace. A session that keys
 *  nothing reads nothing and gets the unkeyed layout, so the policy still
 *  decides for it; null means only "the account has not resolved yet", which
 *  parks the decision until it does. Collapsing those two is what left an
 *  anonymous session's column shut for the page's life. */
export function readStoredInspector(account: InspectorAccount | null, workspace: string | undefined): StoredInspectorLayout | null {
  if (account === null) return null;

  if (account.kind !== "known") return UNKEYED_INSPECTOR_LAYOUT;

  return { width: readInspectorWidth(account.email), choice: readInspectorChoice(account.email, workspace) };
}


/** The decided layout: the stored choice when one exists, else the
 *  first-visit policy — collapsed unless the workspace holds something worth
 *  seeing (the live signal, or the one auto-open it already served). */
export function decideInspector(stored: StoredInspectorLayout | null, showContent: boolean): InspectorTarget {
  const width = stored?.width ?? INSPECTOR_DEFAULT_PX;
  const choice = stored?.choice ?? null;

  return { collapsed: choice === null ? !showContent : !choice, widthPx: width };
}

/**
 * The workspace's layout, decided and applied in one place: on mount, on a
 * workspace switch, when the account key lands, and on the signal that opens
 * a policy-closed column once on the workspace's behalf. A gesture the user
 * already made wins outright. The signal open is a once-per-workspace latch;
 * a stored choice ends the policy's say entirely.
 *
 * `stored` is null when the account that keys the layout has not resolved yet
 * (or the layout is not a wide-desktop one) — then nothing is decided at all,
 * and the decision arrives with the account. A session resolved to NO account
 * is decided like any other; it just persists nothing.
 */
export function applyInspectorDecision(state: InspectorState, input: {
  readonly workspace: string | undefined;
  readonly stored: StoredInspectorLayout | null;
  readonly worthShowing: boolean;
  /** The imperative panel handle exists: a write can land. */
  readonly panelPresent: boolean;
}): InspectorStep {
  if (input.stored === null || state.userDecided === (input.workspace ?? null)) return { state, effects: {} };

  const target = decideInspector(input.stored, input.worthShowing || state.autoOpened === (input.workspace ?? null));
  const autoOpened = input.worthShowing && input.stored.choice === null ? input.workspace ?? null : state.autoOpened;

  // Already where the decision lands: nothing writes, and the column is
  // still marked ready — the stored state stands.
  if (state.collapsed === target.collapsed && (target.collapsed || state.widthPx === target.widthPx)) {
    return { state: { ...state, autoOpened, ready: true }, effects: {} };
  }

  // A write issued into an unmeasured group is recomputed against a
  // zero-size box and lost, so the decision parks until the first commit.
  if (!state.measured || !input.panelPresent) {
    return { state: { ...state, autoOpened, pending: target }, effects: {} };
  }

  return {
    state: { ...state, autoOpened, collapsed: target.collapsed, widthPx: target.widthPx, ready: true },
    effects: { write: target },
  };
}

/** A control action — collapse, expand, reset — claims its target: the
 *  layout is the user's, reflected, persisted, latched for this workspace,
 *  and written to the panel unmarked. Whatever commit that write produces
 *  (or none, for a no-op) lands in the adopt branch like any other unmarked
 *  commit. */
export function claimInspectorTarget(state: InspectorState, target: InspectorTarget, workspace: string | undefined): InspectorStep {
  return {
    state: { ...state, userDecided: workspace ?? null, collapsed: target.collapsed, widthPx: target.widthPx },
    effects: { persist: target, write: target },
  };
}

/**
 * A committed layout, reported exactly once. `now` is what the group
 * committed (a collapsed report carries the remembered expansion width, never
 * zero); `marked` is whether an input was observed at its source for this
 * commit. The first commit measures the group and applies a parked decision
 * once — the single write the unmeasured group could not take, and the
 * machine's own, so it marks nothing.
 */
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
    // A gesture: the column is the user's — anything still parked dies with it.
    return {
      state: { ...state, pending: null, ready: true, userDecided: input.workspace ?? null, collapsed: now.collapsed, widthPx: now.widthPx },
      effects: { persist: now },
    };
  }

  // Environment or our own commit: adopt what landed, persist nothing.
  return {
    state: { ...state, collapsed: now.collapsed, widthPx: now.collapsed ? state.widthPx : now.widthPx },
    effects: {},
  };
}

/** The keys the library's separator keydown acts on — the marks these press
 *  leave are what the committed layout's classification reads. */
const INSPECTOR_INPUT_KEYS = {
  ArrowLeft: true, ArrowRight: true, Home: true, End: true, Enter: true,
} satisfies Record<string, true>;

export function isInspectorInputKey(key: string): boolean {
  return Object.hasOwn(INSPECTOR_INPUT_KEYS, key);
}
