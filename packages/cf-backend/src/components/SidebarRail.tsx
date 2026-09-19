/**
 * The desktop rail lane: the roster, or the narrow icon rail it folds to.
 *
 * Folded, the lane keeps what a person still reaches from it — the logo, new
 * workspace, the four primary places, the account — as icons; a click on the
 * rail itself (not on one of those) unfolds it. The choice persists beside the
 * theme and section folds in localStorage.
 *
 * One mount owns the lane so every surface that shows the workbench shows the
 * same rail — the app shell around the route outlet, and the landing page's
 * sample frames. Below `md` there is no lane at all: the shell summons the
 * roster as a drawer from its own header.
 */
import { useState, type MouseEvent } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { PlusIcon, SidebarSimpleIcon } from "@phosphor-icons/react";

import { useAccount } from "@/hooks/use-account";
import { lastValue } from "@/hooks/use-async-resource";
import { KinuMark } from "./ui/KinuLogo";
import Sidebar from "./Sidebar";
import { PRIMARY_NAV } from "./nav";

const RAIL_KEY = "kinu:rail-open";

const RAIL_ICON_CLS = "flex size-9 items-center justify-center rounded-lg p-text-3 transition-colors hover:bg-[var(--c-elevated)] hover:p-text";

export function SidebarRail() {
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== "0");
  const navigate = useNavigate();
  const profile = lastValue(useAccount().profile);

  const setOpen = (open: boolean) => {
    localStorage.setItem(RAIL_KEY, open ? "1" : "0");
    setRailOpen(open);
  };

  if (!railOpen) {
    // Anywhere on the rail that is not a control unfolds it.
    const onRailClick = (event: MouseEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest("a, button") !== null) return;
      setOpen(true);
    };

    return (
      <aside
        className="hidden w-14 shrink-0 cursor-pointer flex-col items-center gap-1 p-sidebar-veil border-r p-border py-3 md:flex"
        data-rail-collapsed
        onClick={onRailClick}
        title="Show sidebar"
      >
        <button type="button" onClick={() => setOpen(true)} aria-label="Show sidebar" data-rail-expand className={RAIL_ICON_CLS}>
          <SidebarSimpleIcon size={18} />
        </button>
        <Link to="/" aria-label="Kinu home" className={`${RAIL_ICON_CLS} mt-1`}><KinuMark size={20} /></Link>
        <button type="button" onClick={() => navigate("/")} aria-label="New workspace" title="New workspace" className={RAIL_ICON_CLS}>
          <PlusIcon size={17} weight="bold" />
        </button>
        <nav aria-label="Primary" className="flex flex-col items-center gap-1 pt-1">
          {PRIMARY_NAV.map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end} aria-label={label} title={label}
              className={({ isActive }) => `${RAIL_ICON_CLS} ${isActive ? "bg-[var(--c-elevated)] p-accent" : ""}`}>
              <Icon size={17} />
            </NavLink>
          ))}
        </nav>
        <Link to="/user/settings" aria-label="Account settings" title="Account settings" className="mt-auto flex size-[26px] items-center justify-center rounded-full bg-[#2A2018] text-[12px] font-semibold text-[var(--c-accent)]">
          {profile?.email?.[0]?.toUpperCase() ?? "?"}
        </Link>
      </aside>
    );
  }

  return (
    <aside className="relative hidden w-60 shrink-0 p-sidebar-veil border-r p-border md:block" data-rail>
      <Sidebar onCollapse={() => setOpen(false)} />
    </aside>
  );
}
