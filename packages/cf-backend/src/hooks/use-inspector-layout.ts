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
  INSPECTOR_DEFAULT_PX, INSPECTOR_MIN_PX, INSPECTOR_WIDE_QUERY, UNKEYED_INSPECTOR_LAYOUT,
  applyInspectorDecision, claimInspectorTarget, commitInspectorLayout, initialInspectorState,
  decideInspector, isInspectorInputKey, newInspectorGroup, readStoredInspector,
  type InspectorAccount, type InspectorEffects, type InspectorState, type InspectorTarget,
  type StoredInspectorLayout,
} from "@kinu.run/core/web/inspector-layout";

/** The panel element ids, which the library writes onto the DOM: one document
 *  may hold more than one workbench (the landing page mounts three sample
 *  frames), so a group past the first names its panels under its own scope. */
const panelId = (panel: "chat" | "inspector", scope: string | undefined): string => (
  scope === undefined ? panel : `${panel}-${scope}`
);

/** The account that keys a persisted layout, resolved once per page: a
 *  signed-in profile with an email keys one, a profile with no email keys
 *  nothing, and a profile that could not be read is a session-only layout.
 *  Each of the three is an ANSWER — the absence of one is the pending promise,
 *  never a resolved value. */
let readAccountKeyCache: Promise<InspectorAccount> | null = null;

function readAccountKey(): Promise<InspectorAccount> {
  return (readAccountKeyCache ??= getProfile().then(
    (profile): InspectorAccount => (profile?.email ? { kind: "known", email: profile.email } : { kind: "none" }),
    (): InspectorAccount => ({ kind: "unreadable" }),
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
  layout: Layout, panel: string, group: HTMLDivElement | null, fallback: () => number,
): number {
  const share = layout[panel];

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
  readonly resetToDefault: () => void;
  readonly ready: boolean;
  readonly panelRef: RefObject<PanelImperativeHandle | null>;
  readonly panelProps: InspectorPanelProps;
  readonly groupProps: InspectorGroupProps;
  readonly separatorProps: InspectorSeparatorProps;
  /** The id the chat panel takes in this group. The layout the group reports
   *  is keyed by panel id, so the two ids have one source. */
  readonly chatPanelId: string;
}

export function useInspectorLayout(input: {
  readonly desktopPanels: boolean;
  readonly mobileDefault: string;
  readonly workspace: string | undefined;
  /** Scopes this group's panel element ids; `undefined` for the app's one workbench. */
  readonly scope: string | undefined;
  /** The workspace holds something the inspector exists to show. Only
   *  consulted while this workspace carries no stored open/close choice. */
  readonly worthShowing: boolean;
}): InspectorLayout {
  const { desktopPanels, mobileDefault, workspace, scope, worthShowing } = input;
  const chatPanelId = panelId("chat", scope);
  const inspectorPanelId = panelId("inspector", scope);

  const widePanels = useMediaQuery(INSPECTOR_WIDE_QUERY);

  // A workbench with no workspace name is nobody's layout: the account shelf
  // is neither read nor written for it, and the policy decides it on every
  // mount. A sample frame must show what a first visit shows, and must not
  // key the reader's own app layout to whatever it displays.
  const keyed = workspace !== undefined;

  // `null` is "the account has not resolved yet", and nothing else: a session
  // resolved to NO account is a layout the policy decides and nothing
  // persists. Read as one value, an anonymous session was never decided at
  // all and its column stayed behind the expand handle for the page's life.
  // The cached email is the last visit's answer, so the first paint can use
  // this person's width before the profile read returns.
  const [account, setAccount] = useState<InspectorAccount | null>(() => {
    const cached = keyed ? localStorage.getItem("kinu.inspector.account") : null;

    return cached === null ? null : { kind: "known", email: cached };
  });

  useEffect(() => {
    if (!keyed) return;
    let live = true;

    startTransition(async () => {
      const resolved = await readAccountKey();

      if (!live) return;

      if (resolved.kind === "known") localStorage.setItem("kinu.inspector.account", resolved.email);

      // The cached account confirmed keeps its own object, so a resolve that
      // changed nothing does not re-run the decision effect.
      setAccount((prev) => (
        prev?.kind === "known" && resolved.kind === "known" && prev.email === resolved.email ? prev : resolved
      ));
    });

    return () => { live = false; };
  }, [keyed]);

  // An unkeyed layout stores nothing and yet is decided: `null` here would
  // mean "no policy at all", which leaves the column wherever it mounted for
  // the rest of the page's life.
  const readLayout = useCallback(
    (): StoredInspectorLayout | null => (
      workspace === undefined ? UNKEYED_INSPECTOR_LAYOUT : readStoredInspector(account, workspace)
    ),
    [account, workspace],
  );

  // The identity the machine latches on: a gesture made here, and the one
  // automatic open already served here. A nameless workbench needs one of its
  // own — the machine reads `undefined` as the same key an ungestured state
  // carries, so the first decision would read as "the user already chose
  // this" and nothing would ever open. Never a storage key: nothing keys
  // storage without an account, and an unkeyed layout has none.
  const identity = workspace ?? `sample:${scope ?? ""}`;

  const mountDecision = desktopPanels && widePanels ? decideInspector(readLayout(), worthShowing) : null;

  // ── Owned state ────────────────────────────────────────────────────────
  // The machine (core `web/inspector-layout.ts`) decides; this hook applies.
  // Its state lives in a ref so a commit report and a control action read
  // the step before them, never a render behind; the three fields a render
  // needs are mirrored into React state after each step.
  const machineRef = useRef<InspectorState>(initialInspectorState(mountDecision));
  const [collapsed, setCollapsed] = useState(machineRef.current.collapsed);
  const [widthPx, setWidthPx] = useState(machineRef.current.widthPx);
  const [ready, setReady] = useState(false);
  const panelRef = usePanelRef();
  // The input mark: set only by a separator capture listener where the
  // user's act begins — never by a control action, which already knows its
  // target and claims it directly. A press that produced nothing is cleared
  // by the releasing event's zero-delay timeout, so it can never leak onto
  // a later environment commit.
  const inputRef = useRef<InspectorInput | null>(null);
  // The group element: committed px read as the inspector's flex share of its
  // measured box, and where the commit count is written.
  const groupElementRef = useRef<HTMLDivElement | null>(null);
  // How many committed layouts have reported: written onto the group element
  // imperatively so a reader can wait for a commit to have been classified —
  // the one end condition for "this commit persisted nothing" — without a
  // render per commit.
  const commitsRef = useRef(0);

  const persist = useCallback((target: InspectorTarget) => {
    if (account?.kind !== "known" || !widePanels) return;
    localStorage.setItem(`kinu.inspector.${account.email}`, String(target.widthPx));

    if (workspace !== undefined) localStorage.setItem(`kinu.inspector.open.${account.email}.${workspace}`, target.collapsed ? "0" : "1");
  }, [account, workspace, widePanels]);

  // One step of the machine, applied: the state mirrored, the effects done.
  // The one place imperative writes leave the hook; a write marks no input,
  // so whatever commit it produces lands in the adopt branch.
  const apply = useCallback((step: { readonly state: InspectorState; readonly effects: InspectorEffects }) => {
    machineRef.current = step.state;
    setCollapsed(step.state.collapsed);
    setWidthPx(step.state.widthPx);
    setReady(step.state.ready);

    if (step.effects.persist !== undefined) persist(step.effects.persist);
    const write = step.effects.write;
    const panel = panelRef.current;

    if (write === undefined || panel === null) return;

    if (write.collapsed) panel.collapse();
    else panel.resize(write.widthPx);
  }, [panelRef, persist]);

  // The workspace's layout, decided and applied in one place: on mount, on a
  // workspace switch, when the account key lands, and on the signal that
  // opens a policy-closed column once on the workspace's behalf.
  useLayoutEffect(() => {
    if (!desktopPanels || !widePanels) return;

    apply(applyInspectorDecision(machineRef.current, {
      workspace: identity, stored: readLayout(), worthShowing, panelPresent: panelRef.current !== null,
    }));
  }, [readLayout, identity, worthShowing, desktopPanels, widePanels, panelRef, apply]);

  const claim = useCallback((target: InspectorTarget) => {
    apply(claimInspectorTarget(machineRef.current, target, identity));
  }, [apply, identity]);

  const collapse = useCallback(() => {
    const width = panelRef.current?.getSize().inPixels ?? 0;
    const rounded = width >= 1 ? Math.max(INSPECTOR_MIN_PX, Math.round(width)) : machineRef.current.widthPx;

    claim({ collapsed: true, widthPx: rounded });
  }, [panelRef, claim]);

  const expand = useCallback(() => {
    claim({ collapsed: false, widthPx: machineRef.current.widthPx });
  }, [claim]);

  const toggleCollapsed = useCallback(() => {
    if (machineRef.current.collapsed) expand();
    else collapse();
  }, [collapse, expand]);

  const resetToDefault = useCallback(() => {
    claim({ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX });
  }, [claim]);

  // Every committed layout reports here exactly once, and the classification
  // is the input mark, not a layout match: a report carrying a mark is the
  // user's; anything else — mount, a decision the hook issued, a
  // ResizeObserver constraint — is adopted without persisting.
  const onLayoutChanged = useCallback((layout: Layout) => {
    if (!desktopPanels) return;

    commitsRef.current += 1;
    groupElementRef.current?.setAttribute("data-inspector-commits", String(commitsRef.current));

    const share = layout[inspectorPanelId];
    const collapsedNow = share !== undefined && share <= 0;

    const now: InspectorTarget = {
      // A collapsed report carries no width of its own: the remembered
      // expansion width is the last open one, never zero.
      collapsed: collapsedNow,
      widthPx: collapsedNow ? machineRef.current.widthPx : Math.max(INSPECTOR_MIN_PX, committedWidthPx(
        layout, inspectorPanelId, groupElementRef.current,
        () => Math.round(panelRef.current?.getSize().inPixels ?? 0),
      )),
    };

    const input = inputRef.current;
    inputRef.current = null;

    apply(commitInspectorLayout(machineRef.current, {
      now, marked: input !== null, workspace: identity, panelPresent: panelRef.current !== null,
    }));
  }, [desktopPanels, inspectorPanelId, panelRef, identity, apply]);

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
      id: inspectorPanelId,
      minSize: `${String(INSPECTOR_MIN_PX)}px`,
      defaultSize: `${String(widthPx)}px`,
      collapsible: true,
      collapsedSize: "0px",
      panelRef,
      className: collapsed ? "overflow-hidden" : undefined,
    }
    : { id: inspectorPanelId, minSize: "0%", defaultSize: mobileDefault };

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
    machineRef.current = newInspectorGroup(machineRef.current);
  }, []);

  const groupProps: InspectorGroupProps = {
    // The group applies the decided mount layout in its own first pass — an
    // imperative collapse could be clobbered by that pass, this cannot.
    defaultLayout: mountDecision?.collapsed === true
      ? { [chatPanelId]: 1, [inspectorPanelId]: 0 }
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
    resetToDefault,
    ready,
    panelRef,
    panelProps,
    groupProps,
    separatorProps,
    chatPanelId,
  };
}
