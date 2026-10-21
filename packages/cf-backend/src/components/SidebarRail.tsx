/**
 * The desktop rail lane: the roster, or the icon rail it folds to. Only the `aside`'s width
 * animates; each state's column has its own width behind `overflow-hidden`, so nothing reflows.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import { useLocation } from "react-router-dom";
import { SidebarSimpleIcon } from "@phosphor-icons/react";

import { useAccount } from "@/hooks/use-account";
import { useAgentsNav } from "@/hooks/use-agents-nav";
import { lastValue } from "@/hooks/use-async-resource";
import { KinuMark } from "./ui/KinuLogo";
import { NewWorkspaceIconButton } from "./workspaces/NewWorkspaceButton";
import Sidebar from "./Sidebar";
import { AccountMenu, FooterIcons } from "./SidebarFooter";
import { Avatar } from "./ui/Avatar";
import { navActive, PRIMARY_NAV } from "./nav";
import { NavRow, NavRowButton } from "@/components/ui/NavRow";
import { Surface } from "@/components/ui/Surface";
import { Pressable } from "@/components/ui/Pressable";

const RAIL_KEY = "kinu:rail-open";

/** Lane width and entering column share 180ms; reduced motion gets the end state at once. */
const LANE_ENTER_CLS = "p-sidebar-lane";

/** `folded` while a view fills the workspace area: the rail folds for it, and is as the reader keeps it after. */
export function SidebarRail({ folded }: { folded: boolean }) {
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== "0");
  const { pathname } = useLocation();
  const profile = lastValue(useAccount().profile);

  const setOpen = (open: boolean) => {
    localStorage.setItem(RAIL_KEY, open ? "1" : "0");
    setRailOpen(open);
  };

  const { entries } = useAgentsNav();

  useEffect(() => {
    setRailOpen(!folded && localStorage.getItem(RAIL_KEY) !== "0");
  }, [folded]);

  useEffect(() => {
    if (entries === 0) return;
    localStorage.setItem(RAIL_KEY, "1");
    setRailOpen(true);
  }, [entries]);

  // Anywhere on the folded lane that is not a control unfolds it.
  const onRailClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("a, button") !== null) return;
    setOpen(true);
  };

  return (
    <Surface look="chrome" as="aside"
      className={`p-sidebar-rail relative hidden shrink-0 overflow-hidden border-r p-border md:block ${railOpen ? "w-60" : "w-14 cursor-pointer"}`}
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
          <NavRowButton size="icon" quiet onClick={() => setOpen(true)} aria-label="Show sidebar" data-rail-expand>
            <SidebarSimpleIcon size={18} />
          </NavRowButton>
          <NavRow size="icon" quiet to="/" aria-label="Kinu home" className="mt-1"><KinuMark size={20} /></NavRow>
          <NewWorkspaceIconButton rail />
          <nav aria-label="Primary" className="flex flex-col items-center gap-1 pt-1">
            {PRIMARY_NAV.map((item) => {
              const open = navActive(item, pathname);

              return (
                <NavRow key={item.to} size="icon" quiet current={open} to={item.to} aria-label={item.label} title={item.label}>
                  <item.Icon size={17} className={open ? "p-accent-mark" : undefined} />
                </NavRow>
              );
            })}
          </nav>
          <div className="mt-auto flex flex-col items-center gap-1 border-t p-border pt-2">
            <FooterIcons vertical />
            <RailAccount name={profile?.displayName ?? profile?.email ?? "?"} />
          </div>
        </div>
      )}
    </Surface>
  );
}

/** The folded rail's account: your initial, opening the same menu as the footer's, beside the rail. */
function RailAccount({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useCloseOnOutsideClick(open, ref, close);

  return (
    <div ref={ref} className="relative">
      <Pressable onClick={() => setOpen((shown) => !shown)} aria-expanded={open} aria-haspopup="menu" aria-label="Account menu" title="Account" data-account-menu
        className="flex size-9 items-center justify-center">
        <Avatar name={name} size={24} />
      </Pressable>
      {open && <AccountMenu onClose={close} className="fixed bottom-3 left-15 w-60" />}
    </div>
  );
}
