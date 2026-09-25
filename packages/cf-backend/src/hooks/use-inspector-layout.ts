/**
 * Commits are classified by input, not layout matching: an emission carrying an input mark
 * is a gesture and persists; any other (mount, own decision, ResizeObserver) is adopted unpersisted.
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

/** One document may hold several workbenches (landing mounts three), so later groups scope their panel ids. */
const panelId = (panel: "chat" | "inspector", scope: string | undefined): string => (
  scope === undefined ? panel : `${panel}-${scope}`
);

/** Each of the three resolutions is an answer; only the pending promise means "unknown". */
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

/** `disableDoubleClick`: `resetToDefault` is the one reset, not the library's dblclick. */
export interface InspectorSeparatorProps {
  readonly elementRef: (element: HTMLDivElement | null) => void;
  readonly disableDoubleClick: boolean;
}

export interface InspectorGroupProps {
  readonly defaultLayout: Layout | undefined;
  readonly onLayoutChanged: (layout: Layout) => void;
  readonly elementRef: (element: HTMLDivElement | null) => void;
}

/** Flex share × measured group box: `getSize()` inside a commit report reads the DOM a commit early. */
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

interface InspectorInput { readonly kind: "pointer" | "key" }

export interface InspectorLayout {
  readonly widthPx: number;
  readonly collapsed: boolean;
  readonly onLayoutChanged: (layout: Layout) => void;
  readonly toggleCollapsed: () => void;
  /** Opens a collapsed inspector as the reader's own choice; an open one keeps the width they gave it. */
  readonly reveal: () => void;
  readonly resetToDefault: () => void;
  readonly ready: boolean;
  readonly panelRef: RefObject<PanelImperativeHandle | null>;
  readonly panelProps: InspectorPanelProps;
  readonly groupProps: InspectorGroupProps;
  readonly separatorProps: InspectorSeparatorProps;
  /** The group's layout is keyed by panel id, so the two ids share one source. */
  readonly chatPanelId: string;
}

export function useInspectorLayout(input: {
  readonly desktopPanels: boolean;
  readonly mobileDefault: string;
  readonly workspace: string | undefined;
  readonly scope: string | undefined;
  /** Only consulted while this workspace carries no stored open/close choice. */
  readonly needsUser: boolean;
}): InspectorLayout {
  const { desktopPanels, mobileDefault, workspace, scope, needsUser } = input;
  const chatPanelId = panelId("chat", scope);
  const inspectorPanelId = panelId("inspector", scope);

  const widePanels = useMediaQuery(INSPECTOR_WIDE_QUERY);

  // A nameless workbench (sample frame) neither reads nor writes the account shelf.
  const keyed = workspace !== undefined;

  // `null` means only "not resolved yet"; a session resolved to no account is still decided.
  // The cached email lets first paint use this person's width before the profile read returns.
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

      // Keep the cached object when unchanged so the decision effect does not re-run.
      setAccount((prev) => (
        prev?.kind === "known" && resolved.kind === "known" && prev.email === resolved.email ? prev : resolved
      ));
    });

    return () => { live = false; };
  }, [keyed]);

  // An unkeyed layout stores nothing yet is still decided; `null` would mean no policy at all.
  const readLayout = useCallback(
    (): StoredInspectorLayout | null => (
      workspace === undefined ? UNKEYED_INSPECTOR_LAYOUT : readStoredInspector(account, workspace)
    ),
    [account, workspace],
  );

  // A nameless workbench needs its own identity: the machine reads `undefined` as the ungestured
  // key, so the first decision would read as a user choice and nothing would open.
  const identity = workspace ?? `sample:${scope ?? ""}`;

  const mountDecision = desktopPanels && widePanels ? decideInspector(readLayout(), needsUser) : null;

  // State lives in a ref so commit reports and control actions read the latest step, not a
  // render behind; render-facing fields are mirrored into React state.
  const machineRef = useRef<InspectorState>(initialInspectorState(mountDecision));
  const [collapsed, setCollapsed] = useState(machineRef.current.collapsed);
  const [widthPx, setWidthPx] = useState(machineRef.current.widthPx);
  const [ready, setReady] = useState(false);
  const panelRef = usePanelRef();
  // Set only by separator capture listeners, never by control actions; a press producing nothing
  // is cleared by a zero-delay timeout so it cannot leak onto a later environment commit.
  const inputRef = useRef<InspectorInput | null>(null);
  const groupElementRef = useRef<HTMLDivElement | null>(null);
  // Written onto the group element imperatively so a reader can wait for a commit to be
  // classified without a render per commit.
  const commitsRef = useRef(0);

  const persist = useCallback((target: InspectorTarget) => {
    if (account?.kind !== "known" || !widePanels) return;
    localStorage.setItem(`kinu.inspector.${account.email}`, String(target.widthPx));

    if (workspace !== undefined) localStorage.setItem(`kinu.inspector.open.${account.email}.${workspace}`, target.collapsed ? "0" : "1");
  }, [account, workspace, widePanels]);

  // Imperative writes mark no input, so their commits land in the adopt branch.
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

  useLayoutEffect(() => {
    if (!desktopPanels || !widePanels) return;

    apply(applyInspectorDecision(machineRef.current, {
      workspace: identity, stored: readLayout(), needsUser, panelPresent: panelRef.current !== null,
    }));
  }, [readLayout, identity, needsUser, desktopPanels, widePanels, panelRef, apply]);

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

  const reveal = useCallback(() => {
    if (machineRef.current.collapsed) expand();
  }, [expand]);

  const resetToDefault = useCallback(() => {
    claim({ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX });
  }, [claim]);

  const onLayoutChanged = useCallback((layout: Layout) => {
    if (!desktopPanels) return;

    commitsRef.current += 1;
    groupElementRef.current?.setAttribute("data-inspector-commits", String(commitsRef.current));

    const share = layout[inspectorPanelId];
    const collapsedNow = share !== undefined && share <= 0;

    const now: InspectorTarget = {
      // A collapsed report carries no width: the remembered expansion width is the last open one.
      collapsed: collapsedNow,
      widthPx: collapsedNow ? machineRef.current.widthPx : Math.max(INSPECTOR_MIN_PX, committedWidthPx(
        layout, inspectorPanelId, groupElementRef.current,
        () => Math.round(panelRef.current?.getSize().inPixels ?? 0),
      )),
    };

    const mark = inputRef.current;
    inputRef.current = null;

    apply(commitInspectorLayout(machineRef.current, {
      now, marked: mark !== null, workspace: identity, panelPresent: panelRef.current !== null,
    }));
  }, [desktopPanels, inspectorPanelId, panelRef, identity, apply]);

  // Capture phase runs before the library's bubble keydown and document pointer handlers, and the
  // commit reports synchronously in the same dispatch, so the mark is always there to read.
  const separatorDetachRef = useRef<(() => void) | null>(null);
  // Detach cancels a pending clear so it cannot erase the next mount's mark.
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

    // No dblclick mark: the separator is disableDoubleClick and `resetToDefault` is a control action.
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

  // Ref callbacks run in the mutation phase, before the library's commit, so a new element resets
  // measurement first. Detach passes through null; only a different element means a new tree.
  const groupRef = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;

    if (element === groupElementRef.current) return;

    groupElementRef.current = element;
    machineRef.current = newInspectorGroup(machineRef.current);
  }, []);

  const groupProps: InspectorGroupProps = {
    // Applied in the group's own first pass: an imperative collapse could be clobbered by that pass.
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
    reveal,
    resetToDefault,
    ready,
    panelRef,
    panelProps,
    groupProps,
    separatorProps,
    chatPanelId,
  };
}
