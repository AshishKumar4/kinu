/** Owns the inspector policy (`useInspectorLayout` over core's `decideInspector`). Below `md` the group is
 *  re-keyed so the library lays out from defaults rather than rescaling. */
import { useEffect, useImperativeHandle, useMemo, useState, type ReactNode, type Ref } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { needsTheUser, type PersonAsks } from "@kinu.run/core";

import { useInspectorLayout } from "@/hooks/use-inspector-layout";

export interface WorkbenchPanelsProps {
  /** `undefined` for a sample workbench: the policy decides on every mount. */
  readonly workspace: string | undefined;
  readonly scope?: string;
  readonly contents: PersonAsks;
  readonly chat: (inspector: InspectorControl) => ReactNode;
  readonly inspector: ReactNode;
  /** The bar above draws the toggle: on a phone it switches the one pane shown. */
  readonly onInspector?: (control: InspectorControl | null) => void;
  /** Brings the inspector into view for a surface it opens. */
  readonly ref?: Ref<WorkbenchHandle>;
}

export interface WorkbenchHandle {
  readonly reveal: () => void;
  readonly showChat: () => void;
}

export interface InspectorControl {
  readonly collapsed: boolean;
  readonly toggle: () => void;
  readonly beside: boolean;
  readonly waiting: number;
}

/** Shows or hides the inspector; on a phone, swaps the chat for the workspace. */
function toggleLabel({ collapsed, beside }: InspectorControl): string {
  if (beside) return collapsed ? "Show inspector" : "Hide inspector";

  return collapsed ? "Show workspace" : "Show chat";
}

export function InspectorToggle({ control }: { control: InspectorControl }) {
  return (
    <button
      type="button"
      onClick={control.toggle}
      aria-label={toggleLabel(control)}
      title={toggleLabel(control)}
      aria-pressed={!control.collapsed}
      data-inspector-toggle
      {...(control.collapsed ? { "data-inspector-expand": "" } : { "data-inspector-collapse": "" })}
      className="p-bar-icon relative"
    >
      <SidebarSimpleIcon size={16} style={{ transform: "scaleX(-1)" }} />
      {control.waiting > 0 && control.collapsed && <span className="p-bar-icon-dot" aria-hidden />}
    </button>
  );
}

export function WorkbenchPanels({ ref, workspace, scope, contents, chat, inspector, onInspector }: WorkbenchPanelsProps) {
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

  const layout = useInspectorLayout({
    desktopPanels,
    workspace,
    scope,
    mobileDefault: mobilePane === "workspace" ? "100%" : "0%",
    needsUser: needsTheUser(contents),
  });

  const { reveal } = layout;

  useImperativeHandle(ref, () => ({
    reveal: () => {
      if (desktopPanels) reveal();
      else setMobilePane("workspace");
    },
    showChat: () => { setMobilePane("chat"); },
  }), [desktopPanels, reveal]);

  const waiting = contents.pendingActions.length;

  const control = useMemo<InspectorControl>(() => (desktopPanels
    ? { collapsed: layout.collapsed, toggle: layout.toggleCollapsed, beside: true, waiting }
    : { collapsed: mobilePane === "chat", toggle: () => setMobilePane((pane) => (pane === "chat" ? "workspace" : "chat")), beside: false, waiting }),
  [desktopPanels, layout.collapsed, layout.toggleCollapsed, mobilePane, waiting]);

  useEffect(() => {
    onInspector?.(control);
  }, [onInspector, control]);

  useEffect(() => () => onInspector?.(null), [onInspector]);

  return (
    <>
      <PanelGroup key={desktopPanels ? "desktop" : mobilePane} className="relative flex-1" resizeTargetMinimumSize={{ coarse: 20, fine: 10 }} {...layout.groupProps}>
        <Panel
          id={layout.chatPanelId}
          {...(desktopPanels
            ? { minSize: "24%" }
            : { minSize: "0%", defaultSize: mobilePane === "chat" ? "100%" : "0%" })}
          groupResizeBehavior="preserve-relative-size"
        >
          <div className="flex flex-col h-full border-r p-border">
            {chat(control)}
          </div>
        </Panel>

        {/* No width of its own: a gap broke the rule under the strips. */}
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
            className="group z-[2] -ml-[5px] -mr-[8px] w-[13px] shrink-0 cursor-col-resize bg-transparent touch-none select-none focus:outline-none"
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
