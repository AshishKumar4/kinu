/**
 * The inspector column's layout policy: a per-account persisted width and
 * collapsed flag, applied over the panel library's own layout, with a
 * drag-mount race that the apply loop is bounded against.
 *
 * Everything decision-shaped here is exported as a pure seam —
 * `readInspectorPrefs`, `writeInspectorPrefs` and `restoreInspectorLayout` —
 * so the policy is exercised under `bun test` without a DOM; the hook below
 * is only the React wiring over those seams.
 */

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePanelRef, type PanelImperativeHandle, type PanelProps, type PanelSize } from "react-resizable-panels";
import { getProfile } from "@/lib/user-api";
import { diagnostics } from "@kinu.run/core/obs";

/** Inspector defaults: a 340px opening inside the 320-360px design band, with
 *  a 280px pixel floor so a wide display can keep it compact. */
export const INSPECTOR_DEFAULT_PX = 340;

export const INSPECTOR_MIN_PX = 280;

/** Persisted widths apply only where the desktop inspector exists. */
export const INSPECTOR_WIDE_QUERY = "(min-width: 900px)";

export interface InspectorPrefs { readonly widthPx: number; readonly collapsed: boolean }

/** Stored as `<widthPx>:<0|1>` beside the theme choice, keyed by account. */
export function readInspectorPrefs(account: string | null): InspectorPrefs | null {
  if (account === null) return null;

  const raw = localStorage.getItem(`kinu.inspector.${account}`);

  if (raw === null) return null;

  const [widthText, collapsedText] = raw.split(":");
  const width = Number(widthText);

  if (!Number.isFinite(width)) return null;

  return { widthPx: Math.max(INSPECTOR_MIN_PX, Math.round(width)), collapsed: collapsedText === "1" };
}

export function writeInspectorPrefs(account: string, prefs: InspectorPrefs): void {
  localStorage.setItem(`kinu.inspector.${account}`, `${String(prefs.widthPx)}:${prefs.collapsed ? "1" : "0"}`);
}

let profileEmailCache: Promise<string | null> | null = null;

function profileEmail(): Promise<string | null> {
  const cached = (profileEmailCache ??= getProfile().then(
    (profile) => profile?.email ?? null,
    () => {
      diagnostics.event("inspector.profile_unreadable");

      return null;
    },
  ));

  return cached;
}

/**
 * What a resize report persists, or null when the report carries no intent.
 * The mount report (`prevSize === undefined`) announces the DEFAULT layout,
 * not a user choice: it must not veto a pending restore or write the default
 * over the stored size. A real report clamps at the pixel floor, and a
 * sub-pixel one counts as collapsed.
 */
export function resizePrefsOf(
  size: PanelSize, prevSize: PanelSize | undefined, currentlyCollapsed: boolean,
): InspectorPrefs | null {
  if (prevSize === undefined) return null;

  return {
    widthPx: Math.max(INSPECTOR_MIN_PX, Math.round(size.inPixels)),
    collapsed: currentlyCollapsed || size.inPixels < 1,
  };
}

/**
 * One stored-layout restoration, bounded at 30 scheduled frames total — the
 * wait for the panel's first measured report and the post-apply re-asserts
 * share the one counter, so a panel that never reports still settles.
 *
 * The panel registers with its group after commit; an apply that runs too
 * early is silently dropped and the default layout then reports itself.
 * Re-assert (bounded, and never over a live drag) until a read-back shows the
 * stored size actually holding. Every flag here is the caller's own mutable
 * cell so a drag landing mid-loop wins immediately rather than on the next
 * render.
 */
export interface InspectorRestoreCtx {
  /** Set once the user has touched the column; the apply loop never crosses it. */
  readonly touched: { current: boolean };
  /** Set by the panel's first measured `onResize` report. */
  readonly measured: { current: boolean };
  /** The imperative handle, once the panel registers with its group. */
  readonly panel: { current: PanelImperativeHandle | null };
  /** Runs the next frame of the apply loop; returns its cancellation. */
  readonly schedule: (step: () => void) => () => void;
  /** Reflects a restored collapse into React state and the shared flag. */
  readonly applyCollapsed: () => void;
  /** Flips `settled`; the hook also mirrors it into the `ready` state. */
  readonly markSettled: () => void;
}

export function restoreInspectorLayout(
  stored: InspectorPrefs, ctx: InspectorRestoreCtx,
): () => void {
  let attempts = 0;
  let cancelFrame: () => void = () => {};

  const apply = () => {
    if (ctx.touched.current) {
      ctx.markSettled();

      return;
    }

    const panel = ctx.panel.current;

    if (panel === null) {
      cancelFrame = ctx.schedule(apply);

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

    if (stored.collapsed) {
      ctx.applyCollapsed();
      panel.collapse();
    } else {
      panel.resize(stored.widthPx);
    }

    attempts += 1;

    const holding = stored.collapsed
      ? panel.isCollapsed()
      : Math.abs(panel.getSize().inPixels - stored.widthPx) <= 3;

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
}): InspectorLayout {
  const { desktopPanels, mobileDefault } = input;

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
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;
  const widePanelsRef = useRef(widePanels);
  widePanelsRef.current = widePanels;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  useEffect(() => {
    let live = true;

    startTransition(async () => {
      const email = await profileEmail();

      if (!live || email === null) return;

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

  const persistInspector = useCallback((nextWidth: number, nextCollapsed: boolean) => {
    const account = accountKeyRef.current;

    if (account === null || !widePanelsRef.current || !settledRef.current) return;
    writeInspectorPrefs(account, { widthPx: nextWidth, collapsed: nextCollapsed });
  }, []);

  // Stored layout lands once the account is known, and never over a live drag.
  // A layout effect, not a passive one: the panel ref attaches at commit, so
  // this is the first effect that can see it — a passive effect ran before the
  // ref existed, returned early, and never re-ran.
  useLayoutEffect(() => {
    if (!desktopPanels || !widePanels || accountKey === null || touchedRef.current) return;
    const stored = readInspectorPrefs(accountKey);

    if (stored === null) {
      settledRef.current = true;
      setReady(true);

      return;
    }

    setWidthPx(stored.widthPx);

    return restoreInspectorLayout(stored, {
      touched: touchedRef,
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
      markSettled,
    });
  }, [desktopPanels, widePanels, accountKey, panelRef, markSettled]);

  const collapse = useCallback(() => {
    touchedRef.current = true;
    settledRef.current = true;
    const panel = panelRef.current;
    const width = panel?.getSize().inPixels ?? INSPECTOR_DEFAULT_PX;
    collapsedRef.current = true;
    setCollapsed(true);
    const rounded = Math.max(INSPECTOR_MIN_PX, Math.round(width));
    setWidthPx(rounded);
    persistInspector(rounded, true);
    panel?.collapse();
  }, [panelRef, persistInspector]);

  const expand = useCallback(() => {
    touchedRef.current = true;
    const panel = panelRef.current;
    const width = Math.max(INSPECTOR_MIN_PX, Math.round(panel?.getSize().inPixels ?? INSPECTOR_DEFAULT_PX));
    collapsedRef.current = false;
    setCollapsed(false);
    setWidthPx(width);
    persistInspector(width, false);
    panel?.expand();
  }, [panelRef, persistInspector]);

  const toggleCollapsed = useCallback(() => {
    if (collapsedRef.current) expand();
    else collapse();
  }, [collapse, expand]);

  const resetToDefault = useCallback(() => {
    touchedRef.current = true;
    persistInspector(INSPECTOR_DEFAULT_PX, false);
    collapsedRef.current = false;
    setCollapsed(false);
    setWidthPx(INSPECTOR_DEFAULT_PX);
    panelRef.current?.resize(INSPECTOR_DEFAULT_PX);
  }, [panelRef, persistInspector]);

  const onResize = useCallback((size: PanelSize, _id: string | number | undefined, prevSize: PanelSize | undefined) => {
    // Every report means the group completed a measured pass; the apply loop
    // above waits for exactly that before issuing its imperative size.
    measuredRef.current = true;
    const prefs = resizePrefsOf(size, prevSize, collapsedRef.current);

    if (prefs === null) return;

    if (!widePanelsRef.current || accountKeyRef.current === null) return;
    touchedRef.current = true;
    settledRef.current = true;
    persistInspector(prefs.widthPx, prefs.collapsed);
  }, [persistInspector]);

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
