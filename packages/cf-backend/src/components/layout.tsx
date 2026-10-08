import { detach } from "@kinu.run/core/obs";
import { Effect } from "effect";
import { createContext, useContext, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { GithubLogoIcon, ListIcon, PlusIcon } from "@phosphor-icons/react";
import Sidebar from "./Sidebar";
import { SidebarRail } from "./SidebarRail";
import { FeedbackButton } from "./FeedbackButton";
import { KinuLogo } from "./ui/KinuLogo";
import { composing } from "./ui/form";
import { WorkspaceRosterProvider } from "@/hooks/use-workspace-roster";
import { AgentsNavProvider, useAgentsNav } from "@/hooks/use-agents-nav";
import { AppBackground } from "./AppBackground";

/** The root isolates its stacking so the negative-z canvas paints above its ground and under in-flow children. */

/** Opens the phone's menu drawer, for a page that draws its own top bar; null outside the shell. */
const DrawerContext = createContext<(() => void) | null>(null);

export function useLayoutDrawer(): (() => void) | null {
  return useContext(DrawerContext);
}

export default function Layout() {
  return <AgentsNavProvider><Shell /></AgentsNavProvider>;
}

function Shell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { entries } = useAgentsNav();

  useEffect(() => { setDrawerOpen(false); }, [location]);
  // A workspace's bar carries the menu button itself: one bar on a phone, not two.
  const ownBar = useMatch({ path: "/workspace/:agentId", end: false }) !== null;
  useEffect(() => { if (entries > 0 && !window.matchMedia("(min-width: 768px)").matches) setDrawerOpen(true); }, [entries]);

  // Dismissed as a dialog is: an Escape a field inside it took for itself stays the field's.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !composing(event)) setDrawerOpen(false); };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <WorkspaceRosterProvider>
    <div className="isolate flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      <AppBackground />
      <header className={`h-14 shrink-0 items-center justify-between border-b p-border p-sidebar px-3 md:hidden ${ownBar ? "hidden" : "flex"}`}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
            className="flex size-9 items-center justify-center rounded-md p-text-2 p-card-hover hover:p-text"
          >
            <ListIcon size={18} />
          </button>
          <Link to="/" aria-label="Kinu home" className="flex items-center rounded-md px-2 py-1.5">
            <KinuLogo compact />
          </Link>
        </div>
        <div className="flex items-center gap-1">
          <FeedbackButton compact />
          <a href="https://github.com/AshishKumar4/kinu" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository" className="flex size-9 items-center justify-center rounded-md p-text-2 p-card-hover hover:p-text">
            <GithubLogoIcon size={17} />
          </a>
          <button type="button" onClick={() => detach(Effect.promise(async () => navigate("/")))} aria-label="New workspace" className="flex size-9 items-center justify-center rounded-md p-text-2 p-card-hover hover:p-text">
            <PlusIcon size={16} />
          </button>
        </div>
      </header>

      <SidebarRail />

      {drawerOpen && (
        <div className="fixed inset-0 z-50 animate-fade-in md:hidden">
          <div className="p-scrim absolute inset-0" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <aside data-drawer role="dialog" aria-modal="true" aria-label="Menu" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] p-sidebar border-r p-border p-shadow-overlay">
            <Sidebar />
          </aside>
        </div>
      )}

      <main className="min-h-0 flex-1 min-w-0 overflow-hidden">
        <DrawerContext.Provider value={() => setDrawerOpen(true)}>
          <Outlet />
        </DrawerContext.Provider>
      </main>

    </div>
    </WorkspaceRosterProvider>
  );
}
