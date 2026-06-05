/**
 * Left sidebar — ChatGPT/Codex-style.
 *
 *   ┌─────────────────┐
 *   │ ◉  Proteus      │
 *   │ + New agent     │
 *   │ ─── Agents ───  │
 *   │ ● refactor-X    │
 *   │ ○ exploration   │
 *   │ ...             │
 *   │ ─────────────── │
 *   │ 👤 user.email   │
 *   │   ⚙ Settings    │
 *   │   ⎋ Sign out    │
 *   └─────────────────┘
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { BrainIcon, PlusIcon, GearIcon, TrashIcon, SignOutIcon, CaretRightIcon } from "@phosphor-icons/react";
import { listAgents, removeAgent, getProfile, type AgentEntry, type UserProfile } from "../lib/user-api";
import { CreateAgentModal } from "./CreateAgentModal";

export default function Sidebar() {
  const { agentId } = useParams();
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const refreshAgents = useCallback(async () => {
    try { setAgents(await listAgents()); }
    catch (err) { console.warn('[sidebar] listAgents:', (err as Error).message); }
  }, []);

  useEffect(() => {
    refreshAgents();
    getProfile().then(setProfile).catch(() => {});
  }, [refreshAgents]);

  // Re-sync when route changes (so a freshly-created agent appears).
  useEffect(() => { refreshAgents(); }, [agentId, refreshAgents]);

  // Re-sync when the active agent AI-renames itself after its first turn.
  useEffect(() => {
    const h = () => refreshAgents();
    window.addEventListener("proteus:agent-renamed", h);
    return () => window.removeEventListener("proteus:agent-renamed", h);
  }, [refreshAgents]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setShowUserMenu(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`Remove agent "${name}" from your list? (The agent's data is retained server-side.)`)) return;
    try { await removeAgent(name); await refreshAgents(); }
    catch (err) { alert(`Could not remove: ${(err as Error).message}`); }
  }, [refreshAgents]);

  return (
    <aside className="w-64 shrink-0 h-full flex flex-col p-elevated border-r p-border">
      {/* Logo + new agent */}
      <div className="px-3 pt-4 pb-2 flex flex-col gap-2">
        <Link to="/" className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:p-card transition-colors">
          <BrainIcon size={22} weight="duotone" className="p-accent" />
          <span className="font-medium tracking-tight">Proteus</span>
        </Link>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg p-card hover:p-card-hover transition-colors text-sm cursor-pointer"
        >
          <PlusIcon size={14} />
          <span>New agent</span>
        </button>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-3">
        <div className="text-[10px] font-medium p-text-3 uppercase tracking-wider px-2 pb-1">Agents</div>
        {agents.length === 0 && (
          <div className="px-2 py-3 text-xs p-text-3">No agents yet. Click "New agent" to start.</div>
        )}
        <ul className="space-y-0.5">
          {agents.map((a) => (
            <li key={a.name}>
              <NavLink
                to={`/agent/${a.name}`}
                className={({ isActive }) =>
                  `flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-sm group ${
                    isActive ? 'p-card font-medium' : 'hover:p-card-hover p-text'
                  }`
                }
              >
                <span className="truncate">{a.displayName || a.name}</span>
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDelete(a.name); }}
                  className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-text-3 hover:p-danger transition-all p-1"
                  title="Remove"
                ><TrashIcon size={12} /></button>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      {/* User dropdown — pinned to bottom */}
      <div className="px-2 py-2 border-t p-border relative" ref={userMenuRef}>
        <button
          onClick={() => setShowUserMenu((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-2 py-2 rounded-lg hover:p-card transition-colors text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full p-accent-bg flex items-center justify-center text-xs font-medium p-accent shrink-0">
              {profile?.email?.[0]?.toUpperCase() ?? '?'}
            </div>
            <span className="text-xs p-text truncate">{profile?.email ?? 'loading...'}</span>
          </div>
          <CaretRightIcon size={12} className={`transition-transform p-text-3 ${showUserMenu ? 'rotate-90' : ''}`} />
        </button>
        {showUserMenu && (
          <div className="absolute bottom-full left-2 right-2 mb-1 p-card rounded-lg p-1.5 shadow-lg border p-border">
            <Link to="/user/settings" onClick={() => setShowUserMenu(false)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:p-card-hover">
              <GearIcon size={14} />
              <span>Settings</span>
            </Link>
            <a
              href="/logout"
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:p-card-hover"
            >
              <SignOutIcon size={14} />
              <span>Sign out</span>
            </a>
          </div>
        )}
      </div>

      {showCreate && <CreateAgentModal onClose={() => setShowCreate(false)} />}
    </aside>
  );
}
