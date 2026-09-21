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
 *
 * The fold is animated on one element: the `aside` keeps its identity across
 * the two states and only its width moves, while each state's column holds a
 * width of its own behind `overflow-hidden`. The column thus never reflows as
 * the lane travels, and the page beside it moves one time, not two.
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

/** The lane's width and the column that enters after it settle over the same
 *  180ms, so the fold reads as one movement. A reader who asked for less
 *  motion gets the end state at once: `fade-in` is behind `motion-safe`, and
 *  the width is pinned by `motion-reduce:transition-none`. */
const LANE_ENTER_CLS = "motion-safe:animate-[fade-in_180ms_ease-out]";

export function SidebarRail() {
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== "0");
  const navigate = useNavigate();
  const profile = lastValue(useAccount().profile);

  const setOpen = (open: boolean) => {
    localStorage.setItem(RAIL_KEY, open ? "1" : "0");
    setRailOpen(open);
  };

  // Anywhere on the folded lane that is not a control unfolds it.
  const onRailClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("a, button") !== null) return;
    setOpen(true);
  };

  return (
    <aside
      className={`relative hidden shrink-0 overflow-hidden p-sidebar-veil border-r p-border transition-[width] duration-[180ms] ease-out motion-reduce:transition-none md:block ${railOpen ? "w-60" : "w-14 cursor-pointer"}`}
      data-rail={railOpen ? "" : undefined}
      data-rail-collapsed={railOpen ? undefined : ""}
      onClick={railOpen ? undefined : onRailClick}
      title={railOpen ? undefined : "Show sidebar"}
    >
      {railOpen ? (
        // The key is the point: a fresh node each fold restarts the enter.
        <div key="roster" className={`h-full w-60 ${LANE_ENTER_CLS}`}>
          <Sidebar onCollapse={() => setOpen(false)} />
        </div>
      ) : (
        <div key="icons" className={`flex h-full w-14 flex-col items-center gap-1 py-3 ${LANE_ENTER_CLS}`}>
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
        </div>
      )}
    </aside>
  );
}
