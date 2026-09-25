/** Owns the inspector policy (`useInspectorLayout` over core's `decideInspector`). Below `md` the group is
 *  re-keyed so the library lays out from defaults rather than rescaling. */
import { useEffect, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { needsTheUser, type PersonAsks } from "@kinu.run/core";

import { useInspectorLayout } from "@/hooks/use-inspector-layout";

export interface WorkbenchPanelsProps {
  /** `undefined` for a sample workbench: the policy decides on every mount. */
  readonly workspace: string | undefined;
  readonly scope?: string;
  readonly contents: PersonAsks;
  readonly chat: (inspector: InspectorControl | null) => ReactNode;
  readonly inspector: ReactNode;
  /** Lets the page bring the inspector into view, where a surface it opens would otherwise stay hidden. */
  readonly ref?: Ref<WorkbenchHandle>;
}

export interface WorkbenchHandle {
  /** A collapsed inspector opens; on a phone, the Workspace pane replaces the chat. */
  readonly reveal: () => void;
}

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

export function WorkbenchPanels({ ref, workspace, scope, contents, chat, inspector }: WorkbenchPanelsProps) {
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
  }), [desktopPanels, reveal]);

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
            <span className="flex min-w-4 px-1 h-4 items-center justify-center rounded-full bg-[var(--c-accent)] text-[10px] font-semibold leading-none text-[var(--c-accent-on)]">{waiting}</span>
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
