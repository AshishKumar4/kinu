import { Link } from "react-router-dom";
import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";
import { KinuMark } from "./ui/KinuLogo";
import { NewWorkspaceIconButton } from "./workspaces/NewWorkspaceButton";

/**
 * The sidebar's head: the mark and Kinu, which go Home; beside them, New workspace and, on the desktop rail, the way to
 * hide the sidebar. The account and its menu are the footer's (`SidebarFooter`).
 */
export function SidebarHeader({ onCollapse }: { onCollapse?: () => void }) {
  return (
    <div className="relative flex items-center gap-1 pl-2.5 pr-2.5 pt-3.5 pb-2">
      <Link to={APP_ROUTES.home} aria-label="Kinu home" data-sidebar-home
        className="flex min-w-0 items-center gap-2 rounded-lg py-1.5 pl-2 pr-2 transition-colors hover:bg-[var(--c-hover)]">
        <KinuMark size={20} />
        <span className="text-[16px] font-medium p-text">Kinu</span>
      </Link>
      <span className="flex-1" />
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Hide sidebar"
          title="Hide sidebar"
          data-rail-collapse
          className="flex size-8 items-center justify-center rounded-full p-text-3 transition-colors hover:bg-[var(--c-hover)] hover:p-text"
        >
          <SidebarSimpleIcon size={17} />
        </button>
      )}
      <NewWorkspaceIconButton />
    </div>
  );
}
