/**
 * The inspector column's layout policy: a per-account persisted WIDTH and a
 * per-WORKSPACE persisted open/close choice, classified by INPUT, not by
 * layout matching.
 *
 * User input is marked at its source — capture-phase listeners on the
 * separator for the keys the library handles (arrows, Home, End, Enter)
 * and for pointer presses; control actions (collapse, expand, toggle,
 * reset) claim their target directly at call time and write unmarked.
 * A committed layout then classifies in one branch: an emission
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
} from "react-resizable-panels";
import { getProfile } from "@/lib/user-api";
import { useMediaQuery } from "./use-media-query";

import {
  INSPECTOR_DEFAULT_PX, INSPECTOR_MIN_PX, INSPECTOR_WIDE_QUERY,
  isInspectorInputKey, readDecision, readInspectorChoice,
  type InspectorTarget,
} from "./inspector-policy";

const CHAT_PANEL_ID = "chat";

const INSPECTOR_PANEL_ID = "inspector";

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

/** The props the separator gets: `elementRef` attaches the input listeners,
 *  and `disableDoubleClick` keeps the library's own dblclick-to-default out
 *  of the way so `resetToDefault` is the one reset. The page layers its own
 *  Enter/dblclick affordances on top. */
export interface InspectorSeparatorProps {
  readonly elementRef: (element: HTMLDivElement | null) => void;
  readonly disableDoubleClick: boolean;
}

export interface InspectorGroupProps {
  readonly defaultLayout: Layout | undefined;
  readonly onLayoutChanged: (layout: Layout) => void;
  readonly elementRef: (element: HTMLDivElement | null) => void;
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
  /** How many committed layouts have reported to `onLayoutChanged`. Rendered
   *  onto the panel so a reader can wait for a commit to have been classified
   *  — the one end condition for "this commit persisted nothing" — instead of
   *  watching a clock for a write that must never come. */
  readonly layoutCommits: number;
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

  const widePanels = useMediaQuery(INSPECTOR_WIDE_QUERY);

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
  const [layoutCommits, setLayoutCommits] = useState(0);
  const panelRef = usePanelRef();

  // ── Owned state ────────────────────────────────────────────────────────
  // The input mark: set only by a separator capture listener where the
  // user's act begins — never by a control action, which already knows its
  // target and claims it directly. A press that produced nothing is cleared
  // by the releasing event's zero-delay timeout, so it can never leak onto
  // a later environment commit.
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
    setLayoutCommits((count) => count + 1);

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
  // element and document both — and retires any pending clear when the
  // separator unmounts, so a remount can never stack listeners or let a
  // stale timer erase the new mount's mark.
  const separatorDetachRef = useRef<(() => void) | null>(null);
  // The one scheduled clear in flight — a fresh press replaces it, and
  // detach cancels it outright rather than letting it land on the next
  // mount's mark.
  const pendingClearRef = useRef<NodeJS.Timeout | null>(null);

  const separatorRef = useCallback((element: HTMLDivElement | null) => {
    separatorDetachRef.current?.();
    separatorDetachRef.current = null;

    if (pendingClearRef.current !== null) {
      clearTimeout(pendingClearRef.current);
      pendingClearRef.current = null;
    }

    if (element === null) {
      inputRef.current = null;

      return;
    }

    const clear = () => {
      clearTimeout(pendingClearRef.current ?? undefined);

      pendingClearRef.current = setTimeout(() => {
        pendingClearRef.current = null;
        inputRef.current = null;
      }, 0);
    };

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

  // The group element's own ref: when the element itself changes, the
  // previous tree's measurement and parked decision die with it, before the
  // new tree's first layout announcement — ref callbacks run in the
  // commit's mutation phase, ahead of every layout effect including the
  // library's own commit. Detaches reset nothing: the ref pair of a
  // re-attachment passes through null, and only a genuinely different
  // element means a new tree.
  const groupRef = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;

    if (element === groupElementRef.current) return;

    groupElementRef.current = element;
    groupMeasuredRef.current = false;
    pendingDecisionRef.current = null;
  }, []);

  const groupProps: InspectorGroupProps = {
    // The group applies the decided mount layout in its own first pass — an
    // imperative collapse could be clobbered by that pass, this cannot.
    defaultLayout: mountDecision?.collapsed === true
      ? { [CHAT_PANEL_ID]: 1, [INSPECTOR_PANEL_ID]: 0 }
      : undefined,
    onLayoutChanged,
    elementRef: groupRef,
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
    layoutCommits,
    panelRef,
    panelProps,
    groupProps,
    separatorProps,
  };
}
