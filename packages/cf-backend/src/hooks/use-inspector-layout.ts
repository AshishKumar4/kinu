/**
 * The inspector column's layout policy: a per-account persisted WIDTH and a
 * per-WORKSPACE persisted open/close choice, decided against the panel
 * library's own layout lifecycle.
 *
 * The group owns layout: mount state arrives through `defaultLayout` /
 * `Panel.defaultSize`, and every committed change reports once through
 * `onLayoutChanged` — after the group's measured pass, never mid-drag. That
 * emission is the lifecycle signal the previous rAF apply loop re-created by
 * hand: a write issued before the first pass is clobbered, so decisions that
 * arrive before it wait in `pendingDecision` for the first emission instead
 * of polling.
 *
 * The hook is the whole surface: WorkspacePage mounts it, and the unit test
 * drives it through React's static renderer, feeding the `onLayoutChanged`
 * callback the way the group's own emissions would arrive.
 */

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePanelRef, type PanelImperativeHandle, type PanelProps, type Layout } from "react-resizable-panels";
import { getProfile } from "@/lib/user-api";

/** Inspector defaults: a 340px opening inside the 320-360px design band, with
 *  a 280px pixel floor so a wide display can keep it compact. */
const INSPECTOR_DEFAULT_PX = 340;

const INSPECTOR_MIN_PX = 280;

/** Persisted widths apply only where the desktop inspector exists. */
const INSPECTOR_WIDE_QUERY = "(min-width: 900px)";

/** Panel ids the group layout is keyed by: the page's chat column and the
 *  inspector. The page names its own Panel `chat`; `panelProps` carries
 *  `inspector`. */
const CHAT_PANEL_ID = "chat";

const INSPECTOR_PANEL_ID = "inspector";

/** What a decided layout looks like, in the units the column itself reports:
 *  collapsed is boolean truth, width is measured pixels. */
interface InspectorTarget { readonly collapsed: boolean; readonly widthPx: number }

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

/** The props the inspector Panel gets: the desktop column carries the pixel
 *  floor, the resting width, the collapse affordance and the resize handler;
 *  the mobile column is a zero-or-full pane driven by the page's pane state. */
export type InspectorPanelProps = Pick<
  PanelProps,
  "id" | "minSize" | "defaultSize" | "collapsible" | "collapsedSize" | "panelRef" | "className"
>;

/** The props the PanelGroup gets: the mount layout when the decided column is
 *  collapsed (the group's own first pass applies it — no imperative write, so
 *  nothing is clobbered), the committed-layout callback every gesture and
 *  every programmatic write reports through, and the element ref the handler
 *  measures against. */
export interface InspectorGroupProps {
  readonly defaultLayout: Layout | undefined;
  readonly onLayoutChanged: (layout: Layout) => void;
  readonly elementRef: (element: HTMLDivElement | null) => void;
}

/** A committed inspector width in pixels. The panel's own `getSize()` reads
 *  the DOM one commit early inside `onLayoutChanged` — a report can arrive
 *  before the element reflects it — so the committed flex map and the group
 *  element's own box answer instead: collapsed reads as flex 0, open as the
 *  inspector's share of the measured group width. */
function committedWidthPx(
  layout: Layout, groupElement: HTMLDivElement | null, fallback: () => number,
): number {
  const share = layout[INSPECTOR_PANEL_ID];

  if (share === undefined || share <= 0) return 0;

  if (groupElement === null) return fallback();

  const total = Object.values(layout).reduce((sum, flex) => sum + Math.max(0, flex), 0);

  if (total <= 0) return 0;

  // The group element's content box includes its separators; each one is a
  // fixed chrome strip the panels do not share.
  let separators = 0;

  for (const el of groupElement.querySelectorAll('[data-separator]')) {
    separators += el.getBoundingClientRect().width;
  }

  const available = Math.max(0, groupElement.clientWidth - separators);

  return Math.round((share / total) * available);
}

/** What the page reads back. `widthPx` is the resting width — updated where
 *  the layout transitions (decision, collapse, expand, reset, drag commit),
 *  not per drag tick: the page above this hook is too large to re-render per
 *  pointer move. */
export interface InspectorLayout {
  readonly widthPx: number;
  readonly collapsed: boolean;
  /** The committed-layout callback: the group's emissions land here, and the
   *  test harness reports through the same seam. */
  readonly onLayoutChanged: (layout: Layout) => void;
  readonly toggleCollapsed: () => void;
  /** The column's own collapse affordance — WorkSurface's `onCollapse` prop,
   *  present only where the column is on screen and expanded. */
  readonly collapseControl: (() => void) | undefined;
  /** True while the column is collapsed on a desktop layout — the floating
   *  expand affordance renders exactly then. */
  readonly expandVisible: boolean;
  /** The double-click reset on the separator: back to the default width. */
  readonly resetToDefault: () => void;
  /** True once the workspace's layout decision has been applied. */
  readonly ready: boolean;
  readonly panelRef: RefObject<PanelImperativeHandle | null>;
  readonly panelProps: InspectorPanelProps;
  readonly groupProps: InspectorGroupProps;
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

  // The account key resolves after first paint for a fresh session; a seeded
  // `kinu.inspector.account` means the whole decision can be read at mount.
  const [accountKey, setAccountKey] = useState<string | null>(
    () => localStorage.getItem("kinu.inspector.account"),
  );

  // The mount-time decision: what this workspace's stored choice (or the
  // first-visit policy, when none exists) says the column starts as. Null
  // means the library defaults stand — the narrow band and the mobile pane
  // keep their existing behavior. An account that has not resolved yet can
  // only be a fresh session — no choice exists for one — so the policy
  // default decides it: collapsed.
  const mountDecision = ((): InspectorTarget | null => {
    if (!desktopPanels || !widePanels) return null;

    const width = (accountKey === null ? null : readInspectorWidth(accountKey)) ?? INSPECTOR_DEFAULT_PX;
    const choice = accountKey === null ? null : readInspectorChoice(accountKey, workspace);

    if (choice !== null) return { collapsed: !choice, widthPx: width };

    return worthShowing
      ? { collapsed: false, widthPx: width }
      : { collapsed: true, widthPx: width };
  })();

  const [collapsed, setCollapsed] = useState(() => widePanels && (mountDecision?.collapsed ?? false));
  const [ready, setReady] = useState(false);
  const [widthPx, setWidthPx] = useState(mountDecision?.widthPx ?? INSPECTOR_DEFAULT_PX);
  const panelRef = usePanelRef();

  // ── The decision and gesture flags, each earning its place ─────────────
  // What the hook itself last caused the layout to be — the mount default or
  // an issued write. An emission that matches it is the echo of our own act:
  // sync state, persist nothing. One that does not is a user gesture.
  const expectedLayoutRef = useRef<InspectorTarget | null>(
    mountDecision === null ? null : { ...mountDecision },
  );
  // The user has decided this workspace's column (any persisted gesture).
  // Policy transitions never cross it; a workspace switch resets it.

  const userDecidedRef = useRef(false);
  // Which of the no-choice outcomes the hook itself produced: 'closed' when
  // the policy collapsed it, 'open' when the signal opened it, null when a
  // stored choice (or the narrow band) owns the column. The mount decision
  // answers this for the layout the group starts from.

  const policyOwnsRef = useRef<"closed" | "open" | null>(
    mountDecision === null
      ? null
      : accountKey !== null && readInspectorChoice(accountKey, workspace) !== null
        ? null
        : mountDecision.collapsed ? "closed" : "open",
  );

  // The group's element: committed px are read as the inspector's flex share
  // of its measured box — `panel.getSize()` inside a commit report reads the
  // DOM a commit early.
  const groupElementRef = useRef<HTMLDivElement | null>(null);

  const groupElement = useCallback((element: HTMLDivElement | null) => {
    groupElementRef.current = element;
  }, []);
  // The one automatic open has fired; a signal can never steal focus twice.

  const autoOpenedRef = useRef(false);
  // A decided layout waiting for the group's first committed pass — writes
  // issued before it are recomputed against a zero-size group and dropped.
  const pendingDecisionRef = useRef<InspectorTarget | null>(null);
  // The group has committed a layout at least once (an emission proves a
  // measured pass ran), so imperative writes land.
  const groupMeasuredRef = useRef(false);
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const desktopPanelsRef = useRef(desktopPanels);
  desktopPanelsRef.current = desktopPanels;
  const prevWorkspaceRef = useRef(workspace);
  const widePanelsRef = useRef(widePanels);

  // A desktop↔mobile swap remounts the group: its fresh first pass has not
  // run yet, so a parked write stays parked until the emission proves it.
  const prevDesktopRef = useRef(desktopPanels);

  if (prevDesktopRef.current !== desktopPanels) {
    prevDesktopRef.current = desktopPanels;
    groupMeasuredRef.current = false;
  }

  widePanelsRef.current = widePanels;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const worthShowingRef = useRef(worthShowing);
  worthShowingRef.current = worthShowing;
  const widthPxRef = useRef(widthPx);
  widthPxRef.current = widthPx;

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

  const markReady = useCallback(() => setReady(true), []);

  const persistWidth = useCallback((nextWidth: number) => {
    const account = accountKeyRef.current;

    if (account === null || !widePanelsRef.current) return;
    writeInspectorWidth(account, nextWidth);
  }, []);

  const persistChoice = useCallback((open: boolean) => {
    const account = accountKeyRef.current;
    const ws = workspaceRef.current;

    if (account === null || ws === undefined || !widePanelsRef.current) return;
    writeInspectorChoice(account, ws, open);
  }, []);

  // Issue the one imperative write a decided layout needs, or park it until
  // the group's first committed pass. No-op targets are skipped by read-back:
  // a write that changes nothing would leave a marker no emission consumes.
  const applyDecision = useCallback((target: InspectorTarget) => {
    const panel = panelRef.current;

    if (!groupMeasuredRef.current || panel === null) {
      pendingDecisionRef.current = target;

      return;
    }

    const holding = target.collapsed
      ? panel.isCollapsed()
      : !panel.isCollapsed() && Math.abs(panel.getSize().inPixels - target.widthPx) <= 3;

    if (holding) {
      markReady();

      return;
    }

    expectedLayoutRef.current = { ...target };

    if (target.collapsed) panel.collapse();
    else panel.resize(target.widthPx);

    markReady();
  }, [panelRef, markReady]);

  // The workspace's decision, re-decided when the account arrives or the
  // workspace under the column changes. A user's own gesture while the
  // account was still resolving wins outright — the decision is skipped, the
  // stored choice (if any) is left for the next visit to read.
  useLayoutEffect(() => {
    if (prevWorkspaceRef.current !== workspace) {
      prevWorkspaceRef.current = workspace;
      userDecidedRef.current = false;
      autoOpenedRef.current = false;
      policyOwnsRef.current = null;
      pendingDecisionRef.current = null;
      setReady(false);
    }

    if (!desktopPanels || !widePanels || accountKey === null || userDecidedRef.current) return;

    const width = readInspectorWidth(accountKey) ?? INSPECTOR_DEFAULT_PX;
    const choice = readInspectorChoice(accountKey, workspace);

    if (choice !== null) {
      const target: InspectorTarget = { collapsed: !choice, widthPx: width };
      widthPxRef.current = target.widthPx;
      setWidthPx(target.widthPx);
      collapsedRef.current = target.collapsed;
      setCollapsed(target.collapsed);
      applyDecision(target);

      return;
    }

    if (worthShowingRef.current) {
      policyOwnsRef.current = "open";
      autoOpenedRef.current = true;
      collapsedRef.current = false;
      setCollapsed(false);
      applyDecision({ collapsed: false, widthPx: width });

      return;
    }

    policyOwnsRef.current = "closed";
    collapsedRef.current = true;
    setCollapsed(true);
    applyDecision({ collapsed: true, widthPx: width });
  }, [desktopPanels, widePanels, accountKey, workspace, applyDecision]);

  // The one automatic open: the workspace produced something worth seeing
  // after the column had already settled closed under the policy. Only a
  // policy-closed column is eligible — a stored choice or a user's own
  // gesture is never reopened by an arrival.
  useLayoutEffect(() => {
    if (!worthShowing || autoOpenedRef.current || policyOwnsRef.current !== "closed"
      || userDecidedRef.current) {
      return;
    }

    policyOwnsRef.current = "open";
    autoOpenedRef.current = true;
    collapsedRef.current = false;
    setCollapsed(false);
    applyDecision({ collapsed: false, widthPx: widthPxRef.current });
  }, [worthShowing, applyDecision]);

  const collapse = useCallback(() => {
    userDecidedRef.current = true;
    policyOwnsRef.current = null;
    const panel = panelRef.current;
    const width = panel?.getSize().inPixels ?? 0;

    if (width >= 1) {
      const rounded = Math.max(INSPECTOR_MIN_PX, Math.round(width));
      widthPxRef.current = rounded;
      setWidthPx(rounded);
      persistWidth(rounded);
    }

    expectedLayoutRef.current = { collapsed: true, widthPx: widthPxRef.current };
    collapsedRef.current = true;
    setCollapsed(true);
    persistChoice(false);
    panel?.collapse();
  }, [panelRef, persistWidth, persistChoice]);

  const expand = useCallback(() => {
    userDecidedRef.current = true;
    policyOwnsRef.current = null;
    const width = widthPxRef.current;
    expectedLayoutRef.current = { collapsed: false, widthPx: width };
    collapsedRef.current = false;
    setCollapsed(false);
    persistWidth(width);
    persistChoice(true);
    panelRef.current?.resize(width);
  }, [panelRef, persistWidth, persistChoice]);

  const toggleCollapsed = useCallback(() => {
    if (collapsedRef.current) expand();
    else collapse();
  }, [collapse, expand]);

  const resetToDefault = useCallback(() => {
    userDecidedRef.current = true;
    policyOwnsRef.current = null;
    widthPxRef.current = INSPECTOR_DEFAULT_PX;
    expectedLayoutRef.current = { collapsed: false, widthPx: INSPECTOR_DEFAULT_PX };
    persistWidth(INSPECTOR_DEFAULT_PX);
    persistChoice(true);
    collapsedRef.current = false;
    setCollapsed(false);
    setWidthPx(INSPECTOR_DEFAULT_PX);
    panelRef.current?.resize(INSPECTOR_DEFAULT_PX);
  }, [panelRef, persistWidth, persistChoice]);

  // Every committed layout reports here exactly once — the mount pass, a
  // pointer release, a keyboard step, or a write the hook itself issued.
  // Matching `expectedLayout` marks it an echo: the column's React state
  // catches up and nothing persists. Anything else is a user gesture, and a
  // gesture while the policy still owns a COLLAPSED column is the manual
  // launch — the workspace's choice is written and the policy hands over.
  const onLayoutChanged = useCallback((layout: Layout) => {
    // The mobile group's pane emissions are not column decisions: nothing
    // they report is persisted or reflected.
    if (!desktopPanelsRef.current) return;

    const share = layout[INSPECTOR_PANEL_ID];
    const collapsedNow = share !== undefined && share <= 0;

    const now: InspectorTarget = {
      collapsed: collapsedNow,
      widthPx: collapsedNow ? 0 : Math.max(INSPECTOR_MIN_PX, committedWidthPx(layout, groupElementRef.current,
        () => Math.round(panelRef.current?.getSize().inPixels ?? 0))),
    };

    groupMeasuredRef.current = true;

    const expected = expectedLayoutRef.current;

    if (expected !== null && expected.collapsed === now.collapsed
      && (now.collapsed || Math.abs(now.widthPx - expected.widthPx) <= 3)) {
      collapsedRef.current = now.collapsed;
      setCollapsed(now.collapsed);

      if (!now.collapsed) {
        widthPxRef.current = now.widthPx;
        setWidthPx(now.widthPx);
      }

      const pending = pendingDecisionRef.current;
      pendingDecisionRef.current = null;

      if (pending !== null) applyDecision(pending);

      return;
    }

    // A gesture: the column is the user's from here on — a decision still
    // parked for the first pass dies with it, never written over the hand.
    userDecidedRef.current = true;
    policyOwnsRef.current = null;
    pendingDecisionRef.current = null;
    collapsedRef.current = now.collapsed;
    setCollapsed(now.collapsed);
    expectedLayoutRef.current = { ...now };

    if (!now.collapsed) {
      widthPxRef.current = now.widthPx;
      setWidthPx(now.widthPx);
      persistWidth(now.widthPx);
    }

    persistChoice(!now.collapsed);
    markReady();
  }, [panelRef, applyDecision, persistWidth, persistChoice, markReady]);

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

  const groupProps: InspectorGroupProps = desktopPanels
    ? {
      // The group applies the decided mount layout in its own first pass —
      // an imperative collapse could be clobbered by that pass, this cannot.
      defaultLayout: mountDecision !== null && mountDecision.collapsed
        ? { [CHAT_PANEL_ID]: 1, [INSPECTOR_PANEL_ID]: 0 }
        : undefined,
      onLayoutChanged,
      elementRef: groupElement,
    }
    : { defaultLayout: undefined, onLayoutChanged, elementRef: groupElement };

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
