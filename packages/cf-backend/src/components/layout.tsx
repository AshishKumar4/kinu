import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";

/**
 * Top-level shell — left rail (Sidebar with user info + agent list) +
 * right pane (route outlet). The right pane is per-agent for /agent/*
 * routes and a welcome screen at /, and the user-settings page at
 * /user/settings.
 */
export default function Layout() {
  return (
    <div className="h-screen w-screen flex p-bg p-text overflow-hidden">
      <Sidebar />
      <main className="flex-1 min-w-0 h-full overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
