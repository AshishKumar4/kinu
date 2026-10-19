import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CaretDownIcon, GearIcon, ShieldCheckIcon, SidebarSimpleIcon, SignOutIcon } from "@phosphor-icons/react";
import { KinuMark } from "./ui/KinuLogo";
import { NewWorkspaceIconButton } from "./workspaces/NewWorkspaceButton";
import { useAccount } from "@/hooks/use-account";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { lastValue } from "@/hooks/use-async-resource";
import { ModeToggle } from "./theme-toggle";
import { FeedbackButton } from "./FeedbackButton";

const MENU_ROW = "flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm p-card-hover";

/**
 * The sidebar's head: the mark and Kinu open the account menu (the account, its settings, the theme, feedback and
 * sign-out); beside them, New workspace and, on the desktop rail, the way to hide the sidebar.
 */
export function SidebarHeader({ onCollapse }: { onCollapse?: () => void }) {
  const account = useAccount();
  const profile = lastValue(account.profile);
  const profileFailed = account.profile.status === "error";
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useCloseOnOutsideClick(open, menuRef, close);

  // Dismissed as a menu is: Escape closes it, and focus goes back to what opened it.
  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setOpen(false);
      menuRef.current?.querySelector<HTMLButtonElement>("[data-account-menu]")?.focus();
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={menuRef} className="relative flex items-center gap-1 pl-2.5 pr-2.5 pt-3.5 pb-2">
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
        aria-label="Account menu"
        data-account-menu
        className="flex min-w-0 items-center gap-2 rounded-lg py-1.5 pl-2 pr-1.5 transition-colors hover:bg-[var(--c-neutral-tint)]"
      >
        <KinuMark size={20} />
        <span className="text-[16px] font-medium p-text">Kinu</span>
        <CaretDownIcon size={12} weight="bold" className={`p-text-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <span className="flex-1" />
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Hide sidebar"
          title="Hide sidebar"
          data-rail-collapse
          className="flex size-8 items-center justify-center rounded-full p-text-3 transition-colors hover:bg-[var(--c-neutral-tint)] hover:p-text"
        >
          <SidebarSimpleIcon size={17} />
        </button>
      )}
      <NewWorkspaceIconButton />
      {open && (
        <div className="absolute top-full left-2 right-2 z-20 p-card p-1.5 p-shadow-menu border p-border" data-account-panel>
          <div className="flex items-center gap-2.5 px-2 pt-1 pb-2 mb-1 border-b p-border">
            <div className="flex size-[26px] shrink-0 items-center justify-center rounded-full p-accent-subtle text-[12px] font-semibold p-accent-mark">
              {profile?.email?.[0]?.toUpperCase() ?? "?"}
            </div>
            <span className="min-w-0 flex-1 truncate p-t-control p-text-3">
              {profile?.email ?? (profileFailed ? "Could not load your profile" : "Loading…")}
            </span>
          </div>
          <Link to="/user/settings" onClick={close} className={MENU_ROW}>
            <GearIcon size={14} />
            <span>Account settings</span>
          </Link>
          {profile?.controlPlane === true && (
            <Link to="/control" onClick={close} className={MENU_ROW}>
              <ShieldCheckIcon size={14} />
              <span>Control plane</span>
            </Link>
          )}
          <ModeToggle />
          <FeedbackButton />
          <a href="/logout" className={MENU_ROW}>
            <SignOutIcon size={14} />
            <span>Sign out</span>
          </a>
        </div>
      )}
    </div>
  );
}
