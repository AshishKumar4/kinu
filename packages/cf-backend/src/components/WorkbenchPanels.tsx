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
import { SidebarSimpleIcon } from "@phosphor-icons/react";
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
  /** The conversation column's body, under its own tab strip. Handed the
   *  inspector's one control (absent on a phone pane, where the switch above
   *  the panes is the control) so its strip can carry the toggle. */
  readonly chat: (inspector: InspectorControl | null) => ReactNode;
  /** The inspector column's body. */
  readonly inspector: ReactNode;
}

/** Show or hide the inspector column: one control, in the chat's own strip. */
export interface InspectorControl {
  readonly collapsed: boolean;
  readonly toggle: () => void;
}

export function InspectorToggle({ control }: { control: InspectorControl }) {
  return (
    <button
      type="button"
      onClick={control.toggle}
      aria-label={control.collapsed ? "Show inspector" : "Hide inspector"}
      title={control.collapsed ? "Show inspector" : "Hide inspector"}
      aria-pressed={!control.collapsed}
      data-inspector-toggle
      {...(control.collapsed ? { "data-inspector-expand": "" } : { "data-inspector-collapse": "" })}
      className={`flex size-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--c-elevated)] ${control.collapsed ? "p-text-3 hover:p-text" : "p-text-2"}`}
    >
      <SidebarSimpleIcon size={16} style={{ transform: "scaleX(-1)" }} />
    </button>
  );
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
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ${mobilePane === "workspace" ? "p-accent-subtle p-accent" : "p-text-3"}`}>
          Workspace
          {waiting > 0 && (
            /* The count is a badge on the tab — a number on its own ground —
               not a `· N` suffix mid-word. */
            <span className="flex size-4 items-center justify-center rounded-full bg-[var(--c-accent)] text-[10px] font-semibold leading-none text-[var(--c-accent-on)]">{waiting}</span>
          )}
        </button>
      </div>
      <PanelGroup key={desktopPanels ? "desktop" : mobilePane} className="relative flex-1" resizeTargetMinimumSize={{ coarse: 20, fine: 10 }} {...layout.groupProps}>
        <Panel
          id={layout.chatPanelId}
          {...(desktopPanels
            ? { minSize: "24%" }
            : { minSize: "0%", defaultSize: mobilePane === "chat" ? "100%" : "0%" })}
          groupResizeBehavior="preserve-relative-size"
        >
          <div className="flex flex-col h-full border-r p-border">
            {chat(desktopPanels ? { collapsed: layout.collapsed, toggle: layout.toggleCollapsed } : null)}
          </div>
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
          {inspector}
        </Panel>
      </PanelGroup>
    </>
  );
}
