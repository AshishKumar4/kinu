import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useMatch } from "react-router-dom";
import { ListIcon } from "@phosphor-icons/react";
import Sidebar from "./Sidebar";
import { SidebarRail } from "./SidebarRail";
import { FeedbackButton } from "./FeedbackButton";
import { KinuLogo } from "./ui/KinuLogo";
import { NewWorkspaceIconButton } from "./workspaces/NewWorkspaceButton";
import { composing } from "./ui/form";
import { WorkspaceRosterProvider } from "@/hooks/use-workspace-roster";
import { OwnerAlerts } from "@/hooks/use-owner-alerts";
import { AgentsNavProvider, useAgentsNav } from "@/hooks/use-agents-nav";
import { DESKTOP_QUERY } from "@/hooks/use-media-query";
import { AppBackground } from "./AppBackground";
import { Button } from "@/components/ui/Button";
import { Surface } from "@/components/ui/Surface";

/** The root isolates its stacking so the negative-z canvas paints above its ground and under in-flow children. */

/** Opens the phone's menu drawer, for a page that draws its own top bar; null outside the shell. */
const DrawerContext = createContext<(() => void) | null>(null);

export function useLayoutDrawer(): (() => void) | null {
  return useContext(DrawerContext);
}

/** The workspace area, for a view that fills it: the element it covers, and the rail's fold while it does. */
export interface WorkspaceArea {
  readonly main: HTMLElement | null;
  readonly fill: (filling: boolean) => void;
  /** A workspace shown where its route is not (Home, the assistant's): it draws the phone's bar itself. */
  readonly ownBar: (own: boolean) => void;
}

const WorkspaceAreaContext = createContext<WorkspaceArea | null>(null);

/** Null outside the shell, where there is no area to fill. */
export function useWorkspaceArea(): WorkspaceArea | null {
  return useContext(WorkspaceAreaContext);
}

export default function Layout() {
  return <AgentsNavProvider><Shell /></AgentsNavProvider>;
}

function Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const { entries } = useAgentsNav();
  const [main, setMain] = useState<HTMLElement | null>(null);
  const [filling, setFilling] = useState(false);
  const [drawsBar, setDrawsBar] = useState(false);
  const area = useMemo(() => ({ main, fill: setFilling, ownBar: setDrawsBar }), [main]);

  useEffect(() => { setDrawerOpen(false); }, [location]);
  // A workspace's bar carries the menu button itself: one bar on a phone, not two.
  const ownBar = useMatch({ path: "/workspace/:agentId", end: false }) !== null || drawsBar;
  useEffect(() => { if (entries > 0 && !window.matchMedia(DESKTOP_QUERY).matches) setDrawerOpen(true); }, [entries]);

  // Dismissed as a dialog is: an Escape a field inside it took for itself stays the field's.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !composing(event)) setDrawerOpen(false); };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <WorkspaceRosterProvider>
    <OwnerAlerts />
    <Surface look="page" className="isolate flex h-screen w-screen flex-col p-text overflow-hidden md:flex-row">
      <AppBackground />
      <header className={`h-14 shrink-0 items-center justify-between border-b p-border p-sidebar px-3 md:hidden ${ownBar ? "hidden" : "flex"}`}>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" icon={<ListIcon size={14} />} aria-label="Open menu" onClick={() => setDrawerOpen(true)} />
          <Link to="/" aria-label="Kinu home" className="flex items-center px-2 py-1">
            <KinuLogo compact />
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <FeedbackButton compact />
          <NewWorkspaceIconButton className="size-9" />
        </div>
      </header>

      <SidebarRail folded={filling} />

      {drawerOpen && (
        <div className="fixed inset-0 z-50 animate-fade-in md:hidden">
          <div className="p-scrim absolute inset-0" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <Surface look="chrome" as="aside" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r p-border p-shadow-overlay" data-drawer role="dialog" aria-modal="true" aria-label="Menu">
            <Sidebar />
          </Surface>
        </div>
      )}

      <main ref={setMain} className="min-h-0 flex-1 min-w-0 overflow-hidden">
        <DrawerContext.Provider value={() => setDrawerOpen(true)}>
          <WorkspaceAreaContext.Provider value={area}>
            <Outlet />
          </WorkspaceAreaContext.Provider>
        </DrawerContext.Provider>
      </main>

    </Surface>
    </WorkspaceRosterProvider>
  );
}
