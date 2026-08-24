import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { GithubLogoIcon, ListIcon, PlusIcon } from "@phosphor-icons/react";
import Sidebar from "./Sidebar";
import { FeedbackButton } from "./FeedbackButton";
import { KinuLogo } from "./ui/KinuLogo";
import { WorkspaceRosterProvider } from "@/hooks/use-workspace-roster";

/**
 * Top-level shell — left rail (Sidebar with user info + agent list) +
 * right pane (route outlet). Below md the rail becomes a drawer summoned
 * from the mobile header, so phones get the same roster, New-agent flow,
 * theme toggle and sign-out as desktop.
 */
export default function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Any navigation (agent link, settings, new-agent create) closes the drawer.
  useEffect(() => { setDrawerOpen(false); }, [location]);

  return (
    <WorkspaceRosterProvider>
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      <header className="flex h-14 shrink-0 items-center justify-between border-b p-border p-sidebar px-3 md:hidden">
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
          <button type="button" onClick={() => navigate("/")} aria-label="New workspace" className="flex size-9 items-center justify-center rounded-md p-text-2 p-card-hover hover:p-text">
            <PlusIcon size={16} />
          </button>
        </div>
      </header>

      {/* Desktop rail */}
      <aside className="hidden w-60 shrink-0 h-full p-sidebar border-r p-border md:block">
        <Sidebar />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 animate-fade-in md:hidden">
          <div className="p-scrim absolute inset-0" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] p-sidebar border-r p-border p-shadow-overlay">
            <Sidebar />
          </aside>
        </div>
      )}

      <main className="min-h-0 flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </main>

    </div>
    </WorkspaceRosterProvider>
  );
}
