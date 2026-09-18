import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { CaretLeftIcon, CaretRightIcon, GithubLogoIcon, ListIcon, PlusIcon } from "@phosphor-icons/react";
import Sidebar from "./Sidebar";
import { FeedbackButton } from "./FeedbackButton";
import { KinuLogo } from "./ui/KinuLogo";
import { WorkspaceRosterProvider } from "@/hooks/use-workspace-roster";
import { WorkspaceOverviewsProvider } from "@/hooks/use-workspace-overviews";
import { AppBackground } from "./AppBackground";

/**
 * Top-level shell — left rail (Sidebar with user info + agent list) +
 * right pane (route outlet). Below md the rail becomes a drawer summoned
 * from the mobile header, so phones get the same roster, New-agent flow,
 * theme toggle and sign-out as desktop.
 *
 * The living background sits behind both, fixed, under the root's own
 * ground: the root isolates its stacking so the negative-z canvas paints
 * above that ground and under every in-flow child. The desktop rail wears
 * the veil rather than the solid sidebar tone so the tissue shows through
 * it faintly; the page's own surfaces stay as they are.
 */
/** The rail's own open/close choice, beside the theme and section folds in
 *  localStorage — the same shelf the inspector's choice sits on, read once at
 *  mount and written only on toggle. */
const RAIL_KEY = "kinu:rail-open";

export default function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_KEY) !== "0");
  const navigate = useNavigate();
  const location = useLocation();

  // Any navigation (agent link, settings, new-agent create) closes the drawer.
  useEffect(() => { setDrawerOpen(false); }, [location]);

  return (
    <WorkspaceRosterProvider>
    <WorkspaceOverviewsProvider>
    <div className="isolate flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      <AppBackground />
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

      {/* Desktop rail — collapsible, with the reopen handle riding the main
          edge the way the inspector's does, in the rail's own veil. */}
      {railOpen ? (
      <aside className="hidden w-60 shrink-0 p-sidebar-veil border-r p-border md:block relative">
        <Sidebar />
        <button
          type="button"
          onClick={() => { localStorage.setItem(RAIL_KEY, "0"); setRailOpen(false); }}
          aria-label="Hide sidebar"
          title="Hide sidebar"
          data-rail-collapse
          className="absolute right-1 top-1/2 z-[3] hidden h-16 w-5 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 p-border p-elevated p-text-3 shadow-sm transition-colors hover:p-text md:flex"
        >
          <CaretLeftIcon size={12} weight="bold" />
        </button>
      </aside>
      ) : (
      <div className="relative hidden shrink-0 md:block" data-rail-collapsed>
        <button
          type="button"
          onClick={() => { localStorage.setItem(RAIL_KEY, "1"); setRailOpen(true); }}
          aria-label="Show sidebar"
          title="Show sidebar"
          data-rail-expand
          className="absolute left-0 top-1/2 z-[3] flex h-16 w-5 -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 p-border p-sidebar-veil p-text-3 shadow-sm transition-colors hover:p-text"
        >
          <CaretRightIcon size={12} weight="bold" />
        </button>
      </div>
      )}

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
    </WorkspaceOverviewsProvider>
    </WorkspaceRosterProvider>
  );
}
