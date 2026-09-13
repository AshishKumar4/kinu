/**
 * The inspector column's layout policy: a per-account persisted WIDTH and a
 * per-WORKSPACE persisted open/close choice, classified by INPUT, not by
 * layout matching.
 *
 * User input is marked at its source — capture-phase listeners on the
 * separator for the keys the library handles (arrows, Home, End, Enter), for
 * pointer presses, and for double-click; the column's own affordances mark
 * themselves. A committed layout then classifies in one branch: an emission
 * carrying an input mark is a gesture and persists; any other emission —
 * mount, a decision the hook itself issued, a ResizeObserver constraint —
 * is adopted into state without persisting. Nothing ever compares a
 * committed layout to a remembered one, so a write that changes nothing and
 * a constraint that changes everything both classify correctly.
 */

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  usePanelRef,
  type Layout,
  type PanelImperativeHandle,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";
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
/** The props the separator gets: `elementRef` is where the input listeners
 *  live, and `disableDoubleClick` keeps the library's own dblclick-to-default
 *  out of the way so `resetToDefault` is the one reset. The page layers its
 *  own Enter/dblclick affordances on top. */

export type InspectorSeparatorProps = Pick<SeparatorProps, "elementRef" | "disableDoubleClick">;

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

/** The keys the library's separator keydown acts on — the marks these press
 *  leave are what the committed layout's classification reads. */
const INSPECTOR_INPUT_KEYS = {
  ArrowLeft: true, ArrowRight: true, Home: true, End: true, Enter: true,
} satisfies Record<string, true>;

function isInspectorInputKey(key: string): boolean {
  return Object.hasOwn(INSPECTOR_INPUT_KEYS, key);
}

/** Where a committed layout came from: an input observed at its source. */
interface InspectorInput { readonly kind: "pointer" | "key" }

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
  readonly separatorProps: InspectorSeparatorProps;
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

  // ── Owned state ────────────────────────────────────────────────────────
  // The input mark: set by a listener where the user's act begins (the
  // separator's capture listeners, or an affordance about to write), consumed
  // by the committed layout it produces. A press that produced nothing is
  // cleared by the releasing event's zero-delay timeout, so it can never
  // leak onto a later environment commit.
  const inputRef = useRef<InspectorInput | null>(null);
  // The workspace the user has gestured on, and the workspace the one
  // automatic open already served — comparing the id is the per-workspace
  // flag, so a gesture or a second signal in another workspace is its own.
  const userDecidedRef = useRef<string | null>(null);
  const autoOpenedRef = useRef<string | null>(null);
  // The group element: committed px read as the inspector's flex share of its
  // measured box.
  const groupElementRef = useRef<HTMLDivElement | null>(null);
  // A decision made before the group's first committed pass — a write issued
  // into an unmeasured group is recomputed against a zero-size box and lost,
  // so the slot waits for the first emission, which applies it once. This is
  // not a loop: the library's own commit is the schedule, and a gesture that
  // lands first clears the slot and wins.
  const pendingDecisionRef = useRef<InspectorTarget | null>(null);
  // The group has committed a layout at least once, so imperative writes land.
  const groupMeasuredRef = useRef(false);
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


  // A layout the user now owns: reflected into state, persisted as theirs,
  // latched so no policy transition ever crosses it in this workspace.
  const claim = useCallback((target: InspectorTarget) => {
    userDecidedRef.current = workspace ?? null;
    setCollapsed(target.collapsed);
    setWidthPx(target.widthPx);
    persistWidth(target.widthPx);
    persistChoice(!target.collapsed);
  }, [workspace, persistWidth, persistChoice]);

  // The one place imperative writes leave the hook. Control actions already
  // know their target — `claim` persisted it at call time — so the write
  // marks no input; whatever emission it produces (or none, for a no-op)
  // lands in the adopt branch like any other non-input commit.
  const issueWrite = useCallback((target: InspectorTarget) => {
    const panel = panelRef.current;

    if (panel === null) return;

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
    // it, so measurement and the parked slot belong to the previous tree.
    if (groupModeRef.current !== desktopPanels) {
      groupModeRef.current = desktopPanels;
      groupMeasuredRef.current = false;
      pendingDecisionRef.current = null;
    }

    if (!desktopPanels || !widePanels || userDecidedRef.current === workspace) return;

    const target = readDecision(account, workspace,
      worthShowing || autoOpenedRef.current === workspace);

    if (worthShowing && account !== null
      && readInspectorChoice(account, workspace) === null) {
      autoOpenedRef.current = workspace ?? null;
    }

    // Already where the decision lands: nothing writes, and the column is
    // still marked ready — the stored state stands.
    if (collapsed === target.collapsed
      && (target.collapsed || widthPx === target.widthPx)) {
      setReady(true);

      return;
    }

    if (!groupMeasuredRef.current || panelRef.current === null) {
      pendingDecisionRef.current = target;

      return;
    }

    setCollapsed(target.collapsed);
    setWidthPx(target.widthPx);
    setReady(true);

    if (target.collapsed) panelRef.current.collapse();
    else panelRef.current.resize(target.widthPx);
  }, [account, workspace, worthShowing, desktopPanels, widePanels, collapsed, widthPx, panelRef]);

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

  // Every committed layout reports here exactly once, and the classification
  // is the input mark, not a layout match: a report carrying a mark is the
  // user's (claim it); anything else — mount, a decision the hook issued, a
  // ResizeObserver constraint — is adopted without persisting.
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
      setCollapsed(now.collapsed);

      if (!now.collapsed) setWidthPx(now.widthPx);

      setReady(true);

      // A decision parked for this pass applies now, once — the single write
      // the unmeasured group could not take. A parked decision is the
      // hook's, not a gesture, so its write marks nothing for input.
      const pending = pendingDecisionRef.current;
      pendingDecisionRef.current = null;

      if (pending !== null) {
        setCollapsed(pending.collapsed);
        setWidthPx(pending.widthPx);
        setReady(true);

        const panel = panelRef.current;

        if (panel !== null) {
          if (pending.collapsed) panel.collapse();
          else panel.resize(pending.widthPx);
        }
      }

      return;
    }

    const input = inputRef.current;
    inputRef.current = null;

    if (input !== null) {
      // A gesture: the column is the user's — anything still parked dies with it.
      pendingDecisionRef.current = null;
      claim(now);
      setReady(true);

      return;
    }

    // Environment or our own commit: adopt what landed, persist nothing.
    setCollapsed(now.collapsed);

    if (!now.collapsed) setWidthPx(now.widthPx);
  }, [desktopPanels, panelRef, widthPx, claim]);

  // The separator's own listeners mark user input where it starts. Capture
  // phase on the element runs before the library's bubble-phase keydown and
  // its document-level pointer handlers act, and the committed layout they
  // produce reports synchronously inside the same dispatch — the mark is
  // always there to read. Pointer clears on pointerup/pointercancel/
  // lostpointercapture; keys clear on a zero-delay timeout scheduled inside
  // the same keydown. The ref callback removes every listener it added —
  // element and document both — when the separator unmounts, so a
  // desktop↔mobile remount can never stack them.
  const separatorDetachRef = useRef<(() => void) | null>(null);

  const separatorRef = useCallback((element: HTMLDivElement | null) => {
    separatorDetachRef.current?.();
    separatorDetachRef.current = null;

    if (element === null) return;

    const clear = () => { setTimeout(() => { inputRef.current = null; }, 0); };

    const onPointerDown = () => { inputRef.current = { kind: "pointer" }; };

    const onPointerDone = clear;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isInspectorInputKey(event.key)) return;

      inputRef.current = { kind: "key" };
      clear();
    };
    // No dblclick mark: the separator is disableDoubleClick, and the page's
    // own onDoubleClick drives `resetToDefault` — a control action.

    const ownerDocument = element.ownerDocument;

    element.addEventListener("pointerdown", onPointerDown, true);
    element.addEventListener("pointerup", onPointerDone, true);
    element.addEventListener("pointercancel", onPointerDone, true);
    element.addEventListener("lostpointercapture", onPointerDone, true);
    element.addEventListener("keydown", onKeyDown, true);
    ownerDocument.addEventListener("pointerup", onPointerDone, true);
    ownerDocument.addEventListener("pointercancel", onPointerDone, true);

    separatorDetachRef.current = () => {
      element.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerup", onPointerDone, true);
      element.removeEventListener("pointercancel", onPointerDone, true);
      element.removeEventListener("lostpointercapture", onPointerDone, true);
      element.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("pointerup", onPointerDone, true);
      ownerDocument.removeEventListener("pointercancel", onPointerDone, true);
    };
  }, []);

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

  const separatorProps: InspectorSeparatorProps = {
    elementRef: separatorRef,
    disableDoubleClick: true,
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
    separatorProps,
  };
}
