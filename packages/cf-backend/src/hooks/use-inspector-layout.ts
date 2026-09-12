/**
 * The inspector column's layout policy: a per-account persisted WIDTH and a
 * per-WORKSPACE persisted open/close choice, applied over the panel library's
 * own layout, with a drag-mount race that the apply loop is bounded against.
 *
 * The hook below is the whole surface: WorkspacePage mounts it, and the unit
 * test drives it through React's static renderer — the one thing that
 * renderer skips is the layout effect the apply loop lives in, which the
 * test flushes by hand against a frame queue.
 */

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePanelRef, type PanelImperativeHandle, type PanelProps, type PanelSize } from "react-resizable-panels";
import { getProfile } from "@/lib/user-api";

/** Inspector defaults: a 340px opening inside the 320-360px design band, with
 *  a 280px pixel floor so a wide display can keep it compact. */
const INSPECTOR_DEFAULT_PX = 340;

const INSPECTOR_MIN_PX = 280;

/** Persisted widths apply only where the desktop inspector exists. */
const INSPECTOR_WIDE_QUERY = "(min-width: 900px)";

/** The apply loop's target: a resting width and whether the column ends up
 *  collapsed. This is a LAYOUT decision, not a storage shape — the two facts
 *  persist under different scopes. */
interface InspectorPrefs { readonly widthPx: number; readonly collapsed: boolean }

/** The WIDTH is the account's: a preference about this person's display,
 *  stored as a plain pixel number beside the theme choice. A legacy
 *  `<width>:<0|1>` value still reads as its width; the collapsed half was
 *  account-scoped and cannot name a workspace, so it is deliberately dropped —
 *  the per-workspace policy re-decides it. */
function readInspectorWidth(account: string | null): number | null {
  if (account === null) return null;

  const raw = localStorage.getItem(`kinu.inspector.${account}`);

  if (raw === null) return null;

  const width = Number(raw.split(":")[0]);

  return Number.isFinite(width) ? Math.max(INSPECTOR_MIN_PX, Math.round(width)) : null;
}

function writeInspectorWidth(account: string, widthPx: number): void {
  localStorage.setItem(`kinu.inspector.${account}`, String(widthPx));
}

/** The OPEN/CLOSED choice is the workspace's: `"1"` the user opened it here,
 *  `"0"` the user closed it here, absent means this workspace has never been
 *  asked and the first-visit policy decides. A choice made in one workspace
 *  can never leak into another. */
function readInspectorChoice(account: string, workspace: string | undefined): boolean | null {
  const raw = workspace === undefined
    ? null
    : localStorage.getItem(`kinu.inspector.open.${account}.${workspace}`);

  return raw === "1" ? true : raw === "0" ? false : null;
}

function writeInspectorChoice(account: string, workspace: string, open: boolean): void {
  localStorage.setItem(`kinu.inspector.open.${account}.${workspace}`, open ? "1" : "0");
}

/** The account that keys a persisted layout, or why there is none: a signed-in
 *  profile with no email keys nothing, and a profile that could not be read is
 *  a session-only layout. Both are values the effect branches on, not a throw
 *  to classify: the Sidebar's own profile read reports the reason a person
 *  sees. */
type AccountKey = { kind: "known"; email: string } | { kind: "none" } | { kind: "unreadable" };

let readAccountKeyCache: Promise<AccountKey> | null = null;

function readAccountKey(): Promise<AccountKey> {
  return (readAccountKeyCache ??= getProfile().then(
    (profile) => (profile?.email ? { kind: "known", email: profile.email } : { kind: "none" }),
    () => ({ kind: "unreadable" }),
  ));
}

/**
 * What a resize report persists, or null when the report carries no intent.
 * The mount report (`prevSize === undefined`) announces the DEFAULT layout,
 * not a user choice: it must not veto a pending restore or write the default
 * over the stored size. A real report clamps at the pixel floor, and a
 * sub-pixel one counts as collapsed.
 */
function resizePrefsOf(
  size: PanelSize, prevSize: PanelSize | undefined, currentlyCollapsed: boolean,
): InspectorPrefs | null {
  if (prevSize === undefined) return null;

  return {
    widthPx: Math.max(INSPECTOR_MIN_PX, Math.round(size.inPixels)),
    collapsed: currentlyCollapsed || size.inPixels < 1,
  };
}

/**
 * One layout restoration, bounded at 30 scheduled frames total — the
 * wait for the panel's first measured report and the post-apply re-asserts
 * share the one counter, so a panel that never reports still settles.
 *
 * The panel registers with its group after commit; an apply that runs too
 * early is silently dropped and the default layout then reports itself.
 * Re-assert (bounded, and never over a live drag) until a read-back shows the
 * target size actually holding. Every flag here is the caller's own mutable
 * cell so a drag landing mid-loop wins immediately rather than on the next
 * render.
 *
 * `policy` marks the target as the hook's own decision rather than a stored
 * user pref: the report each issued size produces is consumed instead of
 * persisted, the loop aborts to `abortWhen` (the arrived-signal ref: a
 * workspace that turned out to hold something worth seeing never collapses),
 * and a user gesture remains the stronger abort through `userSettled`.
 */
interface InspectorRestoreCtx {
  /** Set once the user has touched the column; the apply loop never crosses it. */
  readonly touched: { current: boolean };
  /** Set once the USER (never a policy write) has decided the column. */
  readonly userSettled: { current: boolean };
  /** Set by the panel's first measured `onResize` report. */
  readonly measured: { current: boolean };
  /** The imperative handle, once the panel registers with its group. */
  readonly panel: { current: PanelImperativeHandle | null };
  /** Runs the next frame of the apply loop; returns its cancellation. */
  readonly schedule: (step: () => void) => () => void;
  /** Reflects a restored collapse into React state and the shared flag. */
  readonly applyCollapsed: () => void;
  /** The pixel size the policy last issued, or null: the report matching it
   *  is consumed; a report at any other size is intent and falls through. */
  readonly policyReport: { current: number | null };
  /** Policy runs only: when set, the loop yields instead of applying. */
  readonly abortWhen?: { current: boolean };
  /** Flips `settled`; the hook also mirrors it into the `ready` state. */
  readonly markSettled: () => void;
}

function restoreInspectorLayout(
  stored: InspectorPrefs, ctx: InspectorRestoreCtx, policy = false,
): () => void {
  let attempts = 0;
  let cancelFrame: () => void = () => {};

  const apply = () => {
    // A stored layout aborts on ANY report of intent — `touched` covers user
    // and policy writes alike. A policy run aborts only on the USER's own
    // settle or the arrived signal: its own reports also set `touched`, and
    // an open loop that read it would die on the report it just caused.
    if ((policy ? ctx.userSettled.current : ctx.touched.current)
      || ctx.abortWhen?.current === true) {
      ctx.markSettled();

      return;
    }

    const panel = ctx.panel.current;

    // A panel that never registers must not spin the loop forever: the same
    // 30-frame bound that caps the measured-report wait caps this one too.
    if (panel === null) {
      attempts += 1;

      if (attempts >= 30) ctx.markSettled();
      else cancelFrame = ctx.schedule(apply);

      return;
    }

    // Wait for the library's first measured report: a group that registered
    // before it could measure applies its DEFAULT layout on that pass, which
    // would overwrite a resize issued blind. The report's arrival means the
    // pass has run. Bounded: a panel registered without its onResize prop
    // reports nothing, and it must not spin forever.
    if (!ctx.measured.current && attempts < 30) {
      attempts += 1;
      cancelFrame = ctx.schedule(apply);

      return;
    }

    const holding = stored.collapsed
      ? panel.isCollapsed()
      : Math.abs(panel.getSize().inPixels - stored.widthPx) <= 3;

    if (!holding) {
      if (policy) ctx.policyReport.current = stored.collapsed ? 0 : stored.widthPx;

      if (stored.collapsed) panel.collapse();
      else panel.resize(stored.widthPx);
    }

    if (stored.collapsed) ctx.applyCollapsed();

    attempts += 1;

    if (holding || attempts >= 30) ctx.markSettled();
    else cancelFrame = ctx.schedule(apply);
  };

  apply();

  return () => cancelFrame();
}


/** The props the inspector Panel gets: the desktop column carries the pixel
 *  floor, the resting width, the collapse affordance and the resize handler;
 *  the mobile column is a zero-or-full pane driven by the page's pane state. */
export type InspectorPanelProps = Pick<
  PanelProps,
  "minSize" | "defaultSize" | "collapsible" | "collapsedSize" | "panelRef" | "onResize" | "className"
>;

/** What the page reads back. `widthPx` is the resting width — updated where
 *  the layout transitions (apply, collapse, expand, reset), not per drag
 *  tick: a drag reports through `onResize` continuously and the page above
 *  this hook is too large to re-render per pointer move. */
export interface InspectorLayout {
  readonly widthPx: number;
  readonly collapsed: boolean;
  readonly onResize: (
    size: PanelSize,
    id: string | number | undefined,
    prevSize: PanelSize | undefined,
  ) => void;
  readonly toggleCollapsed: () => void;
  /** The column's own collapse affordance — WorkSurface's `onCollapse` prop,
   *  present only where the column is on screen and expanded. */
  readonly collapseControl: (() => void) | undefined;
  /** True while the column is collapsed on a desktop layout — the floating
   *  expand affordance renders exactly then. */
  readonly expandVisible: boolean;
  /** The double-click reset on the separator: back to the default width. */
  readonly resetToDefault: () => void;
  /** True once the stored layout has landed or had its chance to. */
  readonly ready: boolean;
  readonly panelRef: RefObject<PanelImperativeHandle | null>;
  readonly panelProps: InspectorPanelProps;
}

export function useInspectorLayout(input: {
  /** True once the layout is wide enough for side-by-side panels. */
  readonly desktopPanels: boolean;
  /** The inspector column's share of the mobile pane — `"100%"` while it is
   *  the visible half, `"0%"` while chat is. */
  readonly mobileDefault: string;
  /** The workspace this column belongs to — what the per-workspace open/close
   *  choice is keyed by. An absent workspace persists no choice. */
  readonly workspace: string | undefined;
  /** The workspace holds something the inspector exists to show — a pending
   *  action or consent, a live slate or preview, produced output. Only
   *  consulted while this workspace carries no stored open/close choice: the
   *  policy default is COLLAPSED, and this signal is what opens the column
   *  once on the workspace's behalf. Any explicit open or close stores the
   *  choice under this workspace and wins from then on. */
  readonly worthShowing: boolean;
}): InspectorLayout {
  const { desktopPanels, mobileDefault, workspace, worthShowing } = input;

  const [widePanels, setWidePanels] = useState(
    () => globalThis.window === undefined || globalThis.window.matchMedia(INSPECTOR_WIDE_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(INSPECTOR_WIDE_QUERY);
    const sync = () => setWidePanels(media.matches);
    sync();
    media.addEventListener("change", sync);

    return () => media.removeEventListener("change", sync);
  }, []);

  // The inspector's explicit width and collapsed state, keyed by account. The
  // account arrives after first paint; the stored layout applies once it does.
  const [accountKey, setAccountKey] = useState<string | null>(
    () => localStorage.getItem("kinu.inspector.account"),
  );

  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [widthPx, setWidthPx] = useState(INSPECTOR_DEFAULT_PX);
  const panelRef = usePanelRef();
  const touchedRef = useRef(false);
  // Mount-time size reports are the default layout announcing itself, not the
  // user choosing anything — nothing persists until the stored layout has had
  // its chance (or a live drag proves intent first).
  const settledRef = useRef(false);
  // The library's first onResize report is its mount announcement — the group
  // has completed a measured layout pass. Until it lands, an imperative
  // resize can be overwritten by the group's own first-pass default layout.
  const measuredRef = useRef(false);
  // The flags the per-workspace policy owns: the report the next imperative
  // size produces is consumed rather than persisted; the collapse this hook
  // itself decided on is what a later signal may open; and that signal opens
  // the column exactly once, never over a user's own choice.
  const policyReportRef = useRef<number | null>(null);
  const autoCollapsedRef = useRef(false);
  const autoOpenedRef = useRef(false);
  // The USER's own decision — drag reports and the affordances — as distinct
  // from `touched`, which the policy's own reports also set. A user choice
  // vetoes both policy transitions; a policy report never counts as one.
  const userSettledRef = useRef(false);
  // The resting width `expand` restores: the collapse affordance cannot read
  // it off a collapsed panel (the element measures 0), so every real width
  // keeps a copy here.
  const restingWidthRef = useRef(INSPECTOR_DEFAULT_PX);
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  // Which workspace the policy refs below belong to; a workspace switch
  // re-decides from the new workspace's stored choice.
  const prevWorkspaceRef = useRef(workspace);
  const widePanelsRef = useRef(widePanels);
  widePanelsRef.current = widePanels;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const worthShowingRef = useRef(worthShowing);
  worthShowingRef.current = worthShowing;

  useEffect(() => {
    let live = true;

    startTransition(async () => {
      const account = await readAccountKey();

      if (!live || account.kind !== "known") return;
      const { email } = account;

      setAccountKey((prev) => {
        if (prev === email) return prev;

        localStorage.setItem("kinu.inspector.account", email);

        return email;
      });
    });

    return () => { live = false; };
  }, []);

  const markSettled = useCallback(() => {
    settledRef.current = true;
    setReady(true);
  }, []);

  const persistWidth = useCallback((nextWidth: number) => {
    const account = accountKeyRef.current;

    if (account === null || !widePanelsRef.current || !settledRef.current) return;
    writeInspectorWidth(account, nextWidth);
  }, []);

  const persistChoice = useCallback((open: boolean) => {
    const account = accountKeyRef.current;
    const ws = workspaceRef.current;

    if (account === null || ws === undefined || !widePanelsRef.current || !settledRef.current) return;
    writeInspectorChoice(account, ws, open);
  }, []);

  // One ctx for every apply-loop run: the schedule, the panel, the flags.
  const restoreCtx = useCallback((): InspectorRestoreCtx => ({
    touched: touchedRef,
    userSettled: userSettledRef,
    measured: measuredRef,
    panel: panelRef,
    schedule: (step) => {
      const frame = requestAnimationFrame(step);

      return () => cancelAnimationFrame(frame);
    },
    applyCollapsed: () => {
      collapsedRef.current = true;
      setCollapsed(true);
    },
    policyReport: policyReportRef,
    markSettled,
  }), [panelRef, markSettled]);

  // The workspace decided something is worth showing: open the column to the
  // resting width, once, without storing anything — no policy transition ever
  // writes a choice.
  const openForSignal = useCallback(() => {
    autoOpenedRef.current = true;
    autoCollapsedRef.current = false;
    collapsedRef.current = false;
    setCollapsed(false);

    return restoreInspectorLayout({ widthPx: restingWidthRef.current, collapsed: false }, restoreCtx(), true);
  }, [restoreCtx]);

  // The stored layout lands once the account is known, and never over a live
  // drag. A layout effect, not a passive one: the panel ref attaches at
  // commit, so this is the first effect that can see it — a passive effect
  // ran before the ref existed, returned early, and never re-ran.
  //
  // Two scopes meet here: the WIDTH is the account's, the OPEN/CLOSED choice
  // is this workspace's. With no choice stored the policy decides — collapsed
  // unless the workspace already holds something worth showing — through the
  // same measured-apply loop, marked as policy so its own size report
  // persists nothing. A workspace switch re-runs this against the new
  // workspace's choice with the flags reset: another workspace's gestures
  // belong to it.
  useLayoutEffect(() => {
    if (prevWorkspaceRef.current !== workspace) {
      prevWorkspaceRef.current = workspace;
      touchedRef.current = false;
      userSettledRef.current = false;
      autoCollapsedRef.current = false;
      autoOpenedRef.current = false;
      settledRef.current = false;
      setReady(false);
      collapsedRef.current = false;
      setCollapsed(false);
    }

    if (!desktopPanels || !widePanels || accountKey === null || touchedRef.current) return;

    const width = readInspectorWidth(accountKey);
    const choice = readInspectorChoice(accountKey, workspace);

    if (choice === null) {
      if (width !== null) {
        restingWidthRef.current = width;
        setWidthPx(width);
      }

      if (worthShowing) return openForSignal();

      autoCollapsedRef.current = true;

      return restoreInspectorLayout(
        { widthPx: restingWidthRef.current, collapsed: true },
        { ...restoreCtx(), abortWhen: worthShowingRef },
        true,
      );
    }

    const target: InspectorPrefs = { widthPx: width ?? INSPECTOR_DEFAULT_PX, collapsed: !choice };
    restingWidthRef.current = target.widthPx;
    setWidthPx(target.widthPx);
    collapsedRef.current = target.collapsed;
    setCollapsed(target.collapsed);

    return restoreInspectorLayout(target, restoreCtx());
  }, [desktopPanels, widePanels, accountKey, workspace, worthShowing, panelRef, restoreCtx, openForSignal]);

  // The one automatic open: the workspace produced something worth seeing
  // after the column had already settled closed. Only the policy-collapsed
  // column is eligible — a user's own close, or any stored choice, is never
  // reopened by an arrival. Opens through the apply loop so it cannot be
  // overwritten by the group's first pass, and writes nothing to the store.
  useLayoutEffect(() => {
    if (!worthShowing || autoOpenedRef.current || !autoCollapsedRef.current
      || userSettledRef.current) {
      return;
    }

    return openForSignal();
  }, [worthShowing, openForSignal]);

  const collapse = useCallback(() => {
    touchedRef.current = true;
    settledRef.current = true;
    userSettledRef.current = true;
    const panel = panelRef.current;
    const width = panel?.getSize().inPixels ?? 0;

    if (width >= 1) {
      const rounded = Math.max(INSPECTOR_MIN_PX, Math.round(width));
      restingWidthRef.current = rounded;
      setWidthPx(rounded);
      persistWidth(rounded);
    }

    collapsedRef.current = true;
    setCollapsed(true);
    persistChoice(false);
    panel?.collapse();
  }, [panelRef, persistWidth, persistChoice]);

  const expand = useCallback(() => {
    touchedRef.current = true;
    settledRef.current = true;
    userSettledRef.current = true;
    autoCollapsedRef.current = false;
    const width = restingWidthRef.current;
    collapsedRef.current = false;
    setCollapsed(false);
    setWidthPx(width);
    persistWidth(width);
    persistChoice(true);
    panelRef.current?.resize(width);
  }, [panelRef, persistWidth, persistChoice]);

  const toggleCollapsed = useCallback(() => {
    if (collapsedRef.current) expand();
    else collapse();
  }, [collapse, expand]);

  const resetToDefault = useCallback(() => {
    touchedRef.current = true;
    settledRef.current = true;
    userSettledRef.current = true;
    autoCollapsedRef.current = false;
    restingWidthRef.current = INSPECTOR_DEFAULT_PX;
    persistWidth(INSPECTOR_DEFAULT_PX);
    persistChoice(true);
    collapsedRef.current = false;
    setCollapsed(false);
    setWidthPx(INSPECTOR_DEFAULT_PX);
    panelRef.current?.resize(INSPECTOR_DEFAULT_PX);
  }, [panelRef, persistWidth, persistChoice]);

  const onResize = useCallback((size: PanelSize, _id: string | number | undefined, prevSize: PanelSize | undefined) => {
    // Every report means the group completed a measured pass; the apply loop
    // above waits for exactly that before issuing its imperative size.
    measuredRef.current = true;
    let prefs = resizePrefsOf(size, prevSize, collapsedRef.current);

    if (prefs === null) return;

    if (!widePanelsRef.current || accountKeyRef.current === null) return;
    touchedRef.current = true;
    settledRef.current = true;

    // A report at the size the policy just issued carries no intent: consume
    // it, never persist it. A report at any OTHER size is a gesture landing
    // inside the policy's own re-assert window — leave the flag; a collapsed
    // report while the policy is still applying is noise, not a close.
    if (policyReportRef.current !== null) {
      const issued = policyReportRef.current;

      if (issued < 1 ? size.inPixels < 1 : Math.abs(size.inPixels - issued) <= 3) {
        policyReportRef.current = null;

        return;
      }

      if (size.inPixels < 1) return;
    }

    // While the policy still owns the column, a report at the collapsed size
    // is layout noise — a group re-layout, not intent — and persists nothing.
    // A report that leaves the column OPEN is a gesture: hand the column over
    // and record the choice, collapsed bit included.
    if (autoCollapsedRef.current && !userSettledRef.current) {
      if (size.inPixels < 1) return;

      autoCollapsedRef.current = false;
      collapsedRef.current = false;
      setCollapsed(false);
      prefs = { ...prefs, collapsed: false };
    }

    if (size.inPixels >= 1) restingWidthRef.current = prefs.widthPx;

    userSettledRef.current = true;
    persistWidth(prefs.widthPx);
    persistChoice(!prefs.collapsed);
  }, [persistWidth, persistChoice]);

  const panelProps: InspectorPanelProps = desktopPanels
    ? {
      minSize: `${String(INSPECTOR_MIN_PX)}px`,
      defaultSize: `${String(widthPx)}px`,
      collapsible: true,
      collapsedSize: "0px",
      panelRef,
      onResize,
      className: collapsed ? "overflow-hidden" : undefined,
    }
    : { minSize: "0%", defaultSize: mobileDefault };

  return {
    widthPx,
    collapsed,
    onResize,
    toggleCollapsed,
    collapseControl: desktopPanels && !collapsed ? collapse : undefined,
    expandVisible: desktopPanels && collapsed,
    resetToDefault,
    ready,
    panelRef,
    panelProps,
  };
}
