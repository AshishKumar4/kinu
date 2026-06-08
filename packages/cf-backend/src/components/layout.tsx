import { Link, Outlet } from "react-router-dom";
import { BrainIcon, GearIcon, PlusIcon } from "@phosphor-icons/react";
import Sidebar from "./Sidebar";

/**
 * Top-level shell — left rail (Sidebar with user info + agent list) +
 * right pane (route outlet). The right pane is per-agent for /agent/*
 * routes and a welcome screen at /, and the user-settings page at
 * /user/settings.
 */
export default function Layout() {
  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      <header className="flex h-14 shrink-0 items-center justify-between border-b p-border p-elevated px-3 md:hidden">
        <Link to="/" className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <BrainIcon size={21} weight="duotone" className="p-accent" />
          <span className="font-medium tracking-tight">Proteus</span>
        </Link>
        <div className="flex items-center gap-1">
          <Link to="/" aria-label="New agent" className="flex size-9 items-center justify-center rounded-md p-text-2 hover:p-card-hover hover:p-text">
            <PlusIcon size={16} />
          </Link>
          <Link to="/user/settings" aria-label="Settings" className="flex size-9 items-center justify-center rounded-md p-text-2 hover:p-card-hover hover:p-text">
            <GearIcon size={16} />
          </Link>
        </div>
      </header>
      <Sidebar />
      <main className="min-h-0 flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
