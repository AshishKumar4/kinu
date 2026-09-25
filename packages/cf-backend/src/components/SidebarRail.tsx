/**
 * The desktop rail lane: the roster, or the icon rail it folds to. Only the `aside`'s width
 * animates; each state's column has its own width behind `overflow-hidden`, so nothing reflows.
 */
import { useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { PlusIcon, SidebarSimpleIcon } from "@phosphor-icons/react";

import { useAccount } from "@/hooks/use-account";
import { lastValue } from "@/hooks/use-async-resource";
import { KinuMark } from "./ui/KinuLogo";
import Sidebar from "./Sidebar";
import { navActive, NAV_HOVER, navRowCls, PRIMARY_NAV } from "./nav";

const RAIL_KEY = "kinu:rail-open";

const RAIL_ICON_CLS = "flex size-9 items-center justify-center rounded-lg transition-colors";

const RAIL_BUTTON_CLS = `${RAIL_ICON_CLS} p-text-3 ${NAV_HOVER}`;

/** Lane width and entering column share 180ms; reduced motion gets the end state at once. */
const LANE_ENTER_CLS = "motion-safe:animate-[fade-in_180ms_ease-out]";

export function SidebarRail() {
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== "0");
  const navigate = useNavigate();
  const { pathname } = useLocation();
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
        // The key restarts the enter animation on each fold.
        <div key="roster" className={`h-full w-60 ${LANE_ENTER_CLS}`}>
          <Sidebar onCollapse={() => setOpen(false)} />
        </div>
      ) : (
        <div key="icons" className={`flex h-full w-14 flex-col items-center gap-1 py-3 ${LANE_ENTER_CLS}`}>
          <button type="button" onClick={() => setOpen(true)} aria-label="Show sidebar" data-rail-expand className={RAIL_BUTTON_CLS}>
            <SidebarSimpleIcon size={18} />
          </button>
          <Link to="/" aria-label="Kinu home" className={`${RAIL_BUTTON_CLS} mt-1`}><KinuMark size={20} /></Link>
          <button type="button" onClick={() => navigate("/")} aria-label="New workspace" title="New workspace" className={RAIL_BUTTON_CLS}>
            <PlusIcon size={17} weight="bold" />
          </button>
          <nav aria-label="Primary" className="flex flex-col items-center gap-1 pt-1">
            {PRIMARY_NAV.map((item) => {
              const open = navActive(item, pathname);

              return (
                <Link key={item.to} to={item.to} aria-label={item.label} title={item.label} aria-current={open ? "page" : undefined}
                  className={`${RAIL_ICON_CLS} ${navRowCls(open, "p-text-3")}`}>
                  <item.Icon size={17} />
                </Link>
              );
            })}
          </nav>
          <Link to="/user/settings" aria-label="Account settings" title="Account settings" className="mt-auto flex size-[26px] items-center justify-center rounded-full bg-[#2A2018] text-[12px] font-semibold text-[var(--c-accent)]">
            {profile?.email?.[0]?.toUpperCase() ?? "?"}
          </Link>
        </div>
      )}
    </aside>
  );
}
