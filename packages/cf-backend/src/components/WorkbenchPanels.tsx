/**
 * The workbench's two columns: the conversation on the left, the inspector on
 * the right, with the separator between them and the reopen handle on the
 * shell's own edge. One mount owns the column policy — `useInspectorLayout`
 * over core's `decideInspector` — so every surface that shows the workbench
 * inherits it instead of restating it: the page at `/workspace/:agentId`, and
 * the landing page's sample frames.
 *
 * What the inspector exists to show is decided HERE, from what the workspace
 * holds. A caller that computed its own `worthShowing` would be a second
 * policy that could disagree with this one on the state that matters most —
 * the first visit, where the column is shut until the workspace has something
 * to put in it.
 *
 * Below `md` the two columns become one pane with a switch, because a phone
 * cannot show both; the group is re-keyed on that change so the library lays
 * out the new arrangement from its defaults rather than rescaling the old one.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { CaretLeftIcon } from "@phosphor-icons/react";
import type { PendingAction, PendingConsent, PinnedPreviewPort, PlanReview, SlateSummary } from "@kinu.run/core";

import { useInspectorLayout } from "@/hooks/use-inspector-layout";

/**
 * What the workspace holds right now, as far as the inspector is concerned.
 *
 * Produced outputs are deliberately absent: every command run would otherwise
 * open the pane on a fresh workspace.
 */
export interface WorkbenchContents {
  /** Decisions waiting on the owner. Also the count on the mobile switch. */
  readonly pendingActions: readonly PendingAction[];
  /** A device asking this workspace for consent. */
  readonly pendingConsents: readonly PendingConsent[];
  readonly slates: readonly SlateSummary[];
  readonly previewFocus: string | null;
  readonly pinnedPorts: readonly PinnedPreviewPort[];
  readonly activePlan: PlanReview | null;
}

export interface WorkbenchPanelsProps {
  /**
   * Keys the persisted width and open/closed choice. `undefined` for a sample
   * workbench, whose layout is nobody's preference: the policy then decides it
   * on every mount, which is what a sample must show.
   */
  readonly workspace: string | undefined;
  /**
   * Distinguishes this group's panel element ids from another workbench's in
   * the same document. The app mounts one; the landing page mounts three.
   */
  readonly scope?: string;
  readonly contents: WorkbenchContents;
  /** The conversation column's body, under its own tab strip. */
  readonly chat: ReactNode;
  /**
   * The inspector column's body. `onCollapse` is the column's own hide
   * control, absent where the column cannot collapse (a phone pane).
   */
  readonly inspector: (onCollapse: (() => void) | undefined) => ReactNode;
}

export function WorkbenchPanels({ workspace, scope, contents, chat, inspector }: WorkbenchPanelsProps) {
  const [mobilePane, setMobilePane] = useState<"chat" | "workspace">("chat");

  const [desktopPanels, setDesktopPanels] = useState(
    () => globalThis.window === undefined || globalThis.window.matchMedia("(min-width: 768px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setDesktopPanels(media.matches);
    sync();
    media.addEventListener("change", sync);

    return () => media.removeEventListener("change", sync);
  }, []);

  // What the inspector exists to show. Decided here, so no caller can hold a
  // second opinion about the first visit — the one state where the difference
  // between shut and open is the whole policy.
  const worthShowing = contents.pendingActions.length > 0
    || contents.pendingConsents.length > 0
    || contents.slates.length > 0
    || contents.previewFocus !== null
    || contents.pinnedPorts.length > 0
    || contents.activePlan !== null;

  const layout = useInspectorLayout({
    desktopPanels,
    workspace,
    scope,
    mobileDefault: mobilePane === "workspace" ? "100%" : "0%",
    worthShowing,
  });

  const waiting = contents.pendingActions.length;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b p-border p-sidebar px-3 py-2 md:hidden">
        <button type="button" onClick={() => setMobilePane("chat")} aria-pressed={mobilePane === "chat"}
          className={`rounded-full px-3 py-1.5 text-xs ${mobilePane === "chat" ? "p-accent-subtle p-accent" : "p-text-3"}`}>Chat</button>
        <button type="button" onClick={() => setMobilePane("workspace")} aria-pressed={mobilePane === "workspace"}
          className={`rounded-full px-3 py-1.5 text-xs ${mobilePane === "workspace" ? "p-accent-subtle p-accent" : "p-text-3"}`}>Workspace{waiting > 0 ? ` · ${String(waiting)}` : ""}</button>
      </div>
      <PanelGroup key={desktopPanels ? "desktop" : mobilePane} className="relative flex-1" resizeTargetMinimumSize={{ coarse: 20, fine: 10 }} {...layout.groupProps}>
        <Panel
          id={layout.chatPanelId}
          {...(desktopPanels
            ? { minSize: "24%" }
            : { minSize: "0%", defaultSize: mobilePane === "chat" ? "100%" : "0%" })}
          groupResizeBehavior="preserve-relative-size"
        >
          <div className="flex flex-col h-full border-r p-border">{chat}</div>
        </Panel>

        {desktopPanels && (
          <PanelResizeHandle
            aria-label="Resize the inspector; press Enter to hide or show it"
            title="Drag to resize the inspector · Enter hides or shows it"
            {...layout.separatorProps}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.defaultPrevented) return;

              layout.toggleCollapsed();
            }}
            onDoubleClick={layout.resetToDefault}
            className="group z-[2] -ml-[5px] w-[13px] shrink-0 cursor-col-resize bg-transparent touch-none select-none focus:outline-none"
          >
            <span aria-hidden="true" className="mx-auto block h-full w-[3px] bg-transparent transition-colors group-hover:bg-[var(--c-accent)]/60 group-focus-visible:bg-[var(--c-accent)] group-data-[separator=hover]:bg-[var(--c-accent)]/60 group-data-[separator=active]:bg-[var(--c-accent)] group-data-[separator=focus]:bg-[var(--c-accent)]" />
          </PanelResizeHandle>
        )}

        <Panel {...layout.panelProps} groupResizeBehavior="preserve-pixel-size">
          {inspector(layout.collapseControl)}
        </Panel>
        {layout.expandVisible && (
          <button
            type="button"
            onClick={layout.toggleCollapsed}
            aria-label="Show inspector"
            title="Show inspector"
            data-inspector-expand
            className="absolute right-0 top-1/2 z-[3] flex h-16 w-5 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 p-border p-elevated p-text-3 shadow-sm transition-colors hover:p-text hover:p-accent-subtle focus-visible:outline-2"
          >
            <CaretLeftIcon size={12} weight="bold" />
          </button>
        )}
      </PanelGroup>
    </>
  );
}
