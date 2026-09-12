/**
 * The inspector column's layout policy: a per-account persisted WIDTH and a
 * per-WORKSPACE persisted open/close choice, decided against the panel
 * library's own layout lifecycle.
 *
 * The group mounts immediately — chat stays usable while the profile read is
 * in flight — with the policy default as its layout. `defaultLayout` /
 * `defaultSize` carry the mount decision and no imperative write is ever
 * issued into an unmeasured group: a decision that lands first parks in one
 * slot for the first emission, which applies it once. Every committed layout
 * reports once through `onLayoutChanged`; that single signal persists user
 * gestures and detects the hook's own echoes.
 */

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePanelRef, type PanelImperativeHandle, type PanelProps, type Layout } from "react-resizable-panels";
import { getProfile } from "@/lib/user-api";

const INSPECTOR_DEFAULT_PX = 340;

const INSPECTOR_MIN_PX = 280;

const INSPECTOR_WIDE_QUERY = "(min-width: 900px)";

const CHAT_PANEL_ID = "chat";

const INSPECTOR_PANEL_ID = "inspector";

interface InspectorTarget { readonly collapsed: boolean; readonly widthPx: number }

/** The WIDTH is the account's: a preference about this person's display,
 *  stored as a plain pixel number beside the theme choice. A legacy
 *  `<width>:<0|1>` value still reads as its width; the collapsed half cannot
 *  name a workspace, so it is deliberately dropped. */
function readInspectorWidth(account: string): number | null {
  const raw = localStorage.getItem(`kinu.inspector.${account}`);
  const width = raw === null ? NaN : Number(raw.split(":")[0]);

  return Number.isFinite(width) ? Math.max(INSPECTOR_MIN_PX, Math.round(width)) : null;
}

/** The OPEN/CLOSED choice is the workspace's: `"1"` opened here, `"0"` closed
 *  here, absent means the first-visit policy decides. A choice made in one
 *  workspace can never leak into another. */
function readInspectorChoice(account: string, workspace: string | undefined): boolean | null {
  const raw = workspace === undefined
    ? null
    : localStorage.getItem(`kinu.inspector.open.${account}.${workspace}`);

  return raw === "1" ? true : raw === "0" ? false : null;
}

/** The account that keys a persisted layout, or why there is none: a signed-in
 *  profile with no email keys nothing, and a profile that could not be read is
 *  a session-only layout — the failure is classified, not swallowed. */
type AccountKey =
  | { kind: "known"; email: string }
  | { kind: "none" }
  | { kind: "unreadable" };

let readAccountKeyCache: Promise<AccountKey> | null = null;

function readAccountKey(): Promise<AccountKey> {
  return (readAccountKeyCache ??= getProfile().then(
    (profile): AccountKey => (profile?.email ? { kind: "known", email: profile.email } : { kind: "none" }),
    (): AccountKey => ({ kind: "unreadable" }),
  ));
}

export type InspectorPanelProps = Pick<
  PanelProps,
  "id" | "minSize" | "defaultSize" | "collapsible" | "collapsedSize" | "panelRef" | "className"
>;

export interface InspectorGroupProps {
  readonly defaultLayout: Layout | undefined;
  readonly onLayoutChanged: (layout: Layout) => void;
  readonly elementRef: (element: HTMLDivElement | null) => void;
}

/** The decided layout: the stored choice when one exists, else the
 *  first-visit policy — collapsed unless the workspace holds something worth
 *  seeing (the live signal, or the one auto-open it already served). */
function readDecision(
  account: string | null, workspace: string | undefined, showContent: boolean,
): InspectorTarget {
  const width = (account === null ? null : readInspectorWidth(account)) ?? INSPECTOR_DEFAULT_PX;
  const choice = account === null ? null : readInspectorChoice(account, workspace);

  return { collapsed: choice === null ? !showContent : !choice, widthPx: width };
}

/** A committed inspector width in pixels: flex share × measured group box.
 *  (`getSize()` inside a commit report reads the DOM a commit early.) */
function committedWidthPx(
  layout: Layout, group: HTMLDivElement | null, fallback: () => number,
): number {
  const share = layout[INSPECTOR_PANEL_ID];

  if (share === undefined || share <= 0) return 0;

  if (group === null) return fallback();

  const total = Object.values(layout).reduce((sum, flex) => sum + Math.max(0, flex), 0);

  if (total <= 0) return 0;

  let separators = 0;

  for (const el of group.querySelectorAll("[data-separator]")) {
    separators += el.getBoundingClientRect().width;
  }

  return Math.round((share / total) * Math.max(0, group.clientWidth - separators));
}

/** Two layouts are the same column: identical collapse, widths within the
 *  flex→px rounding the committed map carries. */
function matchesLayout(a: InspectorTarget, b: InspectorTarget): boolean {
  return a.collapsed === b.collapsed && (a.collapsed || Math.abs(a.widthPx - b.widthPx) <= 3);
}

export interface InspectorLayout {
  readonly widthPx: number;
  readonly collapsed: boolean;
  readonly onLayoutChanged: (layout: Layout) => void;
  readonly toggleCollapsed: () => void;
  readonly collapseControl: (() => void) | undefined;
  readonly expandVisible: boolean;
  readonly resetToDefault: () => void;
  readonly ready: boolean;
  readonly panelRef: RefObject<PanelImperativeHandle | null>;
  readonly panelProps: InspectorPanelProps;
  readonly groupProps: InspectorGroupProps;
}

export function useInspectorLayout(input: {
  readonly desktopPanels: boolean;
  readonly mobileDefault: string;
  readonly workspace: string | undefined;
  /** The workspace holds something the inspector exists to show. Only
   *  consulted while this workspace carries no stored open/close choice. */
  readonly worthShowing: boolean;
}): InspectorLayout {
  const { desktopPanels, mobileDefault, workspace, worthShowing } = input;

  const [widePanels, setWidePanels] = useState(
    () => globalThis.window === undefined || globalThis.window.matchMedia(INSPECTOR_WIDE_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(INSPECTOR_WIDE_QUERY);
    const onChange = () => setWidePanels(media.matches);
    onChange();
    media.addEventListener("change", onChange);

    return () => media.removeEventListener("change", onChange);
  }, []);

  const [account, setAccount] = useState<string | null>(
    () => localStorage.getItem("kinu.inspector.account"),
  );

  useEffect(() => {
    let live = true;

    startTransition(async () => {
      const key = await readAccountKey();
      const email = key.kind === "known" ? key.email : null;

      if (!live || email === null) return;

      setAccount((prev) => {
        if (prev === email) return prev;

        localStorage.setItem("kinu.inspector.account", email);

        return email;
      });
    });

    return () => { live = false; };
  }, []);

  const mountDecision = desktopPanels && widePanels
    ? readDecision(account, workspace, worthShowing)
    : null;

  const [collapsed, setCollapsed] = useState(mountDecision?.collapsed ?? false);
  const [widthPx, setWidthPx] = useState(mountDecision?.widthPx ?? INSPECTOR_DEFAULT_PX);
  const [ready, setReady] = useState(false);
  const panelRef = usePanelRef();

  // ── Owned state: `expectedLayout` (our echo or their gesture), the
  // workspace the user chose (`userDecided`) and the one the signal already
  // opened (`autoOpened`).
  const expectedLayoutRef = useRef<InspectorTarget | null>(mountDecision);
  const userDecidedRef = useRef<string | null>(null);
  const autoOpenedRef = useRef<string | null>(null);
  const groupElementRef = useRef<HTMLDivElement | null>(null);

  // A decision made before the group's first committed pass — a write issued
  // into an unmeasured group is recomputed against a zero-size box and lost,
  // so the slot waits for the first emission, which applies it once. This is
  // not a loop: the library's own commit is the schedule, and a gesture that
  // lands first clears the slot and wins.
  const pendingDecisionRef = useRef<InspectorTarget | null>(null);
  // The group has committed a layout at least once, so imperative writes land.
  const groupMeasuredRef = useRef(false);

  // The target of the hook's own in-flight imperative write. The next
  // emission after a write is that write's commit report — even when the
  // library constrains it short of what was asked — so it adopts the actual
  // layout without persisting: the intent was already stored by `claim`, or
  // never needed storing (a policy move). The marker is airtight because a
  // write the hook issues always spans more than the library's rounding
  // quantum (3-decimal flex; the hook never writes inside ±3px), so its
  // emission is guaranteed and the marker cannot strand onto a later
  // gesture. A same-frame user race reads against the requested direction
  // and falls through to the gesture path when it disagrees.
  const writeMarkerRef = useRef<InspectorTarget | null>(null);
  // The desktop/mobile mode the measurement flag belongs to: the group's key
  // follows the mode, so each swap remounts it and the next emission is a
  // fresh announcement again.
  const groupModeRef = useRef(desktopPanels);

  const persistWidth = useCallback((nextWidth: number) => {
    if (account === null || !widePanels) return;
    localStorage.setItem(`kinu.inspector.${account}`, String(nextWidth));
  }, [account, widePanels]);

  const persistChoice = useCallback((open: boolean) => {
    if (account === null || workspace === undefined || !widePanels) return;
    localStorage.setItem(`kinu.inspector.open.${account}.${workspace}`, open ? "1" : "0");
  }, [account, workspace, widePanels]);


  // A layout the user now owns: expected so its emission reads as an echo,
  // reflected into state, persisted as theirs.
  const claim = useCallback((target: InspectorTarget) => {
    userDecidedRef.current = workspace ?? null;
    expectedLayoutRef.current = target;
    setCollapsed(target.collapsed);
    setWidthPx(target.widthPx);
    persistWidth(target.widthPx);
    persistChoice(!target.collapsed);
  }, [workspace, persistWidth, persistChoice]);
  // The one place imperative writes leave the hook: the target is remembered
  // so its own commit report is recognizable past any constraint. Claim
  // (which persists) and issue (which marks) stay paired at every call site.

  const issueWrite = useCallback((target: InspectorTarget) => {
    const panel = panelRef.current;

    if (panel === null) return;

    writeMarkerRef.current = target;

    if (target.collapsed) panel.collapse();
    else panel.resize(target.widthPx);
  }, [panelRef]);

  // The workspace's layout, decided and applied in one place: on mount, on a
  // workspace switch, when the account key lands, and on the signal that
  // opens a policy-closed column once on the workspace's behalf. A gesture
  // the user already made wins outright. The signal open is a
  // once-per-workspace latch; a stored choice ends the policy's say entirely.
  useLayoutEffect(() => {
    // The group's key follows the desktop/mobile mode: each swap remounts
    // it, so measurement, the parked slot and any write marker belong to
    // the previous tree.
    if (groupModeRef.current !== desktopPanels) {
      groupModeRef.current = desktopPanels;
      groupMeasuredRef.current = false;
      pendingDecisionRef.current = null;
      writeMarkerRef.current = null;
    }

    if (!desktopPanels || !widePanels || userDecidedRef.current === workspace) return;

    const target = readDecision(account, workspace,
      worthShowing || autoOpenedRef.current === workspace);

    if (worthShowing && account !== null
      && readInspectorChoice(account, workspace) === null) {
      autoOpenedRef.current = workspace ?? null;
    }

    const expected = expectedLayoutRef.current;

    if (expected !== null && matchesLayout(expected, target)) {
      setCollapsed(target.collapsed);
      setWidthPx(target.widthPx);
      setReady(true);

      return;
    }

    if (!groupMeasuredRef.current || panelRef.current === null) {
      pendingDecisionRef.current = target;

      return;
    }

    expectedLayoutRef.current = target;
    setCollapsed(target.collapsed);
    setWidthPx(target.widthPx);
    setReady(true);
    issueWrite(target);
  }, [account, workspace, worthShowing, desktopPanels, widePanels, panelRef, issueWrite]);

  const collapse = useCallback(() => {
    const width = panelRef.current?.getSize().inPixels ?? 0;
    const rounded = width >= 1 ? Math.max(INSPECTOR_MIN_PX, Math.round(width)) : widthPx;
    const target = { collapsed: true, widthPx: rounded };

    claim(target);
    issueWrite(target);
  }, [panelRef, widthPx, claim, issueWrite]);

  const expand = useCallback(() => {
    const target = { collapsed: false, widthPx };

    claim(target);
    issueWrite(target);
  }, [widthPx, claim, issueWrite]);

  const toggleCollapsed = useCallback(() => {
    if (collapsed) expand();
    else collapse();
  }, [collapsed, collapse, expand]);

  const resetToDefault = useCallback(() => {
    const target = { collapsed: false, widthPx: INSPECTOR_DEFAULT_PX };

    claim(target);
    issueWrite(target);
  }, [claim, issueWrite]);

  // Every committed layout reports here exactly once. The first per group
  // tree is the mount announcing itself — possibly constrained short of the
  // decided layout — so it is adopted, never persisted. Later reports are
  // the hook's own write (the marker names it, direction-checked against a
  // same-frame user race), an exact echo, or a user gesture.
  const onLayoutChanged = useCallback((layout: Layout) => {
    if (!desktopPanels) return;

    const first = !groupMeasuredRef.current;
    groupMeasuredRef.current = true;

    const share = layout[INSPECTOR_PANEL_ID];
    const collapsedNow = share !== undefined && share <= 0;

    const now: InspectorTarget = {
      // A collapsed report carries no width of its own: the remembered
      // expansion width is the last open one, never zero.
      collapsed: collapsedNow,
      widthPx: collapsedNow ? widthPx : Math.max(INSPECTOR_MIN_PX, committedWidthPx(
        layout, groupElementRef.current,
        () => Math.round(panelRef.current?.getSize().inPixels ?? 0),
      )),
    };

    if (first) {
      expectedLayoutRef.current = now;
      setCollapsed(now.collapsed);

      if (!now.collapsed) setWidthPx(now.widthPx);

      setReady(true);

      // A decision parked for this pass applies now, once — the single write
      // the unmeasured group could not take.
      const pending = pendingDecisionRef.current;
      pendingDecisionRef.current = null;

      if (pending !== null) {
        expectedLayoutRef.current = pending;
        setCollapsed(pending.collapsed);
        setWidthPx(pending.widthPx);
        setReady(true);
        issueWrite(pending);
      }

      return;
    }

    const marker = writeMarkerRef.current;
    writeMarkerRef.current = null;

    if (marker !== null && (marker.collapsed ? now.collapsed : !now.collapsed)) {
      // Our own write reporting back, possibly constrained: adopt what
      // landed. The intent was already persisted by `claim` (or never needs
      // storing, for a policy move), so nothing writes here.
      expectedLayoutRef.current = now;
      setCollapsed(now.collapsed);

      if (!now.collapsed) setWidthPx(now.widthPx);

      return;
    }

    const expected = expectedLayoutRef.current;

    if (expected !== null && matchesLayout(expected, now)) {
      setCollapsed(now.collapsed);

      if (!now.collapsed) setWidthPx(now.widthPx);

      return;
    }

    // A gesture: the column is the user's — anything still parked dies with it.
    pendingDecisionRef.current = null;
    claim(now);
    setReady(true);
  }, [desktopPanels, panelRef, widthPx, claim, issueWrite]);

  const panelProps: InspectorPanelProps = desktopPanels
    ? {
      id: INSPECTOR_PANEL_ID,
      minSize: `${String(INSPECTOR_MIN_PX)}px`,
      defaultSize: `${String(widthPx)}px`,
      collapsible: true,
      collapsedSize: "0px",
      panelRef,
      className: collapsed ? "overflow-hidden" : undefined,
    }
    : { id: INSPECTOR_PANEL_ID, minSize: "0%", defaultSize: mobileDefault };

  const groupProps: InspectorGroupProps = {
    // The group applies the decided mount layout in its own first pass — an
    // imperative collapse could be clobbered by that pass, this cannot.
    defaultLayout: mountDecision?.collapsed === true
      ? { [CHAT_PANEL_ID]: 1, [INSPECTOR_PANEL_ID]: 0 }
      : undefined,
    onLayoutChanged,
    elementRef: (element: HTMLDivElement | null) => { groupElementRef.current = element; },
  };

  return {
    widthPx,
    collapsed,
    onLayoutChanged,
    toggleCollapsed,
    collapseControl: desktopPanels && !collapsed ? collapse : undefined,
    expandVisible: desktopPanels && collapsed,
    resetToDefault,
    ready,
    panelRef,
    panelProps,
    groupProps,
  };
}
