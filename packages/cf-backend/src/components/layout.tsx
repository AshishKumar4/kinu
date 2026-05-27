import { useState, useCallback, useEffect } from "react";
import { Outlet, NavLink, useLocation, useParams } from "react-router-dom";
import { PoweredByCloudflare } from "@cloudflare/kumo";
import {
  BrainIcon, SquaresFourIcon, SidebarSimpleIcon,
  ChatTextIcon, GearSixIcon, TreeStructureIcon,
} from "@phosphor-icons/react";
import { ModeToggle } from "./mode-toggle";

export default function Layout() {
  const location = useLocation();

  // Extract agentId from URL if we're on an agent page
  const agentMatch = location.pathname.match(/\/(agent|mcts|settings)\/([^/]+)/);
  const agentId = agentMatch?.[2];

  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem("proteus:sidebar");
    return saved ? saved === "true" : !!agentId;
  });

  const toggle = useCallback(() => {
    setCollapsed(p => { const next = !p; localStorage.setItem("proteus:sidebar", String(next)); return next; });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <div className="flex h-screen p-bg p-text">
      <aside
        className={`flex flex-col border-r transition-[width] duration-200 ease-out ${collapsed ? "w-[52px]" : "w-[200px]"}`}
        style={{ background: "var(--c-sidebar)", borderColor: "var(--c-border)" }}
      >
        {/* Brand */}
        <div className={`flex items-center h-[52px] shrink-0 ${collapsed ? "justify-center" : "px-4 gap-2.5"}`}>
          <button
            onClick={toggle}
            className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
            title={collapsed ? "Expand sidebar (Cmd+B)" : ""}
          >
            <BrainIcon size={collapsed ? 22 : 20} weight="duotone" className="p-accent shrink-0" />
            {!collapsed && <span className="text-sm font-semibold tracking-tight p-text whitespace-nowrap">Proteus</span>}
          </button>
          {!collapsed && (
            <button onClick={toggle} className="ml-auto p-text-3 hover:p-text transition-colors" title="Collapse (Cmd+B)">
              <SidebarSimpleIcon size={14} />
            </button>
          )}
        </div>

        {/* Separator */}
        <div className="mx-3 border-t" style={{ borderColor: "var(--c-border)" }} />

        {/* Navigation */}
        <nav className={`flex-1 py-2 space-y-0.5 ${collapsed ? "px-1.5" : "px-2"}`}>
          {/* Global: Agents list */}
          <SidebarLink to="/" end icon={SquaresFourIcon} label="Agents" collapsed={collapsed} />

          {/* Agent-specific nav — only when viewing an agent */}
          {agentId && (
            <>
              {!collapsed && (
                <div className="pt-3 pb-1 px-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider p-text-3">Agent</span>
                </div>
              )}
              {collapsed && <div className="my-1.5 mx-1 border-t" style={{ borderColor: "var(--c-border)" }} />}
              <SidebarLink to={`/agent/${agentId}`} icon={ChatTextIcon} label="Chat" collapsed={collapsed} />
              <SidebarLink to={`/mcts/${agentId}`} icon={TreeStructureIcon} label="MCTS" collapsed={collapsed} />
              <SidebarLink to={`/settings/${agentId}`} icon={GearSixIcon} label="Settings" collapsed={collapsed} />
            </>
          )}
        </nav>

        {/* Footer */}
        <div
          className={`shrink-0 py-2.5 border-t ${collapsed ? "px-1.5 flex flex-col items-center gap-1.5" : "px-3 space-y-2"}`}
          style={{ borderColor: "var(--c-border)" }}
        >
          <div className={collapsed ? "" : "flex items-center justify-between"}>
            <ModeToggle />
            {!collapsed && <span className="text-[10px] p-text-3 font-mono select-none">v0.1</span>}
          </div>
          {!collapsed && (
            <div className="flex justify-center opacity-50 hover:opacity-80 transition-opacity">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-hidden p-bg">
        <Outlet />
      </main>
    </div>
  );
}

/* Reusable nav link with tooltip on collapsed state */
function SidebarLink({ to, icon: Icon, label, collapsed, end }: {
  to: string; icon: React.ComponentType<{ size: number; weight?: string; className?: string }>;
  label: string; collapsed: boolean; end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? label : undefined}
      className={({ isActive }) => {
        const base = "flex items-center rounded-md transition-colors text-[13px] relative";
        const layout = collapsed ? "justify-center p-2" : "gap-2.5 px-2.5 py-[7px]";
        const state = isActive
          ? "p-nav-active font-medium"
          : "p-text-2 hover:p-text hover:bg-[var(--c-surface)]";
        return `${base} ${layout} ${state}`;
      }}
    >
      <Icon size={collapsed ? 18 : 15} weight="bold" className="shrink-0" />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}
